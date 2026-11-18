import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Where a project keeps its run configurations, relative to the workspace root. */
export const CONFIG_REL = join(".dsh", "run.json");

const MODES = ["read-only", "workspace-write", "danger-full-access"];

/** A configuration file that exists but cannot be used; `code` is the machine-readable reason. */
export class ConfigError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.code = code;
  }
}

/** True when `target` is `root` or a path inside it (after lexical resolve). */
function insideRoot(root, target) {
  if (typeof root !== "string" || typeof target !== "string" || target === "") return false;
  const rel = relative(root, target);
  if (rel === "") return true;
  return !isAbsolute(rel) && !rel.split(sep).some((part) => part === "..");
}

/**
 * Well-known package-manager caches under the home directory, plus any path
 * already inside the workspace. A run.json must not use this to punch a
 * writable hole at `/` or another arbitrary location.
 */
const HOME_CACHES = [".m2", ".gradle", ".pnpm-store", ".npm", ".yarn", ".cache", join(".local", "share")];

function allowedWritableRoot(root, path) {
  if (insideRoot(root, path)) return true;
  const home = homedir();
  for (const name of HOME_CACHES) {
    const base = join(home, name);
    if (insideRoot(base, path) || path === base) return true;
  }
  return false;
}

/** Expand a leading `~`, then resolve a relative path against the project root. */
function expand(value, root) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) return undefined;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_KEY_BLOCKED = /^(?:__proto__|prototype|constructor)$/i;

/** Environment overrides: a flat object of string values, nothing else. */
function environmentOf(raw, where) {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config-entry-env", where);
  const env = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    const value = raw[key];
    if (!ENV_KEY.test(key) || ENV_KEY_BLOCKED.test(key)) throw new ConfigError("config-entry-env", `${where}.env.${key}`);
    if (typeof value !== "string") throw new ConfigError("config-entry-env", `${where}.env.${key}`);
    env[key] = value;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

function writableRootsOf(raw, root, where) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ConfigError("config-entry-writable-roots", where);
  const roots = [];
  for (const value of raw) {
    const path = expand(value, root);
    if (path === undefined || !allowedWritableRoot(root, path)) {
      throw new ConfigError("config-entry-writable-roots", where);
    }
    roots.push(path);
  }
  return roots.length === 0 ? undefined : roots;
}

/**
 * Validate one `runs[]` entry.
 *
 * `id` defaults to `name`, so the common file stays five lines per application.
 * The sandbox mode defaults to `workspace-write` scoped to the project root: a
 * run configuration executes its own project, not the Harness process directory.
 */
function cwdOf(value, root, where) {
  if (value === undefined || value === "") return root;
  const path = expand(value, root);
  if (path === undefined || !insideRoot(root, path)) throw new ConfigError("config-entry-cwd", `${where}.cwd`);
  return path;
}

