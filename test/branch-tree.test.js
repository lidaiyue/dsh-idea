import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  btreePaintIsCurrent,
  buildRepoBranchTree,
  commitRowKey,
  groupOpenKey,
  isGroupOpen,
  liveRepoTreeApplies,
  mergeLiveRepoTree,
  mergeRepoCommits,
  nextTreeVersion,
  refLoadOptions,
  repoTreeDepKey
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

function treeShape(tree) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.kind === "head") out.push("head");
    else if (node.kind === "group") {
      out.push("group:" + node.id);
      (node.children || []).forEach(walk);
    } else if (node.kind === "repository") {
      out.push("repo:" + node.path);
      (node.children || []).forEach(walk);
    } else if (node.kind === "remote") {
      out.push("remote:" + node.name);
      (node.children || []).forEach(walk);
    } else {
      out.push("ref:" + (node.ref || node.name));
    }
  };
  (tree || []).forEach(walk);
  return out;
}

test("switching the selected branch in another repository does not bump treeVersion", () => {
  const repoTrees = { "/ws/app": trees["/ws/app"], "/ws/lib": trees["/ws/lib"] };
  const prev = {
    treeVersion: 3,
    repos,
    tags: repoTrees["/ws/app"].tags,
    repoTrees,
    treeShown: "/ws/app",
    repoPath: "/ws/app",
    cwd: "/ws/app",
    logRepoPath: "/ws/app",
    selectedRef: "feat/login"
  };
  // Immediate scheduleLoad patch + load's first write: path/selection/counts
  // target move, but the stored trees and repo list do not.
  const next = {
    ...prev,
    repoPath: "/ws/lib",
    logRepoPath: "/ws/lib",
    selectedRef: "develop",
    treeShown: "/ws/lib"
  };
  assert.equal(nextTreeVersion(prev, next), 3);
  assert.equal(nextTreeVersion(prev, { ...next, cwd: "/ws/lib", loading: true }), 3);

  // An explicit bump from withRepoTree (the lists actually moved) is kept.
  assert.equal(nextTreeVersion(prev, { ...next, treeVersion: 4 }), 4);

  // A new repoTrees map whose entries kept their identity is not structural;
  // only a replaced entry (or a changed `repos` list) bumps the version.
  const rebuilt = { ...repoTrees };
  assert.equal(nextTreeVersion(prev, { ...prev, repoTrees: rebuilt }), 3);
  assert.equal(nextTreeVersion(prev, { ...prev, repoTrees: { ...repoTrees, "/ws/lib": { ...repoTrees["/ws/lib"] } } }), 4);
  assert.equal(nextTreeVersion(prev, { ...prev, repos: repos.slice() }), 4);
});

test("a cross-repo click does not paint the previous repository's branches onto the new one", () => {
  const storedLib = trees["/ws/lib"];
  const liveApp = {
    head: trees["/ws/app"].head,
    local: trees["/ws/app"].local,
    remote: trees["/ws/app"].remote,
    tags: trees["/ws/app"].tags
  };
  // After the click, repoPath/currentPath already point at lib, but cwd and
  // the live lists are still app's (or load has started and loading is true).
  assert.equal(liveRepoTreeApplies({ currentPath: "/ws/lib", cwd: "/ws/app", loading: false }), false);
  assert.equal(mergeLiveRepoTree(storedLib, liveApp, { currentPath: "/ws/lib", cwd: "/ws/app", loading: false }), storedLib);
  assert.equal(liveRepoTreeApplies({ currentPath: "/ws/lib", cwd: "/ws/lib", loading: true }), false);
  assert.equal(mergeLiveRepoTree(storedLib, liveApp, { currentPath: "/ws/lib", cwd: "/ws/lib", loading: true }), storedLib);

  const ids = new Map();
  let seq = 0;
  const refId = (entry) => {
    if (entry === undefined) return "none";
    let id = ids.get(entry);
    if (id === undefined) { seq += 1; id = String(seq); ids.set(entry, id); }
    return id;
  };
  const pending = mergeLiveRepoTree(storedLib, liveApp, { currentPath: "/ws/lib", cwd: "/ws/app", loading: false });
  const before = repoTreeDepKey("/ws/lib", storedLib, storedLib, refId);
  const during = repoTreeDepKey("/ws/lib", storedLib, pending, refId);
  assert.equal(during, before, "fingerprint stays put while the live lists belong to the previous repo");

  // Once the fetch for lib completes, the overlay may apply; same content as
  // the stored entry must not look like a new tree.
  const ready = mergeLiveRepoTree(storedLib, {
    head: storedLib.head,
    local: storedLib.local,
    remote: storedLib.remote,
    tags: storedLib.tags
  }, { currentPath: "/ws/lib", cwd: "/ws/lib", loading: false });
  assert.notEqual(ready, storedLib);
  assert.deepEqual(ready.local, storedLib.local);
  assert.equal(repoTreeDepKey("/ws/lib", storedLib, ready, refId), before);
});

test("selecting a branch in another repository keeps the tree row identities", () => {
  const cache = new Map();
  const fromApp = buildRepoBranchTree(repos, trees, {
    currentPath: "/ws/app", logRepoPath: "/ws/app", selectedRef: "feat/login", cache
  });
  const toLib = buildRepoBranchTree(repos, trees, {
    currentPath: "/ws/lib", logRepoPath: "/ws/lib", selectedRef: "develop", cache
  });
  assert.deepEqual(treeShape(fromApp), treeShape(toLib));
  const appFeat = fromApp.find((n) => n.id === "local").children[0].children[1];
  const libDev = toLib.find((n) => n.id === "local").children[1].children[0];
  assert.equal(appFeat.selected, true);
  assert.equal(libDev.selected, true);
  assert.equal(fromApp.find((n) => n.id === "local").children[0].current, true);
  assert.equal(toLib.find((n) => n.id === "local").children[1].current, true);
});

test("btreePaintIsCurrent skips only when the portal still owns the same host", () => {
  const host = { id: "btree-a" };
  const rows = [{ id: "local" }, { id: "b:main" }];
  assert.equal(btreePaintIsCurrent(host, host, rows, rows), true, "same host and the same row elements may skip render");
  assert.equal(btreePaintIsCurrent(host, host, rows, rows.slice()), true, "a new array of the same element objects may still skip");
  assert.equal(btreePaintIsCurrent(host, host, rows, [rows[0], { id: "b:feat" }]), false);

  // Opening the commit dialog unmounts `.dgit-btree`. Closing it mounts a
  // new empty host; the cached rows are unchanged, but they must be painted
  // again — skipping would leave the column blank.
  const afterDialog = { id: "btree-b" };
  assert.equal(btreePaintIsCurrent(afterDialog, host, rows, rows), false);
  assert.equal(btreePaintIsCurrent(afterDialog, null, rows, rows), false);
  assert.equal(btreePaintIsCurrent(null, host, rows, rows), false);
});
