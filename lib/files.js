import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import { isForbiddenPath } from "./secret.js";

export const MAX_BYTES = 1536 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon"
};
export const MAX_ENTRIES = 4000;

export const SKIP = {
  node_modules: 1, ".git": 1, dist: 1, "dist-ssr": 1, ".next": 1, ".nuxt": 1,
  ".turbo": 1, ".cache": 1, build: 1, out: 1, target: 1, vendor: 1,
  __pycache__: 1, ".venv": 1, venv: 1, coverage: 1, ".pnpm-store": 1,
  ".output": 1, ".svelte-kit": 1, logs: 1, ".idea": 1, ".vscode": 1,
  ".DS_Store": 1, tmp: 1, temp: 1, ".gradle": 1, ".mvn": 1
};

export class FsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Relative path segments, or null when `rel` escapes or is absolute. */
export function splitRel(rel) {
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  let text = rel.replace(/\\/g, "/");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  if (text.endsWith("/")) text = text.slice(0, -1);
  if (text === "" || text === ".") return [];
  const parts = text.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (parts.join("/").length > 1024) return null;
  return parts;
}

export function insideRoot(root, target) {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return false;
  return true;
}

async function rootOf(cwd) {
  if (typeof cwd !== "string" || !(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd))) throw new FsError("cwd-required");
  let real;
  try { real = await realpath(resolve(cwd)); } catch { throw new FsError("cwd-required"); }
  let info;
  try { info = await stat(real); } catch { throw new FsError("cwd-required"); }
  if (!info.isDirectory()) throw new FsError("cwd-required");
  return real;
}

/**
 * Walk `rel` under `root`. A symlink is followed only when its target stays
 * inside `root`. `missing` allows the final component to not exist yet.
 */
async function locate(root, rel, missing) {
  const parts = splitRel(rel);
  if (parts === null) throw new FsError("bad-path");
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    const next = join(dir, parts[i]);
    const last = i === parts.length - 1;
    let info;
    try { info = await lstat(next); } catch (err) {
      if (err && err.code === "ENOENT" && last && missing) {
        if (!insideRoot(root, next)) throw new FsError("outside");
        return next;
      }
      throw new FsError("not-found");
    }
    if (info.isSymbolicLink()) {
      let real;
      try { real = await realpath(next); } catch { throw new FsError("not-found"); }
      if (!insideRoot(root, real)) throw new FsError("outside");
      dir = real;
      continue;
    }
    if (!insideRoot(root, next)) throw new FsError("outside");
    dir = next;
  }
  return dir;
}

async function classifyLink(abs, root) {
  try {
    const real = await realpath(abs);
    if (!insideRoot(root, real)) return "";
    const info = await stat(real);
    if (info.isDirectory()) return "dir";
    if (info.isFile()) return "file";
  } catch {}
  return "";
}

/** Real path of a workspace file. Symlinks that leave the root are rejected. */
export async function resolveInWorkspace(cwd, rel) {
  const root = await rootOf(cwd);
  if (typeof rel !== "string" || splitRel(rel) === null || splitRel(rel).length === 0) throw new FsError("bad-path");
  const abs = await locate(root, rel, false);
  const info = await stat(abs);
  if (info.isDirectory()) throw new FsError("is-directory");
  if (!info.isFile()) throw new FsError("not-a-file");
  return { root, abs };
}

