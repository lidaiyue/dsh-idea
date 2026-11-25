// Left-tree model for the Git panel.
//
// The marked region is copied verbatim into lib/client.git.js (the browser
// bundle cannot import this module). test/branch-tree.test.js asserts the two
// copies stay the same.

/* @branch-tree-start */
/**
 * Expand/collapse key for a top-level group, or a repository under one, in
 * `leftOpen`.
 * @param {string} path
 * @param {string} group
 */
function groupOpenKey(path, group) {
  return path ? ("repo:" + path + ":" + group) : String(group || "");
}

/**
 * Whether a top-level group (local / remote / tags) or a repository under it
 * is expanded.
 *
 * A missing path addresses the group itself and falls back to the legacy
 * global `leftOpen.local` / `.remote` / `.tags` flags. Tags stay closed by
 * default; local and remote stay open. A path addresses that repository
 * under the group, and defaults to open so a newly discovered repository
 * is visible without a stored preference.
 * @param {Record<string, boolean>|null|undefined} leftOpen
 * @param {string} path
 * @param {string} group
 * @param {boolean} [fallback]
 */
function isGroupOpen(leftOpen, path, group, fallback) {
  const key = groupOpenKey(path, group);
  if (leftOpen && Object.prototype.hasOwnProperty.call(leftOpen, key)) {
    return group === "tags" && !path ? leftOpen[key] === true : leftOpen[key] !== false;
  }
  if (!path && leftOpen && Object.prototype.hasOwnProperty.call(leftOpen, group)) {
    return group === "tags" ? leftOpen[group] === true : leftOpen[group] !== false;
  }
  if (fallback !== undefined) return fallback !== false;
  if (!path) return group !== "tags";
  return true;
}

/**
 * Case-insensitive substring match used by the branch/tag search box.
 * @param {string} name
 * @param {string} query
 */
function matchBranchQuery(name, query) {
  const q = String(query || "").trim().toLowerCase();
  return q === "" || String(name || "").toLowerCase().indexOf(q) >= 0;
}

/**
 * Group remote-tracking branches by the remote name (`origin/main` → `origin`).
 * @param {Array<{name: string}>|null|undefined} remotes
 */
function groupRemoteBranches(remotes) {
  const groups = {};
  const list = Array.isArray(remotes) ? remotes : [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const name = row && row.name ? String(row.name) : "";
    if (name === "") continue;
    const slash = name.indexOf("/");
    const remote = slash < 0 ? name : name.slice(0, slash);
    if (!groups[remote]) groups[remote] = [];
    groups[remote].push(row);
  }
  return Object.keys(groups).sort().map((name) => ({ name, branches: groups[name] }));
}

/**
 * Load options for clicking a ref (branch, tag, or HEAD) under a repository.
 *
 * A click on the current repository only changes `selectedRef`. A click under
 * another repository also switches the panel context to that path, which is
 * what used to be the top-bar repository dropdown.
 * @param {string} currentPath
 * @param {string} repoPath
 * @param {string} [selectedRef]
 */
function refLoadOptions(currentPath, repoPath, selectedRef) {
  const path = repoPath || currentPath || "";
  return {
    repoPath: path,
    selectedRef: selectedRef || "",
    switchRepo: path !== "" && path !== (currentPath || "")
  };
}

function shortRemoteName(name, remote) {
  const prefix = remote + "/";
  return name.indexOf(prefix) === 0 ? name.slice(prefix.length) : name;
}

function filterRepoRefs(tree, query) {
  const local = (tree && Array.isArray(tree.local) ? tree.local : []).filter((b) => matchBranchQuery(b && b.name, query));
  const remote = (tree && Array.isArray(tree.remote) ? tree.remote : []).filter((b) => matchBranchQuery(b && b.name, query));
  const tags = (tree && Array.isArray(tree.tags) ? tree.tags : []).filter((b) => matchBranchQuery(b && b.name, query));
  const headName = (tree && tree.head) || "HEAD";
  const headMatch = matchBranchQuery("HEAD", query) || matchBranchQuery(headName, query);
  return { local, remote, tags, headMatch };
}

function branchNode(b, opts) {
  return {
    kind: "branch",
    name: opts.short || b.name,
    ref: b.name,
    current: opts.current === true,
    selected: opts.selected === true,
    remote: opts.remote === true
  };
}

/**
 * Stamp each commit with the repository it was read from, so a merged log
 * can show a repository column and open the right detail.
 * @param {Array|null|undefined} commits
 * @param {{path?: string, name?: string}|null|undefined} repo
 */
