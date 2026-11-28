import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { apply } from "../lib/index.js";

/** Collect every route apply() registers, keyed by path. */
function mount() {
  const routes = new Map();
  let trusted = true;
  // Workspaces this fake host has opened. Tests fill it in with `trust()`;
  // empty means "this host cannot enumerate roots" and the gate stays open.
  const roots = [];
  const ctx = {
    get: (name) => {
      if (name === "connection") {
        return { requestRejection: () => (trusted ? undefined : 403) };
      }
      if (name === "sessions") {
        return { list: () => roots.map((cwd) => ({ cwd })) };
      }
      return undefined;
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === "function") dispose(); }; },
    inject: (names, fn) => { if (names.indexOf("webServer") >= 0) fn(webCtx); },
    on: () => () => {}
  };
  const webCtx = {
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === "function") dispose(); }; },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      }
    }
  };
  apply(ctx);
  const post = async (path, body) => {
    const handler = routes.get(path);
    assert.ok(handler !== undefined, "no route for " + path);
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const req = Readable.from([Buffer.from(raw)]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    const res = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(text) { this.body = text === undefined ? "" : String(text); }
    };
    await handler(req, res);
    let data = null;
    try { data = JSON.parse(res.body); } catch {}
    return { status: res.status, data };
  };
  return {
    routes,
    post,
    setTrusted: (value) => { trusted = value; },
    trust: (...dirs) => { roots.length = 0; roots.push(...dirs); }
  };
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "dsh-idea-routes-"));
}

test("the copy and move routes answer with the landed path", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "a.txt"), "one");
    await mkdir(join(root, "dst"));
    const api = mount();
    const copied = await api.post("/plugins/dsh-idea/copy", { cwd: root, rel: "a.txt", dir: "dst" });
    assert.equal(copied.status, 200);
    assert.equal(copied.data.rel, "dst/a.txt");
    const moved = await api.post("/plugins/dsh-idea/move", { cwd: root, rel: "dst/a.txt", dir: "" });
    assert.equal(moved.status, 422);
    assert.equal(moved.data.error, "exists");

    await writeFile(join(root, "b.txt"), "two");
    const back = await api.post("/plugins/dsh-idea/move", { cwd: root, rel: "b.txt", dir: "dst" });
    assert.equal(back.status, 200);
    assert.equal(back.data.rel, "dst/b.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the import route writes base64 bytes and makes folders", async () => {
  const root = await workspace();
  try {
    const api = mount();
    const payload = { cwd: root, dir: "", rel: "keep/deep/a.bin", data: Buffer.from([0, 1, 2, 250]).toString("base64") };
    const written = await api.post("/plugins/dsh-idea/import", payload);
    assert.equal(written.status, 200);
    assert.equal(written.data.rel, "keep/deep/a.bin");
    assert.deepEqual([...await readFile(join(root, "keep", "deep", "a.bin"))], [0, 1, 2, 250]);

    const folder = await api.post("/plugins/dsh-idea/import", { cwd: root, dir: "", rel: "empty", isDir: true });
    assert.equal(folder.status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routes refuse an untrusted peer and a bad body", async () => {
  const api = mount();
  api.setTrusted(false);
  assert.equal((await api.post("/plugins/dsh-idea/copy", {})).status, 403);
  api.setTrusted(true);
  const bad = await api.post("/plugins/dsh-idea/copy", "not json");
  assert.equal(bad.status, 400);
});

test("a secret destination is refused", async () => {
  const root = await workspace();
  try {
    const api = mount();
    await mkdir(join(root, ".ssh"));
    const res = await api.post("/plugins/dsh-idea/import", { cwd: root, dir: "", rel: ".ssh/x", data: "eA==" });
    assert.equal(res.status, 422);
    assert.equal(res.data.error, "secret-path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cwd outside every workspace is refused before anything is deleted", async () => {
  const workspaceRoot = await workspace();
  const victim = await workspace();
  try {
    await mkdir(join(victim, "Documents"));
    await writeFile(join(victim, "Documents", "keep.txt"), "keep", "utf8");
    const { post, trust } = mount();
    trust(workspaceRoot);

    const refused = await post("/plugins/dsh-idea/delete", { cwd: victim, rel: "Documents" });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error, "cwd-not-workspace");
    // The directory is still there: the gate runs before deleteEntry.
    assert.equal(await readFile(join(victim, "Documents", "keep.txt"), "utf8"), "keep");

    await mkdir(join(workspaceRoot, "sub"));
    const allowed = await post("/plugins/dsh-idea/delete", { cwd: workspaceRoot, rel: "sub" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.ok, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(victim, { recursive: true, force: true });
  }
});

test("list and read refuse a cwd the host never opened", async () => {
  const workspaceRoot = await workspace();
  const victim = await workspace();
  try {
    await writeFile(join(victim, "notes.md"), "hi", "utf8");
    const { post, trust } = mount();
    trust(workspaceRoot);
    const listed = await post("/plugins/dsh-idea/list", { cwd: victim, rel: "" });
    assert.equal(listed.status, 403);
    const read = await post("/plugins/dsh-idea/read", { cwd: victim, rel: "notes.md" });
    assert.equal(read.status, 403);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(victim, { recursive: true, force: true });
  }
});