export async function listDir(cwd, rel) {
  const root = await rootOf(cwd);
  const abs = await locate(root, typeof rel === "string" ? rel : "", false);
  const info = await stat(abs);
  if (!info.isDirectory()) throw new FsError("not-a-directory");
  const entries = await readdir(abs, { withFileTypes: true });
  const prefix = splitRel(typeof rel === "string" ? rel : "").join("/");
  const out = [];
  let hidden = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || entry.name === "." || entry.name === "..") continue;
    if (SKIP[entry.name] === 1) { hidden += 1; continue; }
    let dir = entry.isDirectory();
    let file = entry.isFile();
    if (entry.isSymbolicLink()) {
      const kind = await classifyLink(join(abs, entry.name), root);
      dir = kind === "dir";
      file = kind === "file";
    }
    if (!dir && !file) { hidden += 1; continue; }
    const child = prefix === "" ? entry.name : prefix + "/" + entry.name;
    out.push({ name: entry.name, rel: child, dir });
    if (out.length >= MAX_ENTRIES) break;
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "en") : a.dir ? -1 : 1));
  return { entries: out, truncated: out.length >= MAX_ENTRIES && entries.length > out.length + hidden };
}

function eolOf(text) {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "cr";
  return "lf";
}

/** Decode raw bytes the way `readText` returns them: BOM stripped, EOL normalized to "\n". */
function decodeBody(buf) {
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) body = buf.subarray(3);
  const decoded = body.toString("utf8");
  if (!body.equals(Buffer.from(decoded, "utf8"))) throw new FsError("not-utf8");
  const eol = eolOf(decoded);
  const text = eol === "lf" ? decoded : decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { text, eol };
}

/** MIME type for a previewable image path, or "" when the extension is not one. */
export function imageMime(rel) {
  if (typeof rel !== "string") return "";
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return "";
  return IMAGE_MIME[rel.slice(dot + 1).toLowerCase()] || "";
}

/** Raw image bytes as base64. Same workspace fence as text reads, with a larger cap. */
export async function readImage(cwd, rel) {
  const mime = imageMime(rel);
  if (mime === "") throw new FsError("bad-path");
  if (typeof rel !== "string" || splitRel(rel) === null || splitRel(rel).length === 0) throw new FsError("bad-path");
  if (forbidden(rel)) throw new FsError("secret-path");
  const root = await rootOf(cwd);
  const abs = await locate(root, rel, false);
  const info = await stat(abs);
  if (info.isDirectory()) throw new FsError("is-directory");
  if (!info.isFile()) throw new FsError("not-a-file");
  if (info.size > MAX_IMAGE_BYTES) throw new FsError("image-too-large");
  const buf = await readFile(abs);
  return { mime, data: buf.toString("base64") };
}

export async function readText(cwd, rel) {
  if (typeof rel !== "string" || splitRel(rel) === null || splitRel(rel).length === 0) throw new FsError("bad-path");
  if (forbidden(rel)) throw new FsError("secret-path");
  const root = await rootOf(cwd);
  const abs = await locate(root, rel, false);
  const info = await stat(abs);
  if (info.isDirectory()) throw new FsError("is-directory");
  if (!info.isFile()) throw new FsError("not-a-file");
  if (info.size > MAX_BYTES) throw new FsError("too-large");
  const buf = await readFile(abs);
  if (buf.includes(0)) throw new FsError("binary");
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const { text, eol } = decodeBody(buf);
  return { text, eol, bom };
}

