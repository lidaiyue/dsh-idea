import { isAbsolute, relative, sep } from "node:path";
import { insideRoot } from "./files.js";

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
 * Keep locations whose file stays inside `root`. Positions stay 0-based, which
 * is what LSP returns.
 */
export function locationsInside(root, result) {
  if (result === null || result === undefined || result.kind !== "locations" || !Array.isArray(result.locations)) return [];
  const out = [];
  for (const loc of result.locations) {
    if (loc === null || loc === undefined) continue;
    const abs = fileUriPath(loc.uri);
    if (abs === null || !insideRoot(root, abs)) continue;
    const rel = relative(root, abs);
    if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) continue;
    const start = loc.range && loc.range.start;
    if (start === null || start === undefined) continue;
    if (!Number.isInteger(start.line) || start.line < 0) continue;
    if (!Number.isInteger(start.character) || start.character < 0) continue;
    out.push({ rel: rel.split(sep).join("/"), line: start.line, character: start.character });
    if (out.length >= 50) break;
  }
  return out;
}
