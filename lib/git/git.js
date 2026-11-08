import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import { MAX_BYTES } from "../files.js";

const execFileAsync = promisify(execFile);

// Same hard cap as file reads (files.js MAX_BYTES): a worktree "added" diff
// never reads more than this from disk.
const MAX_DIFF_BYTES = MAX_BYTES;

const MAX_LOG = 200;
const RS = "\x1e";
const FS = "\x1f";
const REF_FORMAT = "%(refname)" + FS + "%(refname:short)" + FS + "%(objectname)" + FS + "%(HEAD)" + FS + "%(upstream:short)";
// Bumped when the log payload dropped the embedded repo state.
const CACHE_EPOCH = 3;
const CACHE_MAX_ENTRIES = 24;
const CACHE_TTL_MS = 2 * 60 * 1000;
const ROOT_TTL_MS = 30 * 1000;
const MAX_REPOS = 12;
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "coverage", "vendor", "target", "out",
  ".next", ".nuxt", ".output", ".idea", ".vscode", ".git"
]);

const logCache = new Map();
const logInflight = new Map();
const rootCache = new Map();

// Git echoes the remote URL back on an auth failure — including the token when
// one is embedded in it — and that text is rendered in the panel. Strip the
// userinfo, bearer tokens and `password=`-style pairs before it leaves here.
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const SECRET_PAIR_RE = /\b(password|passwd|pwd|token|secret|authorization)\s*[=:]\s*\S+/gi;

function redact(text) {
  return String(text)
    .replace(USERINFO_RE, "$1[redacted]@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(SECRET_PAIR_RE, "$1=[redacted]");
}

function failText(error) {
  if (!error) return "git-failed";
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const msg = error.message ? String(error.message) : String(error);
  const text = redact(stderr || msg).replace(/\s+/g, " ").slice(0, 400);
  return text || "git-failed";
}

function looksLikeOption(value) {
  return typeof value === "string" && value.startsWith("-");
}

function safeToken(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (trimmed.includes("\0") || looksLikeOption(trimmed)) return fallback;
  return trimmed;
}

const REF_BAD_CHARS = /[\s~^:?*\[\\\x00-\x1f\x7f]/;

function refIssue(name) {
  if (typeof name !== "string") return "branch-required";
  const trimmed = name.trim();
  if (trimmed === "") return "branch-required";
  if (trimmed.length > 200) return "branch-too-long";
  if (looksLikeOption(trimmed)) return "branch-invalid";
  if (REF_BAD_CHARS.test(trimmed)) return "branch-invalid";
  if (trimmed === "@") return "branch-invalid";
  if (trimmed.includes("..") || trimmed.includes("@{") || trimmed.includes("//")) return "branch-invalid";
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return "branch-invalid";
  if (trimmed.endsWith(".")) return "branch-invalid";
  const parts = trimmed.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "" || part === "." || part === "..") return "branch-invalid";
    if (part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) return "branch-invalid";
  }
  return "";
}

function safeSince(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "midnight" || trimmed === "7 days ago" || trimmed === "30 days ago") return trimmed;
  return "";
}

async function git(cwd, args, opts) {
  const options = opts === undefined ? {} : opts;
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: options.timeout === undefined ? 15000 : options.timeout,
    maxBuffer: options.maxBuffer === undefined ? 8 * 1024 * 1024 : options.maxBuffer,
    encoding: "utf8",
    windowsHide: true,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env }
  });
  return result.stdout === undefined || result.stdout === null ? "" : String(result.stdout);
}

async function gitOk(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

async function gitOut(cwd, args, opts) {
  try {
    return await git(cwd, args, opts);
  } catch (error) {
    const code = error && error.code;
    if ((code === 1 || code === 2) && typeof error.stdout === "string") return String(error.stdout);
    throw error;
  }
}

function splitRecords(raw) {
  const text = String(raw || "").replace(/\n+$/, "");
  if (text === "") return [];
  return text.split(RS).map((row) => row.replace(/^\n+|\n+$/g, "")).filter((row) => row !== "");
}

function parseStatusV2(raw) {
  const lines = String(raw || "").split("\n").filter(Boolean);
  let head = "";
  let oid = "";
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      oid = value === "(initial)" ? "" : value;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      head = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("#")) continue;

    const kind = line.charAt(0);
    if (kind === "?") {
      files.push({ xy: "??", path: line.slice(2), orig: "" });
      continue;
    }
    if (kind === "!") continue;
    if (kind === "1" || kind === "2") {
      const tab = line.indexOf("\t");
      const row = tab === -1 ? line : line.slice(0, tab);
      const rest = tab === -1 ? "" : line.slice(tab + 1);
      const fieldCount = kind === "1" ? 8 : 9;
      const parts = row.split(" ");
      const xy = parts[1] || "  ";
      const path = parts.slice(fieldCount).join(" ");
      files.push({ xy, path, orig: rest });
      continue;
    }
    if (kind === "u") {
      const parts = line.split(" ");
      const xy = parts[1] || "UU";
      const path = parts.slice(10).join(" ");
      files.push({ xy, path, orig: "" });
    }
  }
  return { head, oid, files };
}

