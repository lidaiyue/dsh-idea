import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildRepoBranchTree,
  commitRowKey,
  groupOpenKey,
  isGroupOpen,
  mergeRepoCommits,
  refLoadOptions
} from "../lib/git/branch-tree.js";

function region(path, startMark, endMark) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark);
  assert.ok(start >= 0 && end > start, path + " is missing " + startMark);
  return source.slice(start, end);
}

const repos = [
  { name: "app", path: "/ws/app" },
  { name: "lib", path: "/ws/lib" }
];

const trees = {
  "/ws/app": {
    head: "main",
    local: [{ name: "main", current: true }, { name: "feat/login" }],
    remote: [{ name: "origin/main", upstream: "" }, { name: "origin/feat/login" }],
    tags: [{ name: "v1.0.0" }]
  },
  "/ws/lib": {
    head: "develop",
    local: [{ name: "develop", current: true }],
    remote: [{ name: "origin/develop" }],
    tags: []
  }
};

test("the browser copy of the branch tree matches branch-tree.js", () => {
  assert.equal(
    region("lib/client.git.js", "/* @branch-tree-start */", "/* @branch-tree-end */"),
    region("lib/git/branch-tree.js", "/* @branch-tree-start */", "/* @branch-tree-end */")
  );
});

test("groups are the roots, including the single-repository case", () => {
  const single = buildRepoBranchTree(repos.slice(0, 1), trees, { currentPath: "/ws/app" });
  assert.deepEqual(single.map((n) => n.kind + ":" + (n.id || n.ref || "head")), ["head:head", "group:local", "group:remote", "group:tags"]);
  const local = single.find((n) => n.id === "local");
  assert.equal(local.children.length, 1);
  assert.equal(local.children[0].kind, "repository");
  assert.equal(local.children[0].path, "/ws/app");
  assert.equal(local.children[0].name, "app");
  assert.equal(local.children[0].current, true);
  assert.deepEqual(local.children[0].children.map((b) => b.name), ["main", "feat/login"]);
  const head = single.find((n) => n.kind === "head");
  assert.equal(head.selected, true, "with no log filter, HEAD is the selected root");
});

test("multiple repositories hang under local/remote/tags, not as roots", () => {
  const tree = buildRepoBranchTree(repos, trees, { currentPath: "/ws/app", logRepoPath: "/ws/app", selectedRef: "feat/login" });
  assert.deepEqual(tree.map((n) => n.kind + ":" + (n.id || "head")), ["head:head", "group:local", "group:remote", "group:tags"]);
  assert.equal(tree[0].selected, false);

  const local = tree.find((n) => n.id === "local");
  assert.deepEqual(local.children.map((r) => r.name), ["app", "lib"]);
  assert.equal(local.children[0].current, true);
  assert.equal(local.children[0].selected, false, "a selected branch does not also select the repository");
  assert.equal(local.children[1].current, false);
  assert.deepEqual(local.children[0].children.map((b) => b.name), ["main", "feat/login"]);
  assert.equal(local.children[0].children[1].selected, true);
  assert.equal(local.children[1].children[0].name, "develop");
  assert.equal(local.children[1].children[0].selected, false, "a selected ref only highlights the filtered repository");

  const remote = tree.find((n) => n.id === "remote");
  assert.deepEqual(remote.children.map((r) => r.name), ["app", "lib"]);
  assert.equal(remote.children[0].children[0].kind, "remote");
  assert.equal(remote.children[0].children[0].name, "origin");
  assert.deepEqual(remote.children[0].children[0].children.map((b) => b.name), ["main", "feat/login"]);

  const tags = tree.find((n) => n.id === "tags");
  assert.deepEqual(tags.children.map((r) => r.name), ["app"], "repositories without tags are omitted from the tags group");
  assert.deepEqual(tags.children[0].children.map((b) => b.name), ["v1.0.0"]);
});

test("clicking a repository path is a context switch, not a filter", () => {
  const same = refLoadOptions("/ws/app", "/ws/app", "main");
  assert.deepEqual(same, { repoPath: "/ws/app", selectedRef: "main", switchRepo: false });
  const other = refLoadOptions("/ws/app", "/ws/lib", "develop");
  assert.deepEqual(other, { repoPath: "/ws/lib", selectedRef: "develop", switchRepo: true });
  const head = refLoadOptions("/ws/app", "/ws/lib", "");
  assert.equal(head.switchRepo, true);
  assert.equal(head.selectedRef, "");
});