function decorateCommits(commits, repo) {
  const path = repo && repo.path ? repo.path : "";
  const name = (repo && repo.name) || path;
  const list = Array.isArray(commits) ? commits : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    out.push({ ...c, repoPath: path, repoName: name });
  }
  return out;
}

/**
 * Merge per-repository logs into one date-ordered list.
 * @param {Array<{repo?: {path?: string, name?: string}, commits?: Array}>|null|undefined} groups
 */
function mergeRepoCommits(groups) {
  const out = [];
  const list = Array.isArray(groups) ? groups : [];
  for (let i = 0; i < list.length; i++) {
    const group = list[i];
    const commits = decorateCommits(group && group.commits, group && group.repo);
    for (let j = 0; j < commits.length; j++) out.push(commits[j]);
  }
  out.sort((a, b) => {
    const dt = (Number(b.at) || 0) - (Number(a.at) || 0);
    if (dt !== 0) return dt;
    const an = String(a.repoName || "");
    const bn = String(b.repoName || "");
    if (an < bn) return -1;
    if (an > bn) return 1;
    return String(a.hash || "").localeCompare(String(b.hash || ""));
  });
  return out;
}

/**
 * Stable key for a commit row when the same hash can appear in more than one
 * repository.
 * @param {{hash?: string, repoPath?: string}|null|undefined} c
 */
function commitRowKey(c) {
  return (c && c.repoPath ? c.repoPath + "\0" : "") + (c && c.hash ? c.hash : "");
}

function repoEntryRefs(entry, group, nameMatched) {
  const filtered = nameMatched ? filterRepoRefs(entry.tree, "") : entry.filtered;
  if (group === "local") return filtered.local;
  if (group === "remote") return filtered.remote;
  if (group === "tags") return filtered.tags;
  return [];
}

/**
 * Whether a repository's refs are on screen.
 *
 * A doubly collapsed state — the top-level group closed while the repository
 * under it is open — used to drop the subtree silently. A click on a branch
 * was still possible there (the group header sits right above it), and the
 * reload that follows kept it out of the tree, so the panel looked frozen or
 * flickering for a moment. An open repository therefore keeps its group open.
 * @param {Record<string, boolean>|null|undefined} leftOpen
 * @param {string} path
 * @param {string} group
 */
function repoRefsShown(leftOpen, path, group) {
  if (!isGroupOpen(leftOpen, "", group)) return false;
  return isGroupOpen(leftOpen, path, group, true);
}

/**
 * Build the left-hand branch tree.
 *
 * Groups are the roots — HEAD, then Local / Remote / Tags — including the
 * single-repository case. Each group carries a repository node, and the
 * branches, remotes, or tags hang under it. The branch search query keeps
 * this shape and hides groups or repositories that have no matching ref
 * (unless the repository name itself matches).
 *
 * @param {Array<{path: string, name?: string}>|null|undefined} repos
 * @param {Record<string, {head?: string, local?: Array, remote?: Array, tags?: Array}>|null|undefined} treesByPath
 * @param {{currentPath?: string, logRepoPath?: string, selectedRef?: string, query?: string, leftOpen?: Record<string, boolean>, cache?: Map<string, Array>}} [opts]
 *   `cache` carries branch lists across calls: one whose content did not
 *   change is returned as the same array, and it is pruned to the repositories
 *   present in this build so a removed repository does not leak.
 */