function parseRefs(raw) {
  const local = [];
  const remote = [];
  const tags = [];
  const rows = String(raw || "").split("\n").filter(Boolean);
  for (let i = 0; i < rows.length; i++) {
    const parts = rows[i].split(FS);
    const refname = parts[0] || "";
    const short = parts[1] || "";
    const hash = parts[2] || "";
    const head = parts[3] === "*";
    const upstream = parts[4] || "";
    if (refname.startsWith("refs/heads/")) {
      local.push({ name: short, hash, current: head, upstream, kind: "local" });
    } else if (refname.startsWith("refs/remotes/")) {
      if (short.endsWith("/HEAD")) continue;
      remote.push({ name: short, hash, current: false, upstream: "", kind: "remote" });
    } else if (refname.startsWith("refs/tags/")) {
      tags.push({ name: short, hash, current: false, upstream: "", kind: "tag" });
    }
  }
  return { local, remote, tags };
}

function bustRootCache(cwd) {
  if (cwd === undefined) rootCache.clear();
  else rootCache.delete(String(cwd));
}

async function gitRoot(cwd) {
  const key = String(cwd);
  const now = Date.now();
  const hit = rootCache.get(key);
  if (hit !== undefined && now - hit.at < ROOT_TTL_MS) return hit.root;
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (rootCache.size > 64) rootCache.clear();
  rootCache.set(key, { root, at: now });
  return root;
}

