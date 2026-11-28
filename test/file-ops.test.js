import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyEntry, importEntry, moveEntry } from "../lib/files.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-copy-"));
  return root;
}

async function gone(root) {
  await rm(root, { recursive: true, force: true });
}

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err && err.code;
  }
  return "";
}

test("copying a file into the same folder makes a copy name instead of overwriting", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "a.txt"), "one");
    const first = await copyEntry(root, "a.txt", "");
    assert.equal(first.rel, "a copy.txt");
    assert.equal(await readFile(join(root, "a copy.txt"), "utf8"), "one");
    // The original is untouched and still there.
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one");

    const second = await copyEntry(root, "a.txt", "");
    assert.equal(second.rel, "a copy 2.txt");
  } finally {
    await gone(root);
  }
});

test("copying a folder carries its tree but not its .git", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "pkg", ".git"), { recursive: true });
    await mkdir(join(root, "pkg", "src"), { recursive: true });
    await writeFile(join(root, "pkg", "src", "a.js"), "x");
    await writeFile(join(root, "pkg", ".git", "config"), "secret");
    const { rel } = await copyEntry(root, "pkg", "");
    assert.equal(rel, "pkg copy");
    assert.equal(await readFile(join(root, "pkg copy", "src", "a.js"), "utf8"), "x");
    const names = await readdir(join(root, "pkg copy"));
    assert.equal(names.includes(".git"), false);
  } finally {
    await gone(root);
  }
});

test("copying into another folder keeps the original name", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "dst"));
    await writeFile(join(root, "a.txt"), "one");
    const { rel } = await copyEntry(root, "a.txt", "dst");
    assert.equal(rel, "dst/a.txt");
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one");
  } finally {
    await gone(root);
  }
});

test("a copy cannot land inside its own source", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "pkg", "inner"), { recursive: true });
    assert.equal(await codeOf(() => copyEntry(root, "pkg", "pkg")), "inside-self");
    assert.equal(await codeOf(() => copyEntry(root, "pkg", "pkg/inner")), "inside-self");
  } finally {
    await gone(root);
  }
});

test("moving a file removes the source and refuses a taken name", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "dst"));
    await writeFile(join(root, "a.txt"), "one");
    await writeFile(join(root, "dst", "a.txt"), "kept");
    assert.equal(await codeOf(() => moveEntry(root, "a.txt", "dst")), "exists");
    assert.equal(await readFile(join(root, "dst", "a.txt"), "utf8"), "kept");

    await writeFile(join(root, "b.txt"), "two");
    const { rel } = await moveEntry(root, "b.txt", "dst");
    assert.equal(rel, "dst/b.txt");
    assert.equal(await codeOf(() => stat(join(root, "b.txt"))), "ENOENT");
  } finally {
    await gone(root);
  }
});

test("moving a folder into its own subtree is refused", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "pkg", "inner"), { recursive: true });
    assert.equal(await codeOf(() => moveEntry(root, "pkg", "pkg/inner")), "inside-self");
  } finally {
    await gone(root);
  }
});

test("an import writes the dropped tree and refuses to replace a file", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "assets"));
    const data = Buffer.from("png-bytes").toString("base64");
    const { rel } = await importEntry(root, "assets", "img/logo.png", data, false);
    assert.equal(rel, "assets/img/logo.png");
    assert.equal(await readFile(join(root, "assets", "img", "logo.png"), "utf8"), "png-bytes");

    assert.equal(await codeOf(() => importEntry(root, "assets", "img/logo.png", data, false)), "exists");
  } finally {
    await gone(root);
  }
});

test("an import creates an empty folder and refuses secret paths", async () => {
  const root = await workspace();
  try {
    const { rel } = await importEntry(root, "", "newdir", "", true);
    assert.equal(rel, "newdir");
    assert.equal((await stat(join(root, "newdir"))).isDirectory(), true);

    const data = Buffer.from("x").toString("base64");
    assert.equal(await codeOf(() => importEntry(root, "", ".ssh/id_rsa", data, false)), "secret-path");
    assert.equal(await codeOf(() => importEntry(root, "", "../escape.txt", data, false)), "bad-path");
  } finally {
    await gone(root);
  }
});

test("an import through a symlink that leaves the workspace is refused", async () => {
  const root = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "dsh-idea-outside-"));
  try {
    await symlink(outside, join(root, "link"));
    const data = Buffer.from("x").toString("base64");
    assert.equal(await codeOf(() => importEntry(root, "link", "a.txt", data, false)), "outside");
  } finally {
    await gone(root);
    await gone(outside);
  }
});

test("deleting a symlinked folder removes the link, not the folder it points at", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "keep.txt"), "keep");
    await symlink(join(root, "real"), join(root, "link"), "dir");

    const { deleteEntry } = await import("../lib/files.js");
    await deleteEntry(root, "link");

    // The link is gone and the target tree is untouched.
    assert.equal(await codeOf(() => stat(join(root, "link"))), "ENOENT");
    assert.equal(await readFile(join(root, "real", "keep.txt"), "utf8"), "keep");
  } finally {
    await gone(root);
  }
});

test("renaming a symlink moves the link and leaves the target where it was", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "keep.txt"), "keep");
    await symlink(join(root, "real"), join(root, "link"), "dir");

    const { renameEntry } = await import("../lib/files.js");
    await renameEntry(root, "link", "renamed");

    assert.equal(await codeOf(() => stat(join(root, "link"))), "ENOENT");
    assert.equal((await lstat(join(root, "renamed"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(root, "real", "keep.txt"), "utf8"), "keep");
  } finally {
    await gone(root);
  }
});
