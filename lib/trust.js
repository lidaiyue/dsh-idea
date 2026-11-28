import { realpath } from "node:fs/promises";
import { delimiter, resolve, sep } from "node:path";

/**
 * Workspace boundary for the request-supplied `cwd`.
 *
 * Every file, nav, git, run and database route takes a `cwd` from the request
 * body and treats it as the tree it may read, overwrite or recursively delete.
 * Nothing else in the plugin checks that the directory belongs to this host:
 * `rootOf` only demands an existing absolute directory, so a caller that passes
 * the connection fence could name `/Users/<user>` and delete `Documents`.
 *
 * The host already knows which directories it owns — the Workspace registry,
 * the live Sessions' working directories, and the sandbox policy's roots. A
 * request is accepted only when its `cwd` is one of those roots or sits under
 * one. Nested roots are allowed on purpose: a repository can live inside the
 * workspace directory the user opened.
 */

/** Roots are re-read at most this often; a new session must not wait a minute. */
const CACHE_MS = 1000;

/** Absolute POSIX or Windows path, mirroring `lib/http.js:isAbs`. */
function isAbsPath(value) {
  return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

function pushRoot(list, value) {
  if (isAbsPath(value)) list.push(resolve(value));
}

/** The directories the host has opened as Workspaces. */
function registryRoots(ctx, list) {
  try {
    const registry = ctx.get("workspaceRegistry");
    if (registry !== undefined && typeof registry.list === "function") {
      for (const workspace of registry.list()) {
        pushRoot(list, workspace && (workspace.path ?? workspace.directory ?? workspace.cwd));
      }
      return true;
    }
  } catch {}
  try {
    const controller = ctx.get("workspaceController");
    if (controller !== undefined && typeof controller.list === "function") {
      for (const workspace of controller.list()) {
        pushRoot(list, workspace && (workspace.path ?? workspace.directory ?? workspace.cwd));
      }
      return true;
    }
  } catch {}
  return false;
}

/** The working directory of every live Session. */
function sessionRoots(ctx, list) {
  let found = false;
  try {
    const sessions = ctx.get("sessions");
    if (sessions === undefined || typeof sessions.list !== "function") return false;
    found = true;
    let workingDirectory;
    try { workingDirectory = ctx.get("workingDirectory"); } catch { workingDirectory = undefined; }
    for (const session of sessions.list()) {
      if (session === undefined || session === null) continue;
      let cwd;
      if (workingDirectory !== undefined && typeof workingDirectory.get === "function") {
        try { cwd = workingDirectory.get(session); } catch {}
      }
      if (!isAbsPath(cwd)) cwd = session.cwd;
      if (!isAbsPath(cwd) && session.header !== undefined && session.header !== null) cwd = session.header.cwd;
      pushRoot(list, cwd);
    }
  } catch {}
  return found;
}

/** The deployment's own sandbox roots: the fallback and any extra writable one. */
function policyRoots(ctx, list) {
  try {
    const policy = ctx.get("sandboxPolicy");
    if (policy === undefined) return false;
    pushRoot(list, policy.workspaceRoot);
    if (Array.isArray(policy.additionalWritableRoots)) {
      for (const root of policy.additionalWritableRoots) pushRoot(list, root);
    }
    return true;
  } catch {
    return false;
  }
}

/** Operator escape hatch for a deployment whose roots come from somewhere else. */
function envRoots(list) {
  const raw = process.env.DSH_IDEA_EXTRA_ROOTS;
  if (typeof raw !== "string" || raw.trim() === "") return false;
  for (const part of raw.split(delimiter)) pushRoot(list, part);
  return true;
}

function within(root, target) {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * Build the gate for one plugin instance.
 *
 * @param {object} ctx - plugin context; the host services are read lazily so a
 *   composition that mounts this plugin before them still works.
 * @param {(message: string) => void} [warn] - one-shot diagnostics sink.
 * @returns {{ check: (cwd: unknown) => Promise<{ ok: boolean, error?: string }>, invalidate: () => void }}
 */
export function createWorkspaceGate(ctx, warn) {
  let cached = { at: 0, roots: [] };
  let warnedOpen = false;

  const collect = () => {
    const list = [];
    envRoots(list);
    registryRoots(ctx, list);
    sessionRoots(ctx, list);
    policyRoots(ctx, list);
    return [...new Set(list)];
  };

  const roots = () => {
    const now = Date.now();
    if (now - cached.at < CACHE_MS) return cached.roots;
    cached = { at: now, roots: collect() };
    return cached.roots;
  };

  return {
    invalidate() {
      cached = { at: 0, roots: [] };
    },
    async check(cwd) {
      if (!isAbsPath(cwd)) return { ok: false, error: "cwd-required" };
      const candidates = roots();
      if (candidates.length === 0) {
        // No registry, no live session and no sandbox policy: this host cannot
        // name its own workspaces, so the old absolute-path rule is all there
        // is. Say so once instead of failing every panel.
        if (!warnedOpen) {
          warnedOpen = true;
          if (typeof warn === "function") {
            warn("no workspace roots are visible to this host; cwd is only checked for absoluteness");
          }
        }
        return { ok: true };
      }
      let target;
      try { target = await realpath(resolve(cwd)); } catch { return { ok: false, error: "cwd-required" }; }
      for (const root of candidates) {
        let real;
        try { real = await realpath(root); } catch { continue; }
        // `/` would make every path a workspace, which is the bug this gate exists to close.
        if (real === sep) continue;
        if (within(real, target)) return { ok: true };
      }
      return { ok: false, error: "cwd-not-workspace" };
    }
  };
}