export async function writeText(cwd, rel, text, eol, bom, base) {
  if (typeof text !== "string") throw new FsError("bad-text");
  if (eol !== "lf" && eol !== "crlf" && eol !== "cr") throw new FsError("bad-eol");
  if (typeof rel !== "string" || splitRel(rel) === null || splitRel(rel).length === 0) throw new FsError("bad-path");
  if (forbidden(rel)) throw new FsError("secret-path");
  const root = await rootOf(cwd);
  const abs = await locate(root, rel, true);
  let exists = true;
  let mode = 0o644;
  try {
    const info = await stat(abs);
    if (info.isDirectory()) throw new FsError("is-directory");
    if (!info.isFile()) throw new FsError("not-a-file");
    mode = info.mode & 0o777;
  } catch (err) {
    if (err instanceof FsError) throw err;
    exists = false;
  }
  if (exists && typeof base === "string" && /^[0-9a-f]{64}$/.test(base)) {
    // Optimistic-lock check: `base` is the SHA-256 of the text the client
    // last saw. A different hash means the file changed on disk since, and
    // overwriting would silently destroy that work — refuse instead.
    let diskText = null;
    try {
      const buf = await readFile(abs);
      if (buf.includes(0)) diskText = null;
      else diskText = decodeBody(buf).text;
    } catch {
      diskText = null;
    }
    const diskHash = diskText === null ? "" : createHash("sha256").update(diskText, "utf8").digest("hex");
    if (diskHash !== base) throw new FsError("conflict");
  }
  if (!exists) {
    let parent;
    try { parent = await realpath(dirname(abs)); } catch { throw new FsError("not-found"); }
    if (!insideRoot(root, parent)) throw new FsError("outside");
    const info = await stat(parent);
    if (!info.isDirectory()) throw new FsError("not-found");
  }
  const normalized = eol === "crlf" ? text.replace(/\n/g, "\r\n") : eol === "cr" ? text.replace(/\n/g, "\r") : text;
  let buf = Buffer.from(normalized, "utf8");
  if (bom === true) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  if (buf.length > MAX_BYTES) throw new FsError("too-large");
  const tmp = abs + ".dce-tmp-" + randomBytes(6).toString("hex");
  try {
    await writeFile(tmp, buf, { mode });
    await rename(tmp, abs);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch {}
    throw err;
  }
}

async function parentInside(root, abs) {
  let parent;
  try { parent = await realpath(dirname(abs)); } catch { throw new FsError("not-found"); }
  if (!insideRoot(root, parent)) throw new FsError("outside");
  const info = await stat(parent);
  if (!info.isDirectory()) throw new FsError("not-found");
  return parent;
}

/**
 * Credential and VCS-internal paths, refused by every entry point here.
 *
 * `listDir` already hides these (SKIP covers `.git`) and content search refuses
 * to read them, so serving `/read`, `/write`, rename or delete on the same
 * paths was the one way left to reach a remote URL with an embedded token or an
 * SSH directory that happens to sit inside the workspace.
 */
function forbidden(rel) {
  return isForbiddenPath(String(rel).replace(/\\/g, "/"));
}

export async function createEntry(cwd, rel, dir) {
  const root = await rootOf(cwd);
  if (typeof rel !== "string" || splitRel(rel) === null || splitRel(rel).length === 0) throw new FsError("bad-path");
  if (forbidden(rel)) throw new FsError("secret-path");
  const abs = await locate(root, rel, true);
  try {
    await stat(abs);
    throw new FsError("exists");
  } catch (err) {
    if (err instanceof FsError) throw err;
  }
  await parentInside(root, abs);
  if (dir === true) await mkdir(abs);
  else await writeFile(abs, "", { flag: "wx", mode: 0o644 });
}

export async function renameEntry(cwd, from, to) {
  const root = await rootOf(cwd);
  if (typeof from !== "string" || splitRel(from) === null || splitRel(from).length === 0) throw new FsError("bad-path");
  if (typeof to !== "string" || splitRel(to) === null || splitRel(to).length === 0) throw new FsError("bad-path");
  if (forbidden(from) || forbidden(to)) throw new FsError("secret-path");
  const src = await locate(root, from, false);
  const dest = await locate(root, to, true);
  try {
    await stat(dest);
    throw new FsError("exists");
  } catch (err) {
    if (err instanceof FsError) throw err;
  }
  await parentInside(root, dest);
  await rename(src, dest);
}

export async function deleteEntry(cwd, rel) {
  const root = await rootOf(cwd);
  if (typeof rel !== "string" || splitRel(rel) === null || splitRel(rel).length === 0) throw new FsError("bad-path");
  if (forbidden(rel)) throw new FsError("secret-path");
  const abs = await locate(root, rel, false);
  if (abs === root) throw new FsError("bad-path");
  await rm(abs, { recursive: true });
}
