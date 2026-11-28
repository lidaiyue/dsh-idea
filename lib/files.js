import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import { isForbiddenPath, isSecretFile } from "./secret.js";

export const MAX_BYTES = 1536 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// One dropped file is uploaded as base64 inside a JSON body, so the cap is
// what a single POST may carry rather than what the editor will open.
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
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
      // The caller checked `rel`, but the resolved target can land inside a
      // secret directory that the rel text never mentioned.
      if (forbidden(real.split(sep).join("/"))) throw new FsError("secret-path");
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
    if (forbidden(real.split(sep).join("/"))) return "";
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

export { forbidden };

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

/**
 * The final path component of `rel` **without following it**, plus its already
 * validated parent. `locate()` resolves a symlink to its target, which is right
 * for reading and wrong for deleting or renaming: those must act on the link
 * itself, or a link to a sibling directory would take the directory with it.
 */
async function leafOf(root, rel) {
  const parts = splitRel(rel);
  if (parts === null || parts.length === 0) throw new FsError("bad-path");
  const parent = await locate(root, parts.slice(0, -1).join("/"), false);
  return join(parent, parts[parts.length - 1]);
}

export async function renameEntry(cwd, from, to) {
  const root = await rootOf(cwd);
  if (typeof from !== "string" || splitRel(from) === null || splitRel(from).length === 0) throw new FsError("bad-path");
  if (typeof to !== "string" || splitRel(to) === null || splitRel(to).length === 0) throw new FsError("bad-path");
  if (forbidden(from) || forbidden(to)) throw new FsError("secret-path");
  // Resolve once for the outside/secret checks, then rename the link itself.
  await locate(root, from, false);
  const src = await leafOf(root, from);
  const dest = await locate(root, to, true);
  try {
    await lstat(dest);
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
  const leaf = await leafOf(root, rel);
  let info;
  try { info = await lstat(leaf); } catch { info = undefined; }
  if (info !== undefined && info.isSymbolicLink()) {
    // `rm -r` on the resolved path would delete the tree the link points at.
    await rm(leaf, { force: true });
    return;
  }
  await rm(abs, { recursive: true });
}

/** Real path → workspace-relative path with `/` separators. */
function relOf(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

async function existsAt(abs) {
  try {
    await lstat(abs);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

function splitName(name) {
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file's whole name, not an extension.
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * A free name beside `dirAbs`: the plain name when it is free, otherwise
 * `name copy.ext`, then `name copy 2.ext`, the way the Finder duplicates.
 * Copying into the same folder must never overwrite.
 */
async function uniqueDest(dirAbs, name) {
  const plain = join(dirAbs, name);
  if (!(await existsAt(plain))) return plain;
  const { stem, ext } = splitName(name);
  let candidate = join(dirAbs, stem + " copy" + ext);
  for (let i = 2; await existsAt(candidate); i++) {
    if (i > 999) throw new FsError("exists");
    candidate = join(dirAbs, stem + " copy " + i + ext);
  }
  return candidate;
}

/** Copying into itself would recurse forever; the target may not sit under the source. */
function refuseInside(src, dest) {
  if (dest === src || insideRoot(src, dest)) throw new FsError("inside-self");
}

async function targetDir(root, toDir) {
  const abs = typeof toDir === "string" && toDir !== "" ? await locate(root, toDir, false) : root;
  const info = await stat(abs);
  if (!info.isDirectory()) throw new FsError("not-a-directory");
  return abs;
}

/**
 * Copy a workspace entry into `toDir` (a workspace-relative directory, "" for
 * the root). A name already taken beside the target makes a "copy" name, so the
 * call is never destructive. Credentials and VCS internals stay behind.
 */
export async function copyEntry(cwd, from, toDir) {
  const root = await rootOf(cwd);
  if (typeof from !== "string" || splitRel(from) === null || splitRel(from).length === 0) throw new FsError("bad-path");
  if (typeof toDir !== "string" || splitRel(toDir) === null) throw new FsError("bad-path");
  if (forbidden(from) || forbidden(toDir)) throw new FsError("secret-path");
  const src = await locate(root, from, false);
  if (src === root) throw new FsError("bad-path");
  const dirAbs = await targetDir(root, toDir);
  refuseInside(src, dirAbs);
  const dest = await uniqueDest(dirAbs, basename(src));
  // `filter` keeps a duplicated folder from carrying `.git` (and an SSH or AWS
  // directory) along with it, which the tree would never show.
  await cp(src, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => source === src || !forbidden(basename(source))
  });
  return { rel: relOf(root, dest) };
}

/**
 * Move a workspace entry into `toDir`. A taken name is refused instead of
 * renamed: a move that silently lands somewhere else is a surprise, and the
 * caller can copy instead when it wants the duplicate name.
 */
export async function moveEntry(cwd, from, toDir) {
  const root = await rootOf(cwd);
  if (typeof from !== "string" || splitRel(from) === null || splitRel(from).length === 0) throw new FsError("bad-path");
  if (typeof toDir !== "string" || splitRel(toDir) === null) throw new FsError("bad-path");
  if (forbidden(from) || forbidden(toDir)) throw new FsError("secret-path");
  // Keep the outside/secret checks on the resolved target, then move the link.
  await locate(root, from, false);
  const src = await leafOf(root, from);
  if (src === root) throw new FsError("bad-path");
  const dirAbs = await targetDir(root, toDir);
  refuseInside(src, dirAbs);
  const dest = join(dirAbs, basename(src));
  if (dest === src) return { rel: relOf(root, src) };
  if (await existsAt(dest)) throw new FsError("exists");
  try {
    await rename(src, dest);
  } catch (err) {
    // A move across filesystems is a copy plus a delete.
    if (!err || err.code !== "EXDEV") throw err;
    await cp(src, dest, { recursive: true, errorOnExist: true, force: false });
    await rm(src, { recursive: true, force: true });
  }
  return { rel: relOf(root, dest) };
}

/**
 * Write one uploaded file (or make one empty directory) into `dirRel`, creating
 * the intermediate folders a dropped tree needs. `relPath` is the path under
 * `dirRel`, so a dropped folder arrives as "assets/img/a.png".
 *
 * Nothing is overwritten: an existing path is refused, because a drop was not
 * asked to replace a file the reader may be editing.
 */
export async function importEntry(cwd, dirRel, relPath, data, dir) {
  const root = await rootOf(cwd);
  if (typeof dirRel !== "string" || splitRel(dirRel) === null) throw new FsError("bad-path");
  const parts = splitRel(String(relPath == null ? "" : relPath));
  if (parts === null || parts.length === 0) throw new FsError("bad-path");
  const base = dirRel === "" ? "" : dirRel.replace(/\/$/, "");
  const full = base === "" ? parts.join("/") : base + "/" + parts.join("/");
  if (forbidden(full)) throw new FsError("secret-path");
  const baseAbs = await targetDir(root, base);
  let parent = baseAbs;
  for (let i = 0; i < parts.length - 1; i++) {
    parent = join(parent, parts[i]);
    if (forbidden(parts[i])) throw new FsError("secret-path");
    try {
      await mkdir(parent);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
    const info = await lstat(parent);
    if (info.isSymbolicLink()) {
      const real = await realpath(parent);
      if (!insideRoot(root, real)) throw new FsError("outside");
      parent = real;
    } else if (!info.isDirectory()) {
      throw new FsError("not-a-directory");
    }
  }
  const abs = join(parent, parts[parts.length - 1]);
  if (abs === root) throw new FsError("bad-path");
  if (await existsAt(abs)) throw new FsError("exists");
  if (dir === true) {
    await mkdir(abs);
  } else {
    if (typeof data !== "string") throw new FsError("bad-data");
    const buf = Buffer.from(data, "base64");
    if (buf.length > MAX_IMPORT_BYTES) throw new FsError("too-large");
    await writeFile(abs, buf, { flag: "wx", mode: 0o644 });
  }
  return { rel: relOf(root, abs) };
}

/** True when `value` looks like an absolute filesystem path. */
function isAbsPath(value) {
  return typeof value === "string" && value !== "" && !value.includes("\0")
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

/**
 * Resolve an absolute path to a real file, for jump targets outside the
 * workspace (stdlib, dependencies). Secret paths are still refused.
 * @param {string} absPath
 * @returns {Promise<string>}
 */
export async function resolveExternalFile(absPath) {
  if (!isAbsPath(absPath)) throw new FsError("bad-path");
  const abs = resolve(absPath);
  const asPosix = abs.split(sep).join("/");
  if (forbidden(abs) || forbidden(asPosix)) throw new FsError("secret-path");
  // Directory-name policy alone let an absolute /read fetch a credential file
  // outside the workspace (id_rsa, .env, *.pem). isSecretFile is what the
  // content search already uses; apply it to the absolute read path too.
  if (isSecretFile(basename(asPosix))) throw new FsError("secret-path");
  let real;
  try { real = await realpath(abs); } catch { throw new FsError("not-found"); }
  const realPosix = real.split(sep).join("/");
  if (forbidden(real) || forbidden(realPosix)) throw new FsError("secret-path");
  if (isSecretFile(basename(realPosix))) throw new FsError("secret-path");
  let info;
  try { info = await stat(real); } catch { throw new FsError("not-found"); }
  if (info.isDirectory()) throw new FsError("is-directory");
  if (!info.isFile()) throw new FsError("not-a-file");
  return real;
}

/**
 * Read a UTF-8 text file at an absolute path, with the same size/binary
 * caps as workspace reads. Used to open out-of-workspace jump targets.
 * @param {string} absPath
 * @returns {Promise<{ text: string, eol: string, bom: boolean, abs: string }>}
 */
export async function readExternalText(absPath) {
  const real = await resolveExternalFile(absPath);
  const info = await stat(real);
  if (info.size > MAX_BYTES) throw new FsError("too-large");
  const buf = await readFile(real);
  if (buf.includes(0)) throw new FsError("binary");
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const { text, eol } = decodeBody(buf);
  return { text, eol, bom, abs: real };
}

/**
 * Locate a file for an LSP query: a workspace-relative path, or an absolute
 * path opened from a previous jump (stdlib / dependency).
 * @param {string} cwd
 * @param {string} rel
 * @param {string} [abs]
 * @returns {Promise<{ root: string, abs: string }>}
 */
export async function resolveQueryFile(cwd, rel, abs) {
  if (typeof abs === "string" && abs !== "") {
    const root = await rootOf(cwd);
    return { root, abs: await resolveExternalFile(abs) };
  }
  return resolveInWorkspace(cwd, rel);
}