function buildRepoBranchTree(repos, treesByPath, opts) {
  const list = Array.isArray(repos) ? repos : [];
  const trees = treesByPath && typeof treesByPath === "object" ? treesByPath : {};
  const options = opts || {};
  const currentPath = options.currentPath || "";
  const logRepoPath = options.logRepoPath !== undefined ? options.logRepoPath : "";
  const selectedRef = options.selectedRef || "";
  const query = options.query || "";
  const leftOpen = options.leftOpen || {};
  const searching = String(query).trim() !== "";
  const selectedHere = (path, ref) => {
    if (logRepoPath === "") return false;
    if (path !== logRepoPath) return false;
    return ref ? selectedRef === ref : (selectedRef === "" || selectedRef === "HEAD");
  };

  /**
   * A branch list with its current/selected flags folded in, compared by
   * content. Reusing the previous array when nothing moved keeps the render
   * quiet: the panel is rebuilt on every state poll, and a fresh list per repo
   * per tick is what made the left column repaint under the pointer.
   */
  const reusable = (key, next) => {
    current.add(key);
    const prev = cache.get(key);
    if (prev !== undefined && prev.length === next.length) {
      let same = true;
      for (let i = 0; i < next.length; i++) {
        const a = prev[i];
        const b = next[i];
        if (a.name !== b.name || a.current !== b.current || a.selected !== b.selected || a.remote !== b.remote) { same = false; break; }
      }
      if (same) return prev;
    }
    cache.set(key, next);
    return next;
  };
  const cache = options.cache instanceof Map ? options.cache : new Map();
  const current = new Set();

  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const repo = list[i];
    if (!repo || !repo.path) continue;
    const path = repo.path;
    const tree = trees[path] || {};
    const name = repo.name || path;
    const nameMatched = searching && (matchBranchQuery(name, query) || matchBranchQuery(path, query));
    const filtered = filterRepoRefs(tree, nameMatched ? "" : query);
    if (searching && !nameMatched && filtered.local.length === 0 && filtered.remote.length === 0 && filtered.tags.length === 0) {
      continue;
    }
    entries.push({
      path,
      name,
      tree,
      filtered,
      nameMatched,
      current: path === currentPath
    });
  }

  const repoNode = (entry, group, children) => ({
    kind: "repository",
    path: entry.path,
    name: entry.name,
    current: entry.current,
    selected: selectedHere(entry.path, ""),
    group,
    open: searching ? true : repoRefsShown(leftOpen, entry.path, group),
    head: entry.tree.head || "",
    children
  });

  const localRepos = [];
  const remoteRepos = [];
  const tagRepos = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const currentRemote = (b) => b.name === entry.tree.head || (entry.tree.local || []).some((l) => l && l.current && l.upstream === b.name);
    const local = reusable(entry.path + "\0local", repoEntryRefs(entry, "local", entry.nameMatched).map((b) => branchNode(b, { current: b.current === true, selected: selectedHere(entry.path, b.name) })));
    const remote = groupRemoteBranches(repoEntryRefs(entry, "remote", entry.nameMatched)).map((g) => ({
      kind: "remote",
      name: g.name,
      children: reusable(entry.path + "\0remote\0" + g.name, g.branches.map((b) => branchNode(b, { short: shortRemoteName(b.name, g.name), current: currentRemote(b), selected: selectedHere(entry.path, b.name), remote: true })))
    }));
    const tags = reusable(entry.path + "\0tags", repoEntryRefs(entry, "tags", entry.nameMatched).map((b) => branchNode(b, { selected: selectedHere(entry.path, b.name) })));
    if (local.length > 0) localRepos.push(repoNode(entry, "local", local));
    if (remote.length > 0) remoteRepos.push(repoNode(entry, "remote", remote));
    if (tags.length > 0) tagRepos.push(repoNode(entry, "tags", tags));
  }

  const groupNode = (id, children, fallbackOpen) => ({
    kind: "group",
    id,
    open: searching ? true : isGroupOpen(leftOpen, "", id, fallbackOpen),
    children
  });

  const out = [];
  if (!searching) {
    out.push({
      kind: "head",
      ref: "",
      selected: logRepoPath === "" && (selectedRef === "" || selectedRef === "HEAD"),
      title: ""
    });
  }
  if (!searching || localRepos.length > 0) out.push(groupNode("local", localRepos, true));
  if (!searching || remoteRepos.length > 0) out.push(groupNode("remote", remoteRepos, true));
  if (!searching || tagRepos.length > 0) out.push(groupNode("tags", tagRepos, false));
  for (const key of Array.from(cache.keys())) {
    if (!current.has(key)) cache.delete(key);
  }
  return out;
}

/**
 * Whether the live HEAD / local / remote / tags fields may be merged onto
 * the repository at `currentPath`.
 *
 * Those fields come from the last completed state fetch and belong to `cwd`.
 * A click on another repository writes `repoPath` (and, once `load` starts,
 * `cwd`) before the new lists arrive, while `loading` is true; merging in
 * that window would briefly paint the previous repository's branches under
 * the one just selected.
 * @param {{currentPath?: string, cwd?: string, loading?: boolean}|null|undefined} state
 */
function liveRepoTreeApplies(state) {
  const currentPath = state && state.currentPath ? state.currentPath : "";
  if (!currentPath) return false;
  if (state && state.loading === true) return false;
  return (state && state.cwd ? state.cwd : "") === currentPath;
}

