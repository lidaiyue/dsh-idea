import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FsError, forbidden, splitRel } from "../files.js";

// A .sql script big enough to open in the console. The console store truncates
// a persisted console buffer at 100 kB (CONSOLE_SQL_MAX in ./index.js), which
// only shortens the text shown in the console: a run re-reads the file from
// disk, so this cap is about reading one file, not about what can be executed.
export const SQL_FILE_MAX_BYTES = 1024 * 1024;

// IntelliJ's own "this script belongs to that data source" header, which
// JetBrains IDEs write as a line comment at the top of a .sql file. DataGrip
// writes `--/ ##name`, the web editors `-- datasource: name`.
const DS_LINE = /^\s*(?:--\s*(?:datasource|data\s*source|数据源)\s*[:：]\s*|\/\/\s*##|--\/\s*##)(.+?)\s*$/i;
// Written by the console when a .sql file is run against one connection. The
// id is the plugin's own uuid, so a renamed or duplicated connection name
// cannot make a later run land on the wrong database.
const ANNOTATION = /^\s*--\s*@dsh-connection\s+([0-9A-Za-z-]+)\s*$/;

function headerMatch(text) {
  // Only the comment block above the first statement counts, so a label deep
  // in a long dump does not hijack the file.
  for (const line of String(text || "").split(/\r?\n/).slice(0, 40)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")) break;
    const m = DS_LINE.exec(line);
    if (m) return m[1].trim();
  }
  return "";
}

function annotationMatch(text) {
  // The annotation is written as the very first line, so only the top is read.
  for (const line of String(text || "").split(/\r?\n/).slice(0, 20)) {
    const m = ANNOTATION.exec(line);
    if (m) return m[1];
  }
  return "";
}

async function readSqlFile(cwd, rel) {
  if (typeof cwd !== "string" || cwd === "") throw new FsError("cwd-required");
  // Same path rules as the editor's own read: no traversal, no secret files.
  const parts = splitRel(rel);
  if (parts === null || parts.length === 0) throw new FsError("bad-path");
  const root = resolve(cwd);
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (back === "") throw new FsError("bad-path");
  if (back === ".." || back.startsWith(".." + sep) || isAbsolute(back)) throw new FsError("outside");
  // `splitRel` answers the shape of the path; the editor's read is what decides
  // which paths are off limits (a secret file refuses before anything is read).
  if (forbidden(rel)) throw new FsError("secret-path");
  // The lexical check above cannot see a symlink: a link inside the workspace
  // named `dump.sql` that points at `/etc/passwd` passes it and then reads the
  // target. Resolve both ends and re-check the real containment.
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new FsError("cwd-required");
  }
  let realAbs;
  try {
    realAbs = await realpath(abs);
  } catch {
    throw new FsError("not-found");
  }
  const realBack = relative(realRoot, realAbs);
  if (realBack === "" || realBack === ".." || realBack.startsWith(".." + sep) || isAbsolute(realBack)) throw new FsError("outside");
  let info;
  try {
    info = await stat(realAbs);
  } catch {
    throw new FsError("not-found");
  }
  if (!info.isFile()) throw new FsError("not-a-file");
  if (info.size > SQL_FILE_MAX_BYTES) throw new FsError("too-large");
  const text = await readFile(realAbs, "utf8");
  return { rel, text };
}

/**
 * Put the annotation that binds a .sql file to `connId` into `text`, replacing
 * a previous one so re-runs do not stack lines. A `-- datasource:` header the
 * user wrote is left exactly as it is: it is their text, and other tools read
 * it too.
 */
export function annotateSql(text, connId) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const at = lines.length > 0 && ANNOTATION.test(lines[0]) ? 0 : -1;
  if (at === 0) lines.splice(at, 1);
  const head = lines.join("\n");
  if (typeof connId !== "string" || connId === "") return head;
  return "-- @dsh-connection " + connId + "\n" + head;
}

/**
 * A .sql file opened for running: its text, the data source it names, and the
 * connection it is already bound to.
 *
 * GET only — the browser half opens a script from the editor with a plain URL,
 * so no page-authored script text is ever handed to the host from here.
 */
export async function openSqlFile(cwd, rel, bind) {
  const { text } = await readSqlFile(cwd, rel);
  return {
    rel,
    text,
    datasource: headerMatch(text),
    // What the file already names, or — when the editor has already bound it to
    // a connection — that binding. The editor writes it as an annotation on the
    // next save, so the two agree on which database this script belongs to.
    connId: annotationMatch(text) || (bind && typeof bind.connId === "string" ? bind.connId : ""),
  };
}

/**
 * `text` with the annotation bound to `connId` (removed when `connId` is "").
 * The JetBrains header is left alone unless `header` is given, in which case it
 * is added after the annotation when the text has none yet.
 */
export function bindSqlText(text, connId, header) {
  let next = annotateSql(text, connId);
  const label = typeof header === "string" ? header.trim() : "";
  if (label !== "" && headerMatch(next) === "") {
    const body = next.replace(/^-- @dsh-connection [^\n]*\n/, "");
    next = annotateSql("-- datasource: " + label + "\n" + body, connId);
  }
  return next;
}