test("branch search keeps the group-as-root shape and hides misses", () => {
  const tree = buildRepoBranchTree(repos, trees, { currentPath: "/ws/app", query: "login" });
  assert.equal(tree.some((n) => n.kind === "head"), false, "HEAD is hidden while searching");
  assert.deepEqual(tree.map((n) => n.id), ["local", "remote"]);
  assert.equal(tree.every((n) => n.open === true), true);
  const local = tree.find((n) => n.id === "local");
  assert.deepEqual(local.children.map((r) => r.name), ["app"]);
  assert.equal(local.children[0].open, true);
  assert.deepEqual(local.children[0].children.map((b) => b.name), ["feat/login"]);
  const remote = tree.find((n) => n.id === "remote");
  assert.deepEqual(remote.children[0].children[0].children.map((b) => b.name), ["feat/login"]);

  const byRepo = buildRepoBranchTree(repos, trees, { currentPath: "/ws/app", query: "lib" });
  assert.deepEqual(byRepo.map((n) => n.id), ["local", "remote"]);
  assert.deepEqual(byRepo.find((n) => n.id === "local").children.map((r) => r.name), ["lib"]);
  assert.deepEqual(byRepo.find((n) => n.id === "local").children[0].children.map((b) => b.name), ["develop"]);
});

test("tags stay closed by default and inherit a legacy leftOpen.tags flag", () => {
  assert.equal(isGroupOpen({}, "", "tags"), false);
  assert.equal(isGroupOpen({}, "", "local"), true);
  assert.equal(isGroupOpen({ tags: true }, "", "tags"), true);
  assert.equal(isGroupOpen({}, "/ws/app", "tags"), true, "a repository under tags defaults to open once the group is open");
  const key = groupOpenKey("/ws/app", "tags");
  assert.equal(isGroupOpen({ [key]: false }, "/ws/app", "tags"), false);
  assert.equal(groupOpenKey("", "local"), "local");
});

test("merged logs keep a repository name on every commit and sort by date", () => {
  const merged = mergeRepoCommits([
    { repo: { name: "app", path: "/ws/app" }, commits: [{ hash: "a1", subject: "older app", at: 100 }, { hash: "a2", subject: "newer app", at: 300 }] },
    { repo: { name: "lib", path: "/ws/lib" }, commits: [{ hash: "b1", subject: "mid lib", at: 200 }, { hash: "a1", subject: "same hash in lib", at: 300 }] }
  ]);
  assert.deepEqual(merged.map((c) => c.repoName + ":" + c.hash), ["app:a2", "lib:a1", "lib:b1", "app:a1"]);
  assert.equal(merged[0].repoPath, "/ws/app");
  assert.equal(commitRowKey(merged[0]), "/ws/app\0a2");
  assert.notEqual(commitRowKey(merged[0]), commitRowKey(merged[3]));
  assert.notEqual(commitRowKey(merged[1]), commitRowKey({ hash: "a1", repoPath: "/ws/app" }));
});

test("the Git panel has no title row or repository select, and keeps author/date filters", () => {
  const source = readFileSync(new URL("../lib/client.git.js", import.meta.url), "utf8");
  assert.equal(source.includes('className: "dgit-repo"'), false);
  assert.equal(source.includes(".dgit-repo{"), false);
  assert.equal(source.includes('className: "dgit-bar"'), false);
  assert.equal(source.includes('className: "dgit-title"'), false);
  assert.equal(source.includes('className: "dgit-branchchip"'), false);
  assert.equal(source.includes('className: "dgit-sel"'), true);
  assert.equal(source.includes('className: "dgit-rname"'), true);
  assert.equal(source.includes("buildRepoBranchTree("), true);
  assert.equal(source.includes("mergeRepoCommits("), true);
  assert.equal(source.includes("selectRepo("), true);
  const git = readFileSync(new URL("../lib/git/git.js", import.meta.url), "utf8");
  assert.match(git, /const MAX_REPOS = 12;/);
});
