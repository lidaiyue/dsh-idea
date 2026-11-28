import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceGate } from "../lib/trust.js";

async function dir(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** A context that answers the two services the gate reads. */
function contextOf(roots, extra = {}) {
  return {
    get(name) {
      if (name === "sessions") {
        return { list: () => roots.map((cwd) => ({ cwd })) };
      }
      if (name in extra) return extra[name];
      return undefined;
    }
  };
}

test("a cwd under a live session is accepted", async () => {
  const root = await dir("dsh-gate-ok-");
  await mkdir(join(root, "src"));
  const gate = createWorkspaceGate(contextOf([root]));
  assert.deepEqual(await gate.check(root), { ok: true });
  assert.deepEqual(await gate.check(join(root, "src")), { ok: true });
});

test("a cwd that does not exist is a 400, not an accepted path", async () => {
  const root = await dir("dsh-gate-missing-");
  const gate = createWorkspaceGate(contextOf([root]));
  assert.deepEqual(await gate.check(join(root, "gone")), { ok: false, error: "cwd-required" });
});

test("a cwd outside every workspace is refused", async () => {
  const root = await dir("dsh-gate-root-");
  const outside = await dir("dsh-gate-out-");
  const gate = createWorkspaceGate(contextOf([root]));
  assert.deepEqual(await gate.check(outside), { ok: false, error: "cwd-not-workspace" });
});

test("a sibling whose name shares the root prefix is not inside it", async () => {
  const root = await dir("dsh-gate-prefix-");
  const sibling = root + "-elsewhere";
  const gate = createWorkspaceGate(contextOf([root]));
  // `startsWith(root)` without a separator would accept this; the gate must not.
  assert.equal((await gate.check(sibling)).ok, false);
});

test("a relative or empty cwd is a 400, not a 403", async () => {
  const root = await dir("dsh-gate-rel-");
  const gate = createWorkspaceGate(contextOf([root]));
  assert.deepEqual(await gate.check("src"), { ok: false, error: "cwd-required" });
  assert.deepEqual(await gate.check(""), { ok: false, error: "cwd-required" });
  assert.deepEqual(await gate.check(undefined), { ok: false, error: "cwd-required" });
});

test("a symlinked workspace is compared by its real path", async () => {
  const root = await dir("dsh-gate-link-");
  const linkParent = await dir("dsh-gate-linkparent-");
  const link = join(linkParent, "ws");
  await symlink(root, link);
  const gate = createWorkspaceGate(contextOf([link]));
  // The session recorded the link; the browser may send either form.
  assert.equal((await gate.check(root)).ok, true);
  assert.equal((await gate.check(link)).ok, true);
});

test("a root of / grants nothing", async () => {
  const gate = createWorkspaceGate(contextOf(["/"]));
  const outside = await dir("dsh-gate-slash-");
  assert.equal((await gate.check(outside)).ok, false);
});

test("the sandbox policy root counts as a workspace", async () => {
  const root = await dir("dsh-gate-policy-");
  const gate = createWorkspaceGate({
    get(name) {
      if (name === "sandboxPolicy") return { workspaceRoot: root, additionalWritableRoots: [] };
      return undefined;
    }
  });
  assert.equal((await gate.check(root)).ok, true);
});

test("DSH_IDEA_EXTRA_ROOTS adds a root for a host that cannot enumerate", async () => {
  const root = await dir("dsh-gate-env-");
  process.env.DSH_IDEA_EXTRA_ROOTS = root;
  try {
    const gate = createWorkspaceGate({ get: () => undefined });
    assert.equal((await gate.check(root)).ok, true);
    assert.equal((await gate.check(await dir("dsh-gate-env2-"))).ok, false);
  } finally {
    delete process.env.DSH_IDEA_EXTRA_ROOTS;
  }
});

test("a host with no workspace source at all warns once and stays usable", async () => {
  const messages = [];
  const gate = createWorkspaceGate({ get: () => undefined }, (message) => messages.push(message));
  const root = await dir("dsh-gate-open-");
  assert.equal((await gate.check(root)).ok, true);
  assert.equal((await gate.check(root)).ok, true);
  assert.equal(messages.length, 1);
});