async function pathExists(path) {
  if (path === "") return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasUnmerged(root) {
  const out = await gitOk(root, ["diff", "--name-only", "--diff-filter=U"]);
  return String(out || "").trim() !== "";
}

async function gitOperation(root) {
  const probes = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["REBASE_HEAD", "rebase"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"]
  ];
  let out = "";
  try {
    const args = ["rev-parse", "--path-format=absolute"];
    for (const [name] of probes) args.push("--git-path", name);
    out = await git(root, args, { timeout: 5000 });
  } catch {
    return { kind: "", conflicted: false };
  }
  const paths = String(out || "").split("\n").map((line) => line.trim()).filter(Boolean);
  let kind = "";
  for (let i = 0; i < probes.length && i < paths.length; i++) {
    if (await pathExists(paths[i])) {
      kind = probes[i][1];
      break;
    }
  }
  if (kind === "") return { kind: "", conflicted: false };
  return { kind, conflicted: await hasUnmerged(root) };
}

function notRepoResult(error) {
  const text = failText(error);
  const notRepo = /not a git repository/i.test(text);
  return { ok: true, repo: false, notRepo, error: notRepo ? "" : text };
}

function notRepoFail() {
  return { ok: false, error: "not-a-repo" };
}

async function repoRoot(cwd) {
  try {
    return { root: await gitRoot(cwd) };
  } catch {
    return { error: notRepoFail() };
  }
}

function withUnbornLocal(local, head, unborn) {
  const localRefs = local.slice();
  if (unborn && head !== "" && head !== "HEAD" && !localRefs.some((b) => b.name === head)) {
    localRefs.push({ name: head, hash: "", current: true, upstream: "", kind: "local" });
  }
  return localRefs;
}

async function loadState(cwd) {
  let root;
  try {
    root = await gitRoot(cwd);
  } catch (error) {
    return notRepoResult(error);
  }
  const [statusRaw, refRaw, symRaw, operation] = await Promise.all([
    gitOk(root, ["status", "--porcelain=v2", "--branch", "-u"]),
    gitOk(root, ["for-each-ref", "--format=" + REF_FORMAT, "refs/heads", "refs/remotes"]),
    gitOk(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitOperation(root)
  ]);
  const v2 = parseStatusV2(statusRaw);
  const refs = parseRefs(refRaw);
  const hash = v2.oid;
  const unborn = hash === "";
  const symHead = symRaw.trim();
  const v2Head = v2.head === "(detached)" || v2.head === "(initial)" ? "" : v2.head;
  let head = v2Head;
  if (unborn) head = symHead || v2Head || "HEAD";
  else if (head === "") head = symHead || "HEAD";
  return {
    ok: true,
    repo: true,
    root,
    head: head || "HEAD",
    hash,
    short: hash === "" ? "" : hash.slice(0, 7),
    unborn,
    operation,
    conflicted: operation.conflicted,
    files: v2.files,
    dirty: v2.files.length > 0,
    local: withUnbornLocal(refs.local, head || "HEAD", unborn),
    remote: refs.remote
  };
}

/** Branch names + HEAD, without a working-tree status walk. */
async function loadHeads(cwd) {
  const found = await repoRoot(cwd);
  if (found.error) return found;
  const root = found.root;
  const [refRaw, symRaw, oidRaw] = await Promise.all([
    gitOk(root, ["for-each-ref", "--format=" + REF_FORMAT, "refs/heads"]),
    gitOk(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  ]);
  const head = symRaw.trim() || "HEAD";
  const unborn = String(oidRaw || "").trim() === "";
  return { root, head, local: withUnbornLocal(parseRefs(refRaw).local, head, unborn), unborn };
}

async function loadTags(cwd) {
  let root;
  try {
    root = await gitRoot(cwd);
  } catch (error) {
    return notRepoResult(error);
  }
  const raw = await gitOk(root, ["for-each-ref", "--format=" + REF_FORMAT, "refs/tags"]);
  return { ok: true, repo: true, tags: parseRefs(raw).tags };
}

function bustCache() {
  logCache.clear();
}

function cacheGet(key, now) {
  const hit = logCache.get(key);
  if (hit === undefined) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    logCache.delete(key);
    return null;
  }
  logCache.delete(key);
  logCache.set(key, hit);
  return hit;
}

function cacheSet(key, value, now) {
  logCache.delete(key);
  logCache.set(key, { ...value, at: now });
  while (logCache.size > CACHE_MAX_ENTRIES) {
    const oldest = logCache.keys().next().value;
    if (oldest === undefined) break;
    logCache.delete(oldest);
  }
}

function queryKey(cwd, body) {
  return [
    cwd,
    body && body.rev || "",
    body && typeof body.search === "string" ? body.search.trim() : "",
    body && body.author || "",
    body && body.since || ""
  ].join("\0");
}

/** HEAD + ref tips only. Working-tree edits and in-progress ops do not change the walk. */
async function logSignature(root) {
  const [headRaw, refRaw] = await Promise.all([
    gitOk(root, ["rev-parse", "HEAD"]),
    gitOk(root, ["for-each-ref", "--format=" + REF_FORMAT, "refs/heads", "refs/remotes"])
  ]);
  const refs = parseRefs(refRaw);
  const tips = (refs.local || []).concat(refs.remote || []).map((r) => r.name + ":" + r.hash).join(",");
  return [CACHE_EPOCH, String(headRaw || "").trim(), tips].join("\n");
}

function parseLog(raw) {
  const commits = [];
  const records = splitRecords(raw);
  for (let i = 0; i < records.length; i++) {
    const parts = records[i].split(FS);
    if (parts.length < 7) continue;
    const hash = parts[0];
    const short = parts[1];
    const parents = (parts[2] || "").trim() === "" ? [] : parts[2].trim().split(" ").filter(Boolean);
    commits.push({
      hash,
      short,
      parents,
      author: parts[3] || "",
      email: parts[4] || "",
      at: Number(parts[5]) || 0,
      subject: parts[6] || "",
      refs: parts[7] || ""
    });
  }
  return commits;
}

async function loadLogUncached(cwd, body) {
  const found = await repoRoot(cwd);
  if (found.error) return { ok: true, repo: false, notRepo: true, commits: [] };
  const root = found.root;
  // A fresh repo has an unborn HEAD: `git log HEAD` is a fatal there, but the
  // honest answer is simply "no commits yet", not an error.
  const head = await gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.trim() === "") return { ok: true, repo: true, commits: [] };
  const key = (await logSignature(root)) + "\0" + queryKey(cwd, body);
  const hit = cacheGet(key, Date.now());
  if (hit !== null) return { ok: true, repo: true, commits: hit.commits };

  const format = "--pretty=format:%H" + FS + "%h" + FS + "%P" + FS + "%an" + FS + "%ae" + FS + "%at" + FS + "%s" + FS + "%D" + RS;
  const search = typeof body.search === "string" ? body.search.trim() : "";
  // A hex-shaped word is not necessarily a hash: "added", "decade", "beefed"
  // and "facade" all match the character class. Ask git whether the token
  // really names one commit, and search it as text when it does not.
  let hashQuery = false;
  if (search !== "" && /^[0-9a-fA-F]{4,40}$/.test(search)) {
    try {
      hashQuery = (await git(root, ["rev-parse", "--verify", "--quiet", search + "^{commit}"])).trim() !== "";
    } catch {
      hashQuery = false;
    }
  }

  const args = hashQuery
    ? ["log", "-1", format, search]
    : ["log", "--date-order", "--max-count=" + String(MAX_LOG), format];
  if (!hashQuery) {
    args.push(safeToken(body.rev, "HEAD") || "HEAD");
    if (search !== "") args.push("--regexp-ignore-case", "--grep", search);
    const author = safeToken(body.author, "");
    if (author !== "") args.push("--author", author);
    const since = safeSince(body.since);
    if (since !== "") args.push("--since", since);
  }

  let raw;
  try {
    raw = await git(root, args, { timeout: 20000 });
  } catch (error) {
    return { ok: true, repo: true, commits: [], error: failText(error) };
  }
  const commits = parseLog(raw);
  cacheSet(key, { commits }, Date.now());
  return { ok: true, repo: true, commits };
}

async function loadLog(cwd, body) {
  const inflightKey = cwd + "\0" + queryKey(cwd, body);
  const pending = logInflight.get(inflightKey);
  if (pending) return pending;
  const work = loadLogUncached(cwd, body).finally(() => { logInflight.delete(inflightKey); });
  logInflight.set(inflightKey, work);
  return work;
}

async function loadShow(cwd, hash) {
  let root;
  try {
    root = await gitRoot(cwd);
  } catch (error) {
    return notRepoResult(error);
  }
  const id = safeToken(hash, "");
  if (id === "") return { ok: false, repo: true, root, error: "hash-required" };
  let meta;
  try {
    meta = await git(root, [
      "log", "-1", "--format=%H" + FS + "%h" + FS + "%P" + FS + "%an" + FS + "%ae" + FS + "%at" + FS + "%s" + FS + "%D" + FS + "%B",
      id
    ]);
  } catch (error) {
    return { ok: false, repo: true, root, error: failText(error) };
  }
  const parts = meta.replace(/\n+$/, "").split(FS);
  let nameStatus = "";
  try {
    nameStatus = await git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", id]);
  } catch {
    nameStatus = "";
  }
  const files = String(nameStatus || "").split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return { status: "M", path: line, orig: "" };
    const status = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    if (rest.includes("\t")) {
      const [orig, path] = rest.split("\t");
      return { status, path, orig };
    }
    return { status, path: rest, orig: "" };
  });
  return {
    ok: true,
    repo: true,
    root,
    commit: {
      hash: parts[0] || id,
      short: parts[1] || id.slice(0, 7),
      parents: (parts[2] || "").trim() === "" ? [] : parts[2].trim().split(" ").filter(Boolean),
      author: parts[3] || "",
      email: parts[4] || "",
      at: Number(parts[5]) || 0,
      subject: parts[6] || "",
      refs: parts[7] || "",
      body: parts.slice(8).join(FS).replace(/\n+$/, "")
    },
    files
  };
}