/**
 * Stored tree for `currentPath`, overlaid with live lists only when they
 * belong to that repository. Otherwise the stored entry is returned as-is
 * so a cross-repo selection cannot rewrite its children.
 * @param {object|null|undefined} stored
 * @param {{head?: string, local?: Array, remote?: Array, tags?: Array}|null|undefined} live
 * @param {{currentPath?: string, cwd?: string, loading?: boolean}|null|undefined} state
 */
function mergeLiveRepoTree(stored, live, state) {
  if (!liveRepoTreeApplies(state)) return stored;
  const prior = stored && typeof stored === "object" ? stored : {};
  const src = live && typeof live === "object" ? live : {};
  return {
    ...prior,
    head: src.head || prior.head || "",
    local: src.local || [],
    remote: src.remote || [],
    tags: src.tags !== undefined ? src.tags : (prior.tags || [])
  };
}

/**
 * Fields whose reference change is a structural left-tree change.
 * Selection — `selectedRef`, `logRepoPath`, `repoPath`, `treeShown` — is
 * not listed: those only flip flags the portal patches in place.
 */
const TREE_STRUCTURE_KEYS = ["repos", "tags"];

/**
 * Next `treeVersion` after a data write. Returns the incoming version when
 * the caller already bumped it, otherwise bumps only when structural
 * fields moved (repository list, tag list, or a `repoTrees` entry).
 * @param {{treeVersion?: number, repos?: *, tags?: *, repoTrees?: object}|null|undefined} prev
 * @param {{treeVersion?: number, repos?: *, tags?: *, repoTrees?: object}|null|undefined} next
 */
function nextTreeVersion(prev, next) {
  const incoming = next || {};
  const prior = prev || {};
  if (incoming.treeVersion !== prior.treeVersion) return incoming.treeVersion || 0;
  let dirty = false;
  for (let i = 0; i < TREE_STRUCTURE_KEYS.length; i++) {
    if (incoming[TREE_STRUCTURE_KEYS[i]] !== prior[TREE_STRUCTURE_KEYS[i]]) { dirty = true; break; }
  }
  if (!dirty && incoming.repoTrees !== prior.repoTrees) {
    const a = incoming.repoTrees || {};
    const b = prior.repoTrees || {};
    const paths = Object.keys(a);
    if (paths.length !== Object.keys(b).length) dirty = true;
    for (let i = 0; !dirty && i < paths.length; i++) {
      if (a[paths[i]] !== b[paths[i]]) dirty = true;
    }
  }
  return dirty ? (prior.treeVersion || 0) + 1 : (prior.treeVersion || 0);
}

/**
 * Fingerprint of one repository's tree as drawn. The stored entry's identity
 * covers a reused map; head and list lengths cover a live overlay so a
 * freshly allocated object with the same content does not look new.
 * @param {string} path
 * @param {object|null|undefined} stored
 * @param {object|null|undefined} used
 * @param {function(*): string} refId
 */
function repoTreeDepKey(path, stored, used, refId) {
  const drawn = used !== undefined ? used : stored;
  const id = typeof refId === "function" ? refId(stored) : (stored ? "s" : "none");
  if (!drawn) return [path, id].join("\0");
  return [path, id, drawn.head || "", (drawn.local || []).length, (drawn.remote || []).length].join("\0");
}

/**
 * Whether the left-tree portal may skip `render`.
 *
 * The commit dialog unmounts `.dgit-btree`. A root still bound to that
 * previous host (or already torn down) must not skip: the new host is
 * empty, and painting into the detached root leaves the column blank.
 * @param {Element|null|undefined} mount
 * @param {Element|null|undefined} rootMount the node `createRoot` was called on
 * @param {Array|null|undefined} painted
 * @param {Array|null|undefined} next
 */
function btreePaintIsCurrent(mount, rootMount, painted, next) {
  if (!mount || mount !== rootMount) return false;
  if (!painted || !next || next.length !== painted.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== painted[i]) return false;
  }
  return true;
}
/* @branch-tree-end */

export {
  buildRepoBranchTree,
  commitRowKey,
  decorateCommits,
  groupOpenKey,
  groupRemoteBranches,
  isGroupOpen,
  liveRepoTreeApplies,
  matchBranchQuery,
  mergeLiveRepoTree,
  mergeRepoCommits,
  nextTreeVersion,
  refLoadOptions,
  repoRefsShown,
  repoTreeDepKey,
  btreePaintIsCurrent
};
