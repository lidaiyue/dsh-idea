import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Language server definitions.
 * Each entry: { command, args, languages, rootFiles }
 */
export const SERVERS = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
    rootFiles: ["tsconfig.json", "jsconfig.json", "package.json"]
  },
  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: ["python"],
    rootFiles: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]
  },
  pylsp: {
    command: "pylsp",
    args: [],
    languages: ["python"],
    rootFiles: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
    rootFiles: ["Cargo.toml", "rust-project.json"]
  },
  go: {
    command: "gopls",
    args: ["serve"],
    languages: ["go"],
    rootFiles: ["go.mod", "go.work"]
  },
  clangd: {
    command: "clangd",
    args: [],
    languages: ["c", "cpp", "objective-c", "objective-cpp"],
    rootFiles: ["compile_commands.json", "compile_flags.txt", ".clangd"]
  },
  "java-index": {
    command: "jindex",
    args: [],
    languages: ["java"],
    rootFiles: ["pom.xml", "build.gradle", "build.gradle.kts", ".git"]
  },
  lua: {
    command: "lua-language-server",
    args: [],
    languages: ["lua"],
    rootFiles: [".luarc.json", ".luarc.jsonc"]
  }
};

/** Map file extension to language id */
export const EXT_TO_LANG = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".java": "java",
  ".lua": "lua"
};

/**
 * Detect language from file path.
 * @param {string} filePath
 * @returns {string|null}
 */
export function languageOf(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXT_TO_LANG[ext] || null;
}

/**
 * All servers that handle a language, preferred first.
 * @param {string} language
 * @returns {object[]}
 */
export function serversFor(language) {
  const out = [];
  for (const [id, server] of Object.entries(SERVERS)) {
    if (server.languages.includes(language)) {
      out.push({ id, ...server });
    }
  }
  return out;
}

/**
 * Preferred server for a language, whether or not its command is installed.
 * Use resolveServer() to pick the first one actually on PATH.
 * @param {string} language
 * @returns {object|null}
 */
export function serverFor(language) {
  return serversFor(language)[0] || null;
}

/**
 * First server for a language whose command is on PATH (or in a well-known
 * user bin directory, even when the host process PATH is minimal).
 * @param {string} language
 * @returns {Promise<object|null>}
 */
export async function resolveServer(language) {
  for (const server of serversFor(language)) {
    const commandPath = await resolveCommand(server.command);
    if (commandPath) return { ...server, commandPath };
  }
  return null;
}

/** Cache for command existence checks: command -> { path, at } */
const commandCache = new Map();
/** A negative answer goes stale quickly: the server may just have been installed. */
const NEGATIVE_TTL_MS = 30000;

/** Test-only: when true, only process.env.PATH is searched. */
let strictCommandPath = false;

/**
 * Restrict command lookup to process.env.PATH. Used by tests that isolate PATH.
 * @param {boolean} on
 */
export function setStrictCommandPath(on) {
  strictCommandPath = Boolean(on);
  clearCommandCache();
}

/**
 * Directories that GUI/launchd processes often omit from PATH.
 * @returns {string[]}
 */
export function extraBinDirs() {
  const home = process.env.HOME || homedir();
  if (!home) return [];
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".cargo", "bin"),
    join(home, "go", "bin"),
    join(home, ".npm-global", "bin")
  ];
}

/**
 * PATH plus well-known user bin dirs, deduplicated, PATH entries first.
 * @returns {string[]}
 */
export function commandSearchDirs() {
  const seen = new Set();
  const dirs = [];
  const add = (dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  for (const dir of (process.env.PATH || "").split(delimiter)) add(dir);
  if (!strictCommandPath) {
    for (const dir of extraBinDirs()) add(dir);
  }
  return dirs;
}

/**
 * PATH value used when spawning a language server, so it can find helpers
 * (java, git, etc.) even if the host was started with a short PATH.
 * @returns {string}
 */
export function augmentedPath() {
  return commandSearchDirs().join(delimiter);
}

/**
 * Resolve a command to an executable path, or null if it is not found.
 * Positive results are cached for the process lifetime; negative results are
 * re-checked after 30s so installing a language server takes effect without
 * a DSH restart.
 * @param {string} command
 * @returns {Promise<string|null>}
 */
export async function resolveCommand(command) {
  const hit = commandCache.get(command);
  if (hit !== undefined && (hit.path || Date.now() - hit.at < NEGATIVE_TTL_MS)) {
    return hit.path;
  }

  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  let found = null;
  for (const dir of commandSearchDirs()) {
    for (const ext of extensions) {
      const full = join(dir, command + ext);
      try {
        await access(full, constants.X_OK);
        found = full;
        break;
      } catch {
        // Continue
      }
    }
    if (found) break;
  }

  commandCache.set(command, { path: found, at: Date.now() });
  return found;
}

/**
 * Check if a command exists in the search path.
 * @param {string} command
 * @returns {Promise<boolean>}
 */
export async function commandExists(command) {
  return (await resolveCommand(command)) !== null;
}

/** Clear command cache (for testing) */
export function clearCommandCache() {
  commandCache.clear();
}

/**
 * Spawn a language server process.
 * @param {object} server - Server config
 * @param {string} root - Workspace root
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnServer(server, root) {
  const command = server.commandPath || server.command;
  const proc = spawn(command, server.args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: augmentedPath() }
  });
  return proc;
}

function insideDir(root, target) {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return false;
  return true;
}

/**
 * Walk up from a file looking for a language's rootFiles.
 * When the file sits inside the DSH workspace, the walk stops at that
 * workspace root. Otherwise it stops at the filesystem root. If no
 * rootFile is found, fall back to the DSH workspace root.
 * @param {string} filePath
 * @param {string[]|undefined} rootFiles
 * @param {string} workspaceRoot
 * @returns {Promise<string>}
 */
export async function findProjectRoot(filePath, rootFiles, workspaceRoot) {
  const names = Array.isArray(rootFiles)
    ? rootFiles.filter((name) => typeof name === "string" && name !== "" && !name.includes("/") && !name.includes("\\"))
    : [];
  const start = resolve(dirname(filePath));
  const workspace = typeof workspaceRoot === "string" && workspaceRoot !== ""
    ? resolve(workspaceRoot)
    : null;
  const stayInside = workspace !== null && insideDir(workspace, start);

  let dir = start;
  for (;;) {
    for (const name of names) {
      try {
        await access(join(dir, name), constants.F_OK);
        return dir;
      } catch {
        // keep walking
      }
    }
    if (stayInside && dir === workspace) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (stayInside && !insideDir(workspace, parent)) break;
    dir = parent;
  }
  return workspace || start;
}

/**
 * Convert filesystem path to file:// URI.
 * Handles Windows paths correctly.
 * @param {string} path
 * @returns {string}
 */
export function pathToUri(path) {
  let normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = "/" + normalized;
  }
  return "file://" + normalized.split("/").map(encodeURIComponent).join("/");
}
