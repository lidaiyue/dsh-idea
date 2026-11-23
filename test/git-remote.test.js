import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  defaultPushRemote,
  doPull,
  doPush,
  pullArgs,
  pushArgs,
  summarizeRepoOps
} from "../lib/git/ops.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, extra = {}) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0"
    },
    ...extra
  });
}

async function initRepo(dir, branch = "main") {
  await mkdir(dir, { recursive: true });
  await runGit(dir, ["-c", "init.defaultBranch=" + branch, "init"]);
  await runGit(dir, ["config", "user.name", "test"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(join(dir, "README.md"), dir + "\n", "utf8");
  await runGit(dir, ["add", "--", "README.md"]);
  await runGit(dir, ["commit", "-m", "init"]);
}

async function withTemp(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("pullArgs defaults to merge with autostash, no-rebase, and ff", () => {
  assert.deepEqual(pullArgs("", false).args, ["pull", "--autostash", "--no-rebase", "--ff"]);
  assert.deepEqual(pullArgs(undefined, undefined).args, ["pull", "--autostash", "--no-rebase", "--ff"]);
});

test("pullArgs rebase and optional remote/branch ref", () => {
  assert.deepEqual(pullArgs("", true).args, ["pull", "--autostash", "--rebase"]);
  assert.deepEqual(pullArgs("origin/main", false).args, ["pull", "--autostash", "--no-rebase", "--ff", "origin", "main"]);
  assert.deepEqual(pullArgs("origin/feature/x", true).args, ["pull", "--autostash", "--rebase", "origin", "feature/x"]);
  assert.equal(pullArgs("origin", false).ok, false);
  assert.equal(pullArgs("origin", false).error, "ref-required");
  assert.equal(pullArgs("/main", true).ok, false);
});

test("pullArgs rejects option-shaped ref segments (git argv injection)", () => {
  const attacks = [
    "origin/--upload-pack=/x",
    "--upload-pack=/x/main",
    "origin/-c",
    "origin/--exec=x"
  ];
  for (const ref of attacks) {
    const planned = pullArgs(ref, false);
    assert.equal(planned.ok, false, ref);
    assert.equal(planned.error, "ref-invalid", ref);
    assert.equal(planned.args, undefined, ref);
  }
});

test("doPull refuses a ref whose remote is not configured", async () => {
  await withTemp("dsh-idea-pull-remote-", async (root) => {
    await initRepo(root);
    const result = await doPull(root, "ghost/main", {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "ref-invalid");
  });
});

test("pushArgs uses -u only when the branch is untracked", () => {
  assert.deepEqual(pushArgs({ tracked: true, branch: "main", remotes: ["origin"] }).args, ["push"]);
  assert.deepEqual(pushArgs({ tracked: false, branch: "main", remotes: ["origin"] }).args, ["push", "-u", "origin", "main"]);
  assert.deepEqual(pushArgs({ tracked: false, branch: "topic", remotes: ["github", "origin"] }).args, ["push", "-u", "origin", "topic"]);
  assert.deepEqual(pushArgs({ tracked: false, branch: "topic", remotes: ["github"] }).args, ["push", "-u", "github", "topic"]);
});

test("pushArgs fails clearly without a remote or a current branch", () => {
  assert.deepEqual(pushArgs({ tracked: false, branch: "main", remotes: [] }), { ok: false, error: "no-remote" });
  assert.deepEqual(pushArgs({ tracked: false, branch: "", remotes: ["origin"] }), { ok: false, error: "detached-head" });
  assert.equal(defaultPushRemote(["upstream", "origin"]), "origin");
  assert.equal(defaultPushRemote(["github"]), "github");
  assert.equal(defaultPushRemote([]), "");
});

test("summarizeRepoOps reports partial and total failure without hiding names", () => {
  const mixed = summarizeRepoOps([
    { name: "mmcp", path: "/a", ok: true },
    { name: "mmcp_service", path: "/b", ok: false, error: "no tracking information" }
  ]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.all, true);
  assert.equal(mixed.error, "partial-failure");
  assert.equal(mixed.results.length, 2);
  assert.equal(mixed.results[1].name, "mmcp_service");

  const failed = summarizeRepoOps([
    { name: "one", ok: false, error: "no-remote" },
    { name: "two", ok: false, error: "no-remote" }
  ]);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "all-failed");

  const ok = summarizeRepoOps([
    { name: "one", ok: true },
    { name: "two", ok: true }
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.error, undefined);
});

test("doPush fails with no-remote when the repository has no remotes", async () => {
  await withTemp("dsh-idea-push-noremote-", async (root) => {
    await initRepo(root);
    const result = await doPush(root);
    assert.equal(result.ok, false);
    assert.equal(result.error, "no-remote");
  });
});

test("doPush sets upstream with -u, then uses a plain push once tracked", async () => {
  await withTemp("dsh-idea-push-upstream-", async (root) => {
    const work = join(root, "work");
    const bare = join(root, "origin.git");
    await initRepo(work);
    await mkdir(bare);
    await runGit(bare, ["init", "--bare"]);
    await runGit(work, ["remote", "add", "origin", bare]);

    const first = await doPush(work);
    assert.equal(first.ok, true, first.error);
    const upstream = (await runGit(work, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
    assert.equal(upstream, "origin/main");

    const second = await doPush(work);
    assert.equal(second.ok, true, second.error);
    assert.equal((await runGit(work, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim(), "origin/main");
  });
});

test("doPush all summarizes a partial failure and keeps going", async () => {
  await withTemp("dsh-idea-push-all-", async (root) => {
    const ready = join(root, "ready");
    const lone = join(root, "lone");
    const bare = join(root, "origin.git");
    await initRepo(ready);
    await initRepo(lone);
    await mkdir(bare);
    await runGit(bare, ["init", "--bare"]);
    await runGit(ready, ["remote", "add", "origin", bare]);

    const result = await doPush(root, { all: true });
    assert.equal(result.all, true);
    assert.equal(result.ok, false);
    assert.equal(result.error, "partial-failure");
    const byName = Object.fromEntries((result.results || []).map((row) => [row.name, row]));
    assert.equal(byName.ready && byName.ready.ok, true, JSON.stringify(result.results));
    assert.equal(byName.lone && byName.lone.ok, false);
    assert.equal(byName.lone.error, "no-remote");
  });
});

test("doPull all keeps going and names each failure", async () => {
  await withTemp("dsh-idea-pull-all-", async (root) => {
    await initRepo(join(root, "alpha"));
    await initRepo(join(root, "beta"));
    const result = await doPull(root, "", { all: true });
    assert.equal(result.all, true);
    assert.equal(result.ok, false);
    assert.equal(result.error, "all-failed");
    assert.equal((result.results || []).length, 2);
    const names = (result.results || []).map((row) => row.name).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
    for (const row of result.results) {
      assert.equal(row.ok, false);
      assert.match(String(row.error || ""), /no tracking information|no-remote|does not exist/i);
    }
  });
});

test("doPull still accepts a bare { cwd }-style call and uses merge args", async () => {
  await withTemp("dsh-idea-pull-compat-", async (root) => {
    await initRepo(root);
    const result = await doPull(root);
    assert.equal(result.ok, false);
    assert.match(String(result.error || ""), /no tracking information/i);
  });
});
