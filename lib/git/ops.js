import { readdir, rmdir, stat } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  bustCache,
  bustRootCache,
  failText,
  git,
  gitOk,
  gitOperation,
  gitRoot,
  loadHeads,
  loadState,
  notRepoFail,
  refIssue,
  repoRoot,
  safeToken
} from "./git.js";

function outputOf(out) {
  return String(out || "").trim().slice(0, 800);
}

async function runGit(cwd, args, opts) {
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  try {
    const out = await git(found.root, args, opts);
    bustCache();
    return { ok: true, output: outputOf(out) };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

/**
 * Why a checkout or merge refused to touch the worktree, or "" if it failed
 * for some other reason.
 *
 * The two wordings git actually emits are kept apart from a generic failure:
 * tracked local edits ("Your local changes…") versus untracked files sitting
 * where the incoming tree wants to write. Only the second needs `-u`.
 */
function blockKind(error) {
  const stderr = error && typeof error.stderr === "string" ? error.stderr : "";
  const text = stderr || (error && error.message ? String(error.message) : "");
  if (!/would be overwritten by (?:checkout|merge)|would be removed by (?:checkout|merge)|before you switch branches|before you merge/i.test(text)) {
    return "";
  }
  return /untracked working tree files/i.test(text) ? "untracked" : "tracked";
}

async function stashTip(root) {
  return (await gitOk(root, ["rev-parse", "-q", "--verify", "refs/stash"])).trim();
}

async function stashPop(root) {
  try {
    return await git(root, ["stash", "pop", "--index"], { timeout: 30000 });
  } catch (indexed) {
    // `--index` refuses before touching the worktree when the index cannot be
    // restored exactly. Only that wording is retried as a plain pop; a content
    // conflict has already applied, and a second pop would apply it again.
    const text = failText(indexed);
    if (!/conflicts in index|Try without --index/i.test(text)) throw indexed;
    return await git(root, ["stash", "pop"], { timeout: 30000 });
  }
}

/**
 * Stash the local changes that blocked `args`, run the command, then restore.
 *
 * Steps: record `refs/stash`; `stash push` (with `-u` only when git named
 * untracked files); retry the same command; `stash pop`. If the command still
 * fails, pop immediately so the worktree is what the user had. A pop conflict
 * after a successful command is reported as `stash-conflict` with `switched`
 * set — the branch (or pull) already moved, and git keeps the stash entry.
 *
 * @returns a result, or null when there was nothing to stash.
 */
async function runKeepingChanges(root, kind, args, timeout) {
  const before = await stashTip(root);
  const stashArgs = ["stash", "push", "-m", "dsh-git-manager: autostash"];
  if (kind === "untracked") stashArgs.push("--include-untracked");
  let pushed;
  try {
    pushed = await git(root, stashArgs, { timeout: 30000 });
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
  if (/No local changes to save/i.test(String(pushed || ""))) return null;
  const after = await stashTip(root);
  if (after === "" || after === before) return null;
  try {
    const out = await git(root, args, { timeout });
    try {
      const popped = await stashPop(root);
      bustCache();
      return { ok: true, stashed: true, output: outputOf(String(out || "") + "\n" + String(popped || "")) };
    } catch (error) {
      bustCache();
      return { ok: false, switched: true, error: "stash-conflict" };
    }
  } catch (error) {
    const commandError = failText(error);
    try {
      await stashPop(root);
    } catch (again) {
      bustCache();
      return { ok: false, error: commandError + " | " + failText(again) };
    }
    bustCache();
    return { ok: false, error: commandError };
  }
}

/**
 * Confirm a token really names a branch or tag in this repository.
 *
 * `refIssue` only validates *shape*, and a file name is a perfectly legal ref
 * shape -- but `git checkout <name>` resolves a name that is both a path and a
 * ref as a **path** and overwrites the worktree file, silently discarding
 * uncommitted edits. Revision expressions (`HEAD~1`) are unambiguous refs and
 * discard work the same way. So the name is matched against the refs that
 * actually exist, which is the same universe the branch panel renders:
 * `refs/heads`, `refs/remotes`, `refs/tags`.
 *
 * The match must be EXACT. `for-each-ref refs/heads/<name>` filters by pattern
 * and matches descendants, so a repository holding a branch `data.txt/evil`
 * would report `refs/heads/data.txt` for the query `data.txt` -- and `data.txt`
 * is exactly the file name a checkout would then clobber. `%(refname:lstrip=2)`
 * yields the short name, which is compared for equality instead.
 *
 * @returns true when the exact name is an existing ref of one of those kinds.
 */
async function isKnownRef(root, name) {
  const out = await gitOk(root, [
    "for-each-ref", "--format=%(refname:lstrip=2)",
    "refs/heads", "refs/remotes", "refs/tags"
  ]);
  const wanted = name.replace(/^refs\/(?:heads|remotes|tags)\//, "");
  const names = String(out || "").split("\n");
  for (let i = 0; i < names.length; i++) {
    if (names[i].trim() === wanted) return true;
  }
  return false;
}

async function doCheckout(cwd, ref) {
  const target = safeToken(ref, "");
  if (target === "") return { ok: false, error: "ref-required" };
  // A ref, not a revision expression. `HEAD~1`, `main@{yesterday}` and friends
  // are legal `git checkout` arguments that detach HEAD and overwrite
  // uncommitted work, so the same shape gate the branch routes use applies here
  // (ops.js previously only ran `safeToken`, which just blocks a leading "-").
  const issue = refIssue(target);
  if (issue !== "") return { ok: false, error: issue };
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  if (!(await isKnownRef(found.root, target))) return { ok: false, error: "ref-missing" };
  // A remote-tracking row ("origin/feature-x") must not be checked out as-is:
  // `git checkout origin/feature-x` detaches HEAD instead of creating the local
  // branch, leaving the panel showing "HEAD" with nothing under local.
  // `--track` names the new local branch after the ref and wires upstream.
  const slash = target.indexOf("/");
  const args = ["checkout"];
  if (slash > 0) {
    const remote = target.slice(0, slash);
    const branch = target.slice(slash + 1);
    const isLocal = await gitOk(found.root, ["show-ref", "--verify", "refs/heads/" + branch]);
    const isRemote = await gitOk(found.root, ["show-ref", "--verify", "refs/remotes/" + remote + "/" + branch]);
    if (String(isLocal).trim() === "" && String(isRemote).trim() !== "") args.push("--track");
  }
  args.push(target);
  try {
    const out = await git(found.root, args, { timeout: 20000 });
    bustCache();
    return { ok: true, output: outputOf(out) };
  } catch (error) {
    const kind = blockKind(error);
    if (kind !== "") {
      const recovered = await runKeepingChanges(found.root, kind, args, 20000);
      if (recovered) return recovered;
    }
    return { ok: false, error: failText(error) };
  }
}

async function doDeleteBranch(cwd, ref, kind) {
  const target = safeToken(ref, "");
  if (target === "") return { ok: false, error: "ref-required" };
  if (refIssue(target) !== "") return { ok: false, error: "branch-invalid" };
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  try {
    const heads = await loadHeads(cwd);
    if (heads.error) return heads.error;
    if (kind === "remote") {
      // Remote-tracking row: the branch part is everything after <remote>/, and
      // the remote itself must be a real remote -- never a leading path segment
      // guessed from the name.
      const cut = target.indexOf("/");
      const remote = cut > 0 ? safeToken(target.slice(0, cut), "") : "";
      const branch = cut > 0 ? safeToken(target.slice(cut + 1), "") : "";
      if (remote === "" || branch === "") return { ok: false, error: "branch-invalid" };
      const remotes = (await gitOk(found.root, ["remote"])).split("\n").map((line) => line.trim()).filter(Boolean);
      if (!remotes.includes(remote)) return { ok: false, error: "branch-invalid" };
      await git(found.root, ["push", remote, "--delete", branch], { timeout: 30000 });
    } else {
      // Local row. "/" is legal in a local branch name (`feature/login`), so the
      // name is matched against the real branch list instead of being split on
      // it -- proven present first, which also makes a stale UI row fail loudly
      // rather than being reinterpreted as a remote.
      if (!(heads.local || []).some((b) => b.name === target)) return { ok: false, error: "branch-missing" };
      if (heads.head === target) return { ok: false, error: "current-branch" };
      await git(found.root, ["branch", "-d", target], { timeout: 15000 });
    }
    bustCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

async function doCreateBranch(cwd, ref, startPoint) {
  const heads = await loadHeads(cwd);
  if (heads.error) return heads.error;
  const name = typeof ref === "string" ? ref.trim() : "";
  const issue = refIssue(name);
  if (issue !== "") return { ok: false, error: issue };
  const from = typeof startPoint === "string" ? safeToken(startPoint, "") : "";
  if ((heads.local || []).some((b) => b.name === name)) return { ok: false, error: "branch-exists" };
  try {
    await git(heads.root, ["check-ref-format", "--branch", name], { timeout: 5000 });
  } catch {
    return { ok: false, error: "branch-invalid" };
  }
  const args = ["checkout", "-b", name];
  if (from !== "" && !heads.unborn) args.push(from);
  try {
    await git(heads.root, args, { timeout: 20000 });
    bustCache();
    return { ok: true, created: name };
  } catch (error) {
    const kind = blockKind(error);
    if (kind !== "") {
      const recovered = await runKeepingChanges(heads.root, kind, args, 20000);
      if (recovered) return recovered.ok ? { ...recovered, created: name } : recovered;
    }
    return { ok: false, error: failText(error) };
  }
}

async function doRenameBranch(cwd, ref, next) {
  const heads = await loadHeads(cwd);
  if (heads.error) return heads.error;
  const from = safeToken(ref, "");
  const to = typeof next === "string" ? next.trim() : "";
  if (from === "") return { ok: false, error: "ref-required" };
  const issue = refIssue(to);
  if (issue !== "") return { ok: false, error: issue };
  if (from === to) return { ok: false, error: "branch-same" };
  const isCurrent = from === heads.head;
  if (!isCurrent && !(heads.local || []).some((b) => b.name === from)) return { ok: false, error: "branch-missing" };
  if ((heads.local || []).some((b) => b.name === to)) return { ok: false, error: "branch-exists" };
  try {
    try {
      await git(heads.root, ["check-ref-format", "--branch", to], { timeout: 5000 });
    } catch {
      return { ok: false, error: "branch-invalid" };
    }
    await git(heads.root, ["branch", "-m", from, to], { timeout: 15000 });
    bustCache();
    return { ok: true, renamed: to };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

async function doOperation(cwd, action) {
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  const operation = await gitOperation(found.root);
  const kind = operation && operation.kind ? operation.kind : "";
  if (kind === "") return { ok: false, error: "no-operation" };
  const wantAbort = action === "abort";
  const cmds = {
    merge: wantAbort ? ["merge", "--abort"] : ["merge", "--continue"],
    "cherry-pick": wantAbort ? ["cherry-pick", "--abort"] : ["cherry-pick", "--continue"],
    revert: wantAbort ? ["revert", "--abort"] : ["revert", "--continue"],
    rebase: wantAbort ? ["rebase", "--abort"] : ["rebase", "--continue"]
  };
  const args = cmds[kind];
  if (args === undefined) return { ok: false, error: "no-operation" };
  try {
    const out = await git(found.root, args, { timeout: 60000, env: { GIT_EDITOR: "true" } });
    bustCache();
    return { ok: true, output: String(out || "").trim().slice(0, 800) };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

async function doInit(cwd) {
  let root = "";
  try {
    root = await gitRoot(cwd);
  } catch {}
  if (root !== "") return { ok: true, created: false };
  try {
    const out = await git(cwd, ["init"], { timeout: 20000 });
    bustRootCache(cwd);
    bustCache();
    return { ok: true, created: true, output: String(out || "").trim().slice(0, 800) };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

async function doPull(cwd) {
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  // `--autostash` is what stops a dirty worktree from aborting the merge half
  // of pull. A clean apply is a normal success; a conflict means the branch
  // already moved and git kept the stash entry.
  const args = ["pull", "--autostash"];
  try {
    const out = await git(found.root, args, { timeout: 60000 });
    // git exits 0 even when applying the autostash conflicts. The conflict
    // markers and the kept stash entry are the signal; stderr is discarded by
    // a successful spawn.
    const unmerged = (await gitOk(found.root, ["diff", "--name-only", "--diff-filter=U"])).trim();
    bustCache();
    if (unmerged !== "") return { ok: false, switched: true, error: "stash-conflict" };
    return { ok: true, output: outputOf(out) };
  } catch (error) {
    const text = failText(error);
    if (/Applying autostash resulted in conflicts|stash entry is kept/i.test(text)) {
      bustCache();
      return { ok: false, switched: true, error: "stash-conflict" };
    }
    const kind = blockKind(error);
    if (kind !== "") {
      const recovered = await runKeepingChanges(found.root, kind, args, 60000);
      if (recovered) return recovered;
    }
    return { ok: false, error: text };
  }
}

async function doCherryPick(cwd, hash) {
  const id = safeToken(hash, "");
  if (!/^[0-9a-fA-F]{7,40}$/.test(id)) return { ok: false, error: "hash-required" };
  return runGit(cwd, ["cherry-pick", id], { timeout: 30000 });
}

async function doMerge(cwd, ref) {
  const target = safeToken(ref, "");
  if (target === "") return { ok: false, error: "ref-required" };
  // Same revision-expression gate as checkout: `git merge HEAD~1` rewrites the
  // worktree and can leave conflicts, which is not what "merge that branch"
  // means.
  const issue = refIssue(target);
  if (issue !== "") return { ok: false, error: issue };
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  // `git merge <path>` is not a pathspec form either -- a bare file name is
  // resolved as a ref and fails, but the guard keeps the accepted vocabulary
  // identical to checkout's instead of relying on git's own error.
  if (!(await isKnownRef(found.root, target))) return { ok: false, error: "ref-missing" };
  const head = (await gitOk(found.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  if (head !== "" && target === head) return { ok: false, error: "already-on-branch" };
  try {
    const out = await git(found.root, ["merge", "--no-edit", target], { timeout: 30000 });
    bustCache();
    return { ok: true, output: String(out || "").trim().slice(0, 800) };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

function safePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (let i = 0; i < paths.length && out.length < 400; i++) {
    const p = safeToken(paths[i], "");
    if (p !== "") out.push(p);
  }
  return out;
}

async function doCommit(cwd, message, paths, amend) {
  const files = safePaths(paths);
  if (files.length === 0) return { ok: false, error: "no-files" };
  // `git add` / `git commit` read their trailing arguments as *pathspecs*, so a
  // filename containing `*`, `?` or `[` — a downloaded `report[1].txt`, say —
  // would match files the user never ticked and stage them. `:(literal)` turns
  // the glob off. The specs are built from the validated relative path, so the
  // stat below still uses the real name.
  const specs = files.map(literalPathspec);
  if (specs.some((spec) => spec === "")) return { ok: false, error: "bad-path" };
  const msg = typeof message === "string" ? message.trim() : "";
  if (!amend && msg === "") return { ok: false, error: "message-required" };
  if (msg.length > 4000) return { ok: false, error: "message-too-long" };
  const found = await repoRoot(cwd);
  if (found.error) return found.error;
  try {
    // `git add <path>` fails outright when the path matches nothing in the
    // worktree — which is the normal state of a deletion: a staged `D` whose
    // file is already gone makes even a re-`add` of the same path fatal. So
    // only existing paths are staged, and the deletion itself rides on the
    // `git commit -- <path>` pathspec below, which resolves deletions from
    // HEAD fine (staged or not). A path that is neither on disk nor a real
    // change (stale UI entry) fails the commit with git's own message.
    const existing = [];
    for (const file of files) {
      try {
        await stat(resolvePath(found.root, file));
        existing.push(file);
      } catch {
        // Already gone. The commit pathspec below records the deletion.
      }
    }
    if (existing.length > 0) {
      await git(found.root, ["add", "--", ...existing.map(literalPathspec)], { timeout: 20000 });
    }
    const args = ["commit"];
    if (amend === true) args.push("--amend");
    if (msg !== "") args.push("-m", msg);
    else args.push("--no-edit");
    args.push("--", ...specs);
    const out = await git(found.root, args, { timeout: 20000 });
    bustCache();
    return { ok: true, output: String(out || "").trim().slice(0, 800) };
  } catch (error) {
    return { ok: false, error: failText(error) };
  }
}

function literalPathspec(value) {
  if (typeof value !== "string") return "";
  if (value === "" || value.trim() === "" || value.includes("\0")) return "";
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return "";
  const segments = value.split("/");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "..") return "";
  }
  return ":(literal)" + value;
}

async function restoreWouldDestroy(root, relPath) {
  const abs = resolvePath(root, relPath);
  let entries;
  try {
    entries = await readdir(abs);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return !entries.includes(".git");
}

async function pruneEmptyParents(root, relPath) {
  const base = resolvePath(root);
  let dir = dirname(resolvePath(root, relPath));
  while (dir !== base && dir.startsWith(base + "/")) {
    try {
      const entries = await readdir(dir);
      if (entries.length > 0) return;
    } catch {
      return;
    }
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

async function doRollback(cwd, requested) {
  const state = await loadState(cwd);
  if (!state.repo) return notRepoFail();
  const wanted = new Set();
  if (Array.isArray(requested)) {
    for (let i = 0; i < requested.length && wanted.size < 400; i++) {
      const path = literalPathspec(requested[i]);
      if (path !== "") wanted.add(path);
    }
  }
  if (wanted.size === 0) return { ok: false, error: "path-required" };

  const statusOf = new Map();
  for (let i = 0; i < (state.files || []).length; i++) {
    const file = state.files[i];
    const xy = String(file.xy || "").trim();
    if (file.path) statusOf.set(String(file.path), xy);
    if (file.orig) statusOf.set(String(file.orig), xy);
  }
  const tracked = new Set();
  const untracked = new Set();
  for (const spec of wanted) {
    const raw = spec.slice(":(literal)".length);
    const xy = statusOf.get(raw);
    if (xy === "??") untracked.add(raw);
    else tracked.add(raw);
  }
  for (let i = 0; i < (state.files || []).length; i++) {
    const file = state.files[i];
    if (!file.path || !file.orig) continue;
    if (wanted.has(":(literal)" + file.path) || wanted.has(":(literal)" + file.orig)) {
      tracked.add(String(file.path));
      tracked.add(String(file.orig));
    }
  }
  for (const path of tracked) untracked.delete(path);

  const blocked = [];
  if (state.unborn !== true) {
    for (const path of tracked) {
      if (await restoreWouldDestroy(state.root, path)) blocked.push(path);
    }
  }
  if (blocked.length > 0) {
    return { ok: false, error: "path-is-directory:" + blocked.join(", "), rolledBack: [] };
  }

  const done = [];
  try {
    if (tracked.size > 0) {
      const args = state.unborn === true
        ? ["rm", "--force", "--quiet", "--"]
        : ["restore", "--source=HEAD", "--staged", "--worktree", "--"];
      const list = [...tracked];
      await git(state.root, [...args, ...list.map(literalPathspec)], { timeout: 30000 });
      for (let i = 0; i < list.length; i++) done.push(list[i]);
    }
    if (untracked.size > 0) {
      // One batched clean instead of one subprocess per file; empty parents
      // are still pruned per path afterwards, like the tracked branch.
      const list = [...untracked];
      await git(state.root, ["clean", "-f", "-d", "--", ...list.map(literalPathspec)], { timeout: 20000 });
      for (let i = 0; i < list.length; i++) {
        await pruneEmptyParents(state.root, list[i]);
        done.push(list[i]);
      }
    }
  } catch (error) {
    return { ok: false, error: failText(error), rolledBack: done };
  }
  return { ok: true, rolledBack: done };
}

async function doPush(cwd) {
  return runGit(cwd, ["push"], { timeout: 60000 });
}

export {
  doCheckout,
  doDeleteBranch,
  doCreateBranch,
  doRenameBranch,
  doOperation,
  doInit,
  doPull,
  doCherryPick,
  doMerge,
  doCommit,
  doRollback,
  doPush
};
