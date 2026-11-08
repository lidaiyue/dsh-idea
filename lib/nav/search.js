import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { SKIP, MAX_SOURCE_BYTES, basenameOf, pathWithin, walk } from "./walk.js";

export const SEARCH_MAX_MATCHES = 300;
export const SEARCH_MAX_PER_FILE = 12;
export const SEARCH_MAX_LINE = 500;
export const SEARCH_MAX_RANGES = 20;
export const MAX_SEARCH_QUERY = 2000;
export const SEARCH_MAX_FILE_BYTES = MAX_SOURCE_BYTES;
export const SEARCH_TIMEOUT_MS = 15000;
const SEARCH_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SEARCH_CLIP_END = SEARCH_MAX_LINE;

// Credentials live in well-known filenames. They are excluded from both engines
// on top of ripgrep's own ignore handling, so a content search cannot echo a
// secret into the browser from a repository that never wrote a .gitignore.
// The tables live in ../secret.js because the file routes need the same answer.
import { SECRET_DIR_NAMES, SECRET_FILE_EXTENSIONS, SECRET_FILE_NAMES, isSecretFile, isSecretPath } from "../secret.js";

export { isSecretFile, isSecretPath };

export const SEARCH_SKIP_GLOBS = [];
for (const dir of Object.keys(SKIP)) {
  if (dir === ".DS_Store") continue;
  SEARCH_SKIP_GLOBS.push("!**/" + dir + "/**");
}
for (const name of SECRET_FILE_NAMES) SEARCH_SKIP_GLOBS.push("!**/" + name);
SEARCH_SKIP_GLOBS.push("!**/.env.*");
for (const ext of SECRET_FILE_EXTENSIONS) SEARCH_SKIP_GLOBS.push("!**/*." + ext);
for (const dir of SECRET_DIR_NAMES) SEARCH_SKIP_GLOBS.push("!**/" + dir + "/**");

function isAscii(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}

export function byteOffsetToStringIndex(text, byteOffset) {
  if (byteOffset <= 0) return 0;
  if (isAscii(text)) return Math.min(byteOffset, text.length);
  const buf = Buffer.from(text, "utf8");
  if (byteOffset >= buf.length) return text.length;
  return buf.subarray(0, byteOffset).toString("utf8").length;
}

export function clipLine(text) {
  const line = String(text == null ? "" : text).replace(/\r?\n$/, "");
  if (line.length <= SEARCH_MAX_LINE) return line;
  return line.slice(0, SEARCH_MAX_LINE) + "…";
}

let rgPathPromise;
export function rgBinaryPath() {
  if (rgPathPromise !== undefined) return rgPathPromise;
  const bases = [];
  const push = (value) => {
    if (typeof value === "string" && value !== "" && !bases.includes(value)) bases.push(value);
  };
  for (const raw of [process.argv[1], process.execPath]) {
    if (typeof raw !== "string" || raw === "") continue;
    push(raw);
    let real = raw;
    try { real = realpathSync(raw); } catch {}
    push(real);
    for (const start of [raw, real]) {
      let dir = dirname(start);
      for (let i = 0; i < 6 && dir !== "" && dir !== "/"; i += 1) {
        push(dir);
        dir = dirname(dir);
      }
    }
  }
  const work = (async () => {
    try {
      const direct = await import("@vscode/ripgrep");
      if (typeof direct.rgPath === "string" && direct.rgPath !== "") return direct.rgPath;
    } catch {}
    for (const base of bases) {
      try {
        const require = createRequire(base);
        const resolved = require.resolve("@vscode/ripgrep");
        const mod = await import(pathToFileURL(resolved).href);
        if (typeof mod.rgPath === "string" && mod.rgPath !== "") return mod.rgPath;
      } catch {}
    }
    return null;
  })();
  rgPathPromise = work.then((path) => {
    if (path === null) rgPathPromise = undefined;
    return path;
  });
  return rgPathPromise;
}

function isExecutableFile(path) {
  try {
    return typeof path === "string" && path !== "" && existsSync(path);
  } catch {
    return false;
  }
}

export function runRipgrep(binary, cwd, pattern, ignoreCase, regex) {
  return new Promise((resolve) => {
    if (!isExecutableFile(binary)) {
      resolve({ stdout: "", timedOut: false, failed: true, exitCode: 0 });
      return;
    }
    const argv = [
      "--no-config",
      "--json",
      "--max-count", String(SEARCH_MAX_PER_FILE),
      "--max-filesize", String(SEARCH_MAX_FILE_BYTES),
      "--hidden",
      "--no-require-git",
      "--no-messages"
    ];
    // `.gitignore` stays in force. `--no-ignore` used to be passed here and made
    // a content search echo exactly the files a repository declared private
    // (verified: `.env`, `*.pem` and `secrets/` all came back in results), which
    // the browser then renders. Skipping ignored files still leaves untracked
    // files searchable, and `SEARCH_SKIP_GLOBS` below covers credentials in
    // workspaces that have no ignore file at all. `--no-require-git` applies the
    // same ignore files to a workspace that is not a git repository, which is
    // ripgrep's default only inside one.
    for (const glob of SEARCH_SKIP_GLOBS) argv.push("--glob", glob);
    if (ignoreCase) argv.push("-i");
    if (regex !== true) argv.push("-F");
    argv.push("-e", pattern);
    let child;
    try {
      child = spawn(binary, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ stdout: "", timedOut: false, failed: true, exitCode: 0 });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer = 0;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const collect = () => Buffer.concat(chunks).toString("utf8");
    const kill = () => {
      try { child.kill("SIGKILL"); } catch {}
    };
    timer = setTimeout(() => {
      kill();
      settle({ stdout: collect(), timedOut: true, failed: false, exitCode: 0 });
    }, SEARCH_TIMEOUT_MS);
    child.on("error", () => settle({ stdout: "", timedOut: false, failed: true, exitCode: 0 }));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > SEARCH_MAX_OUTPUT_BYTES) {
        kill();
        settle({ stdout: collect(), timedOut: true, failed: false, exitCode: 0 });
      }
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 0;
      if (exitCode === 0 || exitCode === 1) {
        settle({ stdout: collect(), timedOut: false, failed: false, exitCode });
        return;
      }
      settle({ stdout: "", timedOut: false, failed: true, exitCode });
    });
  });
}