async function readAsAddedDiff(root, file) {
  const base = resolvePath(root);
  const abs = resolvePath(root, file);
  if (abs !== base && !abs.startsWith(base + "/")) return "";
  let size = 0;
  try {
    size = (await stat(abs)).size;
  } catch {
    return "";
  }
  // Hard cap aligned with files.js MAX_BYTES: reading a huge file into a diff
  // would only be truncated further down anyway, so report it as cut off.
  if (size > MAX_DIFF_BYTES) {
    return "diff --git a/" + file + " b/" + file + "\nnew file mode 100644\n--- /dev/null\n+++ b/" + file + "\n@@ -0,0 +1,1 @@\n+… (file too large, diff truncated)\n";
  }
  let raw;
  try {
    raw = await readFile(abs);
  } catch {
    return "";
  }
  if (raw.includes(0)) return "diff --git a/" + file + " b/" + file + "\nnew file mode 100644\nBinary files /dev/null and b/" + file + " differ\n";
  let content = raw.toString("utf8");
  if (content.length > 200000) content = content.slice(0, 200000) + "\n…\n";
  const lines = content.split("\n");
  const body = lines.map((line) => "+" + line).join("\n");
  return [
    "diff --git a/" + file + " b/" + file,
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/" + file,
    "@@ -0,0 +1," + lines.length + " @@",
    body
  ].join("\n");
}

