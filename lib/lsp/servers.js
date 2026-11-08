import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

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
  java: {
    command: "jdtls",
    args: [],
    languages: ["java"],
    rootFiles: ["pom.xml", "build.gradle", "build.gradle.kts", ".project"]
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
 * Find suitable server for a language.
 * @param {string} language
 * @returns {object|null}
 */
export function serverFor(language) {
  for (const [id, server] of Object.entries(SERVERS)) {
    if (server.languages.includes(language)) {
      return { id, ...server };
    }
  }
  return null;
}

/** Cache for command existence checks: command -> { found, at } */
const commandCache = new Map();
/** A negative answer goes stale quickly: the server may just have been installed. */
const NEGATIVE_TTL_MS = 30000;

/**
 * Check if a command exists in PATH. Positive results are cached for the
 * process lifetime; negative results are re-checked after 30s so installing a
 * language server takes effect without a DSH restart.
 * @param {string} command
 * @returns {Promise<boolean>}
 */
export async function commandExists(command) {
  const hit = commandCache.get(command);
  if (hit !== undefined && (hit.found || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.found;

  const pathEnv = process.env.PATH || "";
  const paths = pathEnv.split(delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  let found = false;
  for (const dir of paths) {
    for (const ext of extensions) {
      const full = join(dir, command + ext);
      try {
        await access(full, constants.X_OK);
        found = true;
        break;
      } catch {
        // Continue
      }
    }
    if (found) break;
  }

  commandCache.set(command, { found, at: Date.now() });
  return found;
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
  const proc = spawn(server.command, server.args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env }
  });
  return proc;
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
