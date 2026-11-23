import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { insideRoot, MAX_BYTES, resolveExternalFile } from "./files.js";
import { isForbiddenPath } from "./secret.js";

/** Max characters of a source line kept on a symbol location. */
export const SNIPPET_MAX = 200;

/** `file:` URI to a filesystem path, or null. */
export function fileUriPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  let parsed;
  try { parsed = new URL(uri); } catch { return null; }
  if (parsed.protocol !== "file:") return null;
  let path = decodeURIComponent(parsed.pathname);
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (path === "") return null;
  return path;
}

/**
 * Keep file: locations returned by the language server, including standard
 * library and dependency paths that sit outside `root`. Positions stay
 * 0-based, which is what LSP returns. Non-file URIs are dropped.
 */
export function locationsInside(root, result) {
  if (result === null || result === undefined || result.kind !== "locations" || !Array.isArray(result.locations)) return [];
  const out = [];
  for (const loc of result.locations) {
    if (loc === null || loc === undefined) continue;
    const abs = fileUriPath(loc.uri);
    if (abs === null) continue;
    const start = loc.range && loc.range.start;
    if (start === null || start === undefined) continue;
    if (!Number.isInteger(start.line) || start.line < 0) continue;
    if (!Number.isInteger(start.character) || start.character < 0) continue;
    const inside = insideRoot(root, abs);
    if (inside) {
      const rel = relative(root, abs);
      if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) continue;
      out.push({ rel: rel.split(sep).join("/"), line: start.line, character: start.character });
    } else {
      out.push({
        rel: abs.split(sep).join("/"),
        abs,
        outside: true,
        line: start.line,
        character: start.character
      });
    }
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Trim indent and clip a source line so the popup can show the call site.
 * @param {string} line
 * @returns {string}
 */
export function clipSnippet(line) {
  const body = String(line == null ? "" : line).replace(/\r$/, "").replace(/\t/g, "  ").trimStart();
  if (body.length <= SNIPPET_MAX) return body;
  return body.slice(0, SNIPPET_MAX) + "…";
}

/**
 * Attach a `text` snippet (the source line) to each location. Files are read
 * once. Locations whose file cannot be read are left unchanged.
 * @param {string} root
 * @param {object[]} locations
 * @returns {Promise<object[]>}
 */
export async function attachLineText(root, locations) {
  if (!Array.isArray(locations) || locations.length === 0) return locations || [];
  const out = locations.map((loc) => ({ ...loc }));
  const byFile = new Map();
  for (const loc of out) {
    let abs = null;
    if (typeof loc.abs === "string" && loc.abs !== "") {
      abs = loc.abs;
    } else if (typeof loc.rel === "string" && loc.rel !== "") {
      abs = resolve(root, loc.rel);
      if (!insideRoot(root, abs)) continue;
    } else {
      continue;
    }
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push(loc);
  }
  let realRoot = root;
  try { realRoot = await realpath(root); } catch { /* lexical root still bounds the check */ }
  for (const [abs, locs] of byFile) {
    let lines;
    try {
      // External locations come from a language server's file: URI. They are
      // untrusted: a crafted LSP response used to make the server read any
      // absolute path. Apply the same credential checks as the /read route.
      // A workspace path can still be a symlink onto `.git` or `.ssh`; follow
      // it and refuse the target, matching locate(). Compare real paths: on
      // macOS `root` may be `/var/...` while realpath returns `/private/var/...`.
      const external = locs[0]?.outside === true || !insideRoot(root, abs);
      let readable = abs;
      if (external) {
        readable = await resolveExternalFile(abs);
      } else {
        const real = await realpath(abs);
        const posix = real.split(sep).join("/");
        if (!insideRoot(realRoot, real) || isForbiddenPath(posix)) continue;
        readable = real;
      }
      const info = await stat(readable);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const buf = await readFile(readable);
      if (buf.includes(0)) continue;
      lines = buf.toString("utf8").split(/\n/);
    } catch {
      continue;
    }
    for (const loc of locs) {
      if (!Number.isInteger(loc.line) || loc.line < 0 || loc.line >= lines.length) continue;
      loc.text = clipSnippet(lines[loc.line]);
    }
  }
  return out;
}