/**
 * Working tree: `git diff HEAD` (staged and unstaged). Empty means the file is
 * untracked or HEAD does not exist yet, so the worktree text is shown as an add.
 * A commit id uses `git show` for that revision only.
 */
async function loadDiff(cwd, hash, path) {
  let root;
  try {
    root = await gitRoot(cwd);
  } catch (error) {
    return notRepoResult(error);
  }
  const file = safeToken(path, "");
  if (file === "") return { ok: false, repo: true, root, error: "path-required" };
  const absoluteFile = resolvePath(root, file);
  if (!withinDir(root, absoluteFile)) {
    return { ok: false, repo: true, root, error: "invalid-path" };
  }
  const opts = { timeout: 20000, maxBuffer: 2 * 1024 * 1024 };
  const working = hash === "WORKING" || hash === undefined || hash === null || hash === "";
  let text = "";
  try {
    if (working) {
      try {
        text = await gitOut(root, ["diff", "HEAD", "--", file], opts);
      } catch {
        text = "";
      }
      if (String(text).trim() === "") text = await readAsAddedDiff(root, file);
    } else {
      const id = safeToken(hash, "");
      if (id === "") return { ok: false, repo: true, root, error: "hash-required" };
      text = await gitOut(root, ["show", "--format=", "-u", id, "--", file], opts);
    }
  } catch (error) {
    return { ok: false, repo: true, root, error: failText(error) };
  }
  const diff = String(text || "");
  return {
    ok: true,
    path: file,
    hash: hash || "WORKING",
    diff: diff.length > 400000 ? diff.slice(0, 400000) + "\n…\n" : diff
  };
}

function withinDir(parent, child) {
  const root = resolvePath(parent);
  const target = resolvePath(child);
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

async function hasGitDir(dir) {
  try {
    const info = await stat(join(dir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

/**
 * Repositories the panel can switch between.
 *
 * The workspace root counts only when it is itself a repository. Immediate
 * children with their own `.git` count too, so two projects sitting side by
 * side are managed separately instead of `git init` on the parent. The walk
 * stays one level deep and skips dependency/build directories.
 */
async function discoverRepos(cwd) {
  const workspace = resolvePath(String(cwd || ""));
  const repos = [];
  const push = (dir, name) => {
    if (repos.length >= MAX_REPOS) return;
    if (repos.some((row) => row.path === dir)) return;
    repos.push({ name: name || basename(dir) || dir, path: dir });
  };
  if (await hasGitDir(workspace)) push(workspace, basename(workspace));
  let entries = [];
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch (error) {
    return { ok: false, repos, error: failText(error) };
  }
  for (const entry of entries) {
    if (repos.length >= MAX_REPOS) break;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const dir = join(workspace, entry.name);
    if (!withinDir(workspace, dir)) continue;
    if (await hasGitDir(dir)) push(dir, entry.name);
  }
  // A workspace that is a subdirectory of a repository has no `.git` of its own
  // and no repository below it, so the walk above finds nothing -- yet Git still
  // resolves upward. Reporting "no repo" there is wrong twice over: the panel
  // offers `git init` inside an existing repository, and the empty root leaves
  // every repo-relative path resolved against the subdirectory instead of the
  // repository, so opening a changed file builds a doubled path that cannot
  // exist. Only consulted when nothing else was found, so a workspace holding
  // real repositories still manages those.
  if (repos.length === 0) {
    try {
      const root = resolvePath(await gitRoot(workspace));
      if (root !== workspace && withinDir(root, workspace)) push(root, basename(root));
    } catch {
      // No enclosing repository either; the empty list is the honest answer.
    }
  }
  return { ok: true, repos };
}

export {
  failText,
  safeToken,
  refIssue,
  git,
  gitOk,
  gitRoot,
  bustRootCache,
  bustCache,
  gitOperation,
  notRepoFail,
  repoRoot,
  loadState,
  loadHeads,
  loadTags,
  loadLog,
  loadShow,
  loadDiff,
  discoverRepos
};