function entryOf(raw, root, index) {
  const where = `runs[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config-entry-invalid", where);
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : undefined;
  const command = typeof raw.command === "string" && raw.command.trim() !== "" ? raw.command.trim() : undefined;
  if (name === undefined) throw new ConfigError("config-entry-name", where);
  if (command === undefined) throw new ConfigError("config-entry-command", where);
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : name;
  const mode = raw.sandbox === undefined ? "workspace-write" : raw.sandbox;
  if (!MODES.includes(mode)) throw new ConfigError("config-entry-sandbox", `${where}.sandbox`);
  const port = raw.port === undefined ? undefined : Number(raw.port);
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new ConfigError("config-entry-port", `${where}.port`);
  }
  if (raw.autoRestart !== undefined && raw.autoRestart !== true && raw.autoRestart !== false) {
    throw new ConfigError("config-entry-auto-restart", `${where}.autoRestart`);
  }
  return {
    id,
    name,
    command,
    cwd: cwdOf(raw.cwd, root, where),
    sandbox: mode,
    ...(port === undefined ? {} : { port }),
    source: "run.json",
    ...(raw.env === undefined ? {} : { env: environmentOf(raw.env, where) }),
    ...(raw.writableRoots === undefined ? {} : { writableRoots: writableRootsOf(raw.writableRoots, root, where) }),
    ...(raw.autoRestart === true ? { autoRestart: true } : {})
  };
}

/**
 * Read and validate `<root>/.dsh/run.json`.
 *
 * A missing file is an empty list, not an error: a workspace that declares no
 * run configurations is the normal state. A file that exists and is wrong is an
 * error naming the offending entry, because silently running a partial set
 * would be worse than refusing to run any of them.
 *
 * @param root - absolute workspace root.
 * @returns the file path and its validated entries, in declaration order.
 */
export async function loadRuns(root) {
  const file = join(root, CONFIG_REL);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return { file, runs: [] };
    throw new ConfigError("config-unreadable", String(error && error.message ? error.message : error));
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new ConfigError("config-bad-json", file);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw new ConfigError("config-invalid", file);
  if (!Array.isArray(document.runs)) throw new ConfigError("config-missing-runs", file);
  const runs = [];
  const seen = new Set();
  for (let index = 0; index < document.runs.length; index += 1) {
    const entry = entryOf(document.runs[index], root, index);
    if (seen.has(entry.id)) throw new ConfigError("config-duplicate-id", entry.id);
    seen.add(entry.id);
    runs.push(entry);
  }
  return { file, runs };
}

/** A path written to `run.json`: relative to the project root when it lives inside it. */
function filePathOf(root, value) {
  if (typeof value !== "string" || value === "") return undefined;
  const rel = relative(root, value);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(home + "/") || value.startsWith(home + "\\")) {
    return "~/" + value.slice(home.length + 1).split("\\").join("/");
  }
  return value;
}

/**
 * The file-facing shape of a validated entry.
 *
 * `cwd` goes back to a root-relative path because `loadRuns` expands it on the
 * way in. Default sandbox and a cwd that is the project root are omitted so a
 * typical entry stays short. `id` is always written, even when it equals
 * `name`, so a later rename cannot change the identifier discovery already used.
 */
function serialize(entry, root) {
  const cwd = filePathOf(root, entry.cwd);
  const out = { id: entry.id, name: entry.name, command: entry.command };
  if (cwd !== undefined && cwd !== ".") out.cwd = cwd;
  if (entry.sandbox !== "workspace-write") out.sandbox = entry.sandbox;
  if (entry.port !== undefined) out.port = entry.port;
  if (entry.env !== undefined) out.env = entry.env;
  if (entry.writableRoots !== undefined) {
    out.writableRoots = entry.writableRoots.map((path) => filePathOf(root, path)).filter((path) => path !== undefined);
    if (out.writableRoots.length === 0) delete out.writableRoots;
  }
  if (entry.autoRestart === true) out.autoRestart = true;
  return out;
}

/**
 * Overlay an incoming edit onto a baseline entry, keeping omitted fields.
 *
 * `port` or `env` sent as `null` (or an empty env object) clears the field;
 * leaving it off preserves whatever the baseline already had. `autoRestart`
 * sent as `false` clears the flag the same way. The baseline id always wins,
 * so a discovered id such as `maven:api` stays stable.
 */
function overlay(baseline, incoming) {
  const out = { ...baseline };
  if (incoming.name !== undefined) out.name = incoming.name;
  if (incoming.command !== undefined) out.command = incoming.command;
  if (incoming.cwd !== undefined) out.cwd = incoming.cwd;
  if (incoming.sandbox !== undefined) out.sandbox = incoming.sandbox;
  if (incoming.writableRoots !== undefined) out.writableRoots = incoming.writableRoots;
  if (incoming.port === null || incoming.port === "") delete out.port;
  else if (incoming.port !== undefined) out.port = incoming.port;
  if (incoming.env === null || (incoming.env !== undefined && typeof incoming.env === "object" && !Array.isArray(incoming.env) && Object.keys(incoming.env).length === 0)) {
    delete out.env;
  } else if (incoming.env !== undefined) {
    out.env = incoming.env;
  }
  if (incoming.autoRestart === true) out.autoRestart = true;
  else if (incoming.autoRestart === false) delete out.autoRestart;
  if (baseline.id !== undefined) out.id = baseline.id;
  else if (typeof incoming.id === "string" && incoming.id.trim() !== "") out.id = incoming.id.trim();
  return out;
}

/**
 * Validate `runs` and write them to `<root>/.dsh/run.json`.
 *
 * Entries are checked with the same `entryOf` rules as a load, and a failure
 * leaves the existing file untouched. The directory is created when needed.
 *
 * @param root - absolute workspace root.
 * @param runs - entries to persist, in declaration order.
 * @returns the file path and the validated entries, with paths expanded.
 */
export async function saveRuns(root, runs) {
  if (!Array.isArray(runs)) throw new ConfigError("config-missing-runs");
  const validated = [];
  const seen = new Set();
  for (let index = 0; index < runs.length; index += 1) {
    const entry = entryOf(runs[index], root, index);
    if (seen.has(entry.id)) throw new ConfigError("config-duplicate-id", entry.id);
    seen.add(entry.id);
    validated.push(entry);
  }
  const file = join(root, CONFIG_REL);
  await mkdir(join(root, ".dsh"), { recursive: true });
  const body = JSON.stringify({ runs: validated.map((entry) => serialize(entry, root)) }, null, 2) + "\n";
  await writeFile(file, body, "utf8");
  return { file, runs: validated };
}

/**
 * Insert or replace one entry in `.dsh/run.json` by its original id.
 *
 * `baseline` is the entry as the panel currently sees it (a file declaration or
 * a discovered configuration). Using it as the starting point keeps fields the
 * form does not edit, such as `writableRoots` on a Maven run.
 *
 * @param root - absolute workspace root.
 * @param incoming - fields to apply; `id` is required to match the existing row.
 * @param baseline - the current merged entry, when one exists.
 * @returns the file path and every validated file entry after the write.
 */
export async function upsertRun(root, incoming, baseline) {
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw new ConfigError("config-entry-invalid", "runs[0]");
  }
  const current = await loadRuns(root);
  const id = typeof incoming.id === "string" && incoming.id.trim() !== ""
    ? incoming.id.trim()
    : (baseline !== undefined && typeof baseline.id === "string" ? baseline.id : undefined);
  if (id === undefined) throw new ConfigError("config-entry-name", "runs[0]");
  const index = current.runs.findIndex((row) => row.id === id);
  const fromFile = index >= 0 ? current.runs[index] : undefined;
  const start = baseline !== undefined ? baseline : fromFile !== undefined ? fromFile : { id };
  const merged = overlay(start, { ...incoming, id });
  merged.id = id;
  const next = current.runs.slice();
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  return saveRuns(root, next);
}