export function parseRgJson(stdout, root, maxMatches) {
  const matches = [];
  const seen = new Set();
  let truncated = false;
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === "" || raw.charCodeAt(0) !== 123) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event === null || event.type !== "match" || event.data === undefined || event.data === null) continue;
    const data = event.data;
    const printed = data.path === undefined || data.path === null ? undefined : data.path.text;
    if (typeof printed !== "string" || printed === "") continue;
    const abs = isAbsolute(printed) ? printed : resolvePath(root, printed);
    const lineNumber = typeof data.line_number === "number" ? data.line_number : 0;
    const key = abs + "\0" + lineNumber;
    if (seen.has(key)) continue;
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    seen.add(key);
    const rawLine = data.lines === undefined || data.lines === null || typeof data.lines.text !== "string" ? "" : data.lines.text;
    const body = rawLine.replace(/\r?\n$/, "");
    const text = clipLine(rawLine);
    const clipped = body.length > SEARCH_MAX_LINE;
    const limit = clipped ? SEARCH_CLIP_END : body.length;
    const subs = Array.isArray(data.submatches) ? data.submatches : [];
    const ranges = [];
    // `isAscii` scans the whole line, so it is resolved once per line instead of
    // once per submatch. A minified single-line file can carry tens of thousands
    // of submatches; testing the line inside the loop made parsing quadratic
    // (measured: 4.5 minutes of blocked event loop for one 630 KB line).
    const ascii = isAscii(rawLine);
    for (let s = 0; s < subs.length && ranges.length < SEARCH_MAX_RANGES; s++) {
      const sub = subs[s];
      if (sub === null || sub === undefined || sub.match === undefined || sub.match === null || typeof sub.match.text !== "string") continue;
      const start = typeof sub.start === "number" ? sub.start : -1;
      const end = typeof sub.end === "number" ? sub.end : -1;
      if (start < 0 || end <= start) continue;
      const from = ascii ? Math.min(start, rawLine.length) : byteOffsetToStringIndex(rawLine, start);
      const spot = Math.min(from, limit);
      const stop = Math.min(ascii ? Math.min(end, rawLine.length) : byteOffsetToStringIndex(rawLine, end), limit);
      if (spot >= limit || stop <= spot) continue;
      ranges.push([spot, stop]);
    }
    matches.push({
      kind: "content",
      path: abs,
      rel: pathWithin(root, abs),
      name: basenameOf(abs),
      line: lineNumber,
      text,
      ranges,
      clipped
    });
  }
  return { matches, truncated };
}

export async function searchWithoutRipgrep(root, query, ignoreCase, signal) {
  const files = [];
  await walk(root, "", files);
  const matches = [];
  const needle = ignoreCase ? query.toLowerCase() : query;
  let truncated = false;
  for (let f = 0; f < files.length; f++) {
    if (signal !== undefined && signal.aborted) break;
    if (matches.length >= SEARCH_MAX_MATCHES) {
      truncated = true;
      break;
    }
    const file = files[f];
    if (isSecretFile(file.name) || isSecretPath(file.rel)) continue;
    let st;
    try {
      st = await stat(file.path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0 || st.size > SEARCH_MAX_FILE_BYTES) continue;
    let text;
    try {
      text = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (text.indexOf("\0") >= 0) continue;
    const rows = text.split("\n");
    let kept = 0;
    for (let i = 0; i < rows.length && kept < SEARCH_MAX_PER_FILE; i++) {
      if (matches.length >= SEARCH_MAX_MATCHES) {
        truncated = true;
        break;
      }
      const row = rows[i];
      const hay = ignoreCase ? row.toLowerCase() : row;
      let at = hay.indexOf(needle);
      if (at < 0) continue;
      const clipped = row.length > SEARCH_MAX_LINE;
      const limit = clipped ? SEARCH_CLIP_END : row.length;
      const ranges = [];
      while (at >= 0 && ranges.length < SEARCH_MAX_RANGES) {
        if (at >= limit) break;
        ranges.push([at, Math.min(at + needle.length, limit)]);
        at = hay.indexOf(needle, at + Math.max(needle.length, 1));
      }
      matches.push({
        kind: "content",
        path: file.path,
        rel: file.rel,
        name: file.name,
        line: i + 1,
        text: clipLine(row),
        ranges,
        clipped
      });
      kept += 1;
    }
  }
  return { matches, truncated };
}
