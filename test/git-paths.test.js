import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadShow, loadState } from "../lib/git/git.js";

const execFileAsync = promisify(execFile);
const CHINESE_DIR = "茂名工程";
const CHINESE_FILE = "提示词.txt";
const REL = CHINESE_DIR + "/" + CHINESE_FILE;

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

async function withRepo(fn) {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-quotepath-"));
  try {
    await runGit(root, ["-c", "init.defaultBranch=main", "init"]);
    await runGit(root, ["config", "user.name", "test"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await writeFile(join(root, "README.md"), "init\n", "utf8");
    await runGit(root, ["add", "--", "README.md"]);
    await runGit(root, ["commit", "-m", "init"]);
    await mkdir(join(root, CHINESE_DIR));
    await writeFile(join(root, REL), "hello\n", "utf8");
    await runGit(root, ["add", "--", REL]);
    await runGit(root, ["commit", "-m", "add chinese path"]);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("git.js passes core.quotepath=false to every invocation", async () => {
  const source = await readFile(new URL("../lib/git/git.js", import.meta.url), "utf8");
  assert.match(source, /"-c",\s*"core\.quotepath=false"/);
});

test("loadShow and loadState keep Chinese paths as UTF-8", async () => {
  await withRepo(async (root) => {
    const escaped = await runGit(root, ["-c", "core.quotepath=true", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
    assert.match(String(escaped.stdout), /\\[0-7]{3}/, "control: default quoting still escapes the path");

    const shown = await loadShow(root, "HEAD");
    assert.equal(shown.ok, true);
    assert.deepEqual(shown.files.map((f) => f.path), [REL]);
    assert.doesNotMatch(shown.files[0].path, /\\[0-7]{3}/);

    await writeFile(join(root, REL), "changed\n", "utf8");
    const state = await loadState(root);
    assert.equal(state.ok, true);
    const dirty = (state.files || []).map((f) => f.path);
    assert.ok(dirty.includes(REL), "status lists the Chinese path as UTF-8, got " + JSON.stringify(dirty));
  });
});
