import { Buffer } from "node:buffer";

export const MAX_ROWS = 200;
export const PREVIEW_ROWS = 50;
export const EXPORT_ROWS = 5000;
// Import bounds. An import is the one route that runs attacker-shaped DDL/DML
// against a production database with no per-statement review, so it is capped
// in both statement count and total bytes: a 16 MB body of one-character
// statements would otherwise be tens of thousands of round trips.
export const IMPORT_STATEMENTS_MAX = 2000;
export const IMPORT_BYTES_MAX = 4 * 1024 * 1024;
// One export's total size. Rows are capped per table, but a database with many
// tables still adds up; the dump is assembled in memory and returned as a single
// response, so it is bounded below the import's own limit (a dump that could not
// be imported back would be a strange thing to produce).
export const EXPORT_BYTES_MAX = 4 * 1024 * 1024;
export const MAX_KEYS = 400;
export const MAX_CHILDREN = 2000;
export const MAX_SCHEMA_NAME = 200;
export const MAX_SCHEMAS = 200;

// Oracle only grew OFFSET/FETCH in 12.1. Unknown version (0) uses ROWNUM.
export const ORACLE_FETCH_MIN = 1201000000;

// PostgreSQL databases that exist on every fresh cluster but are almost never
// where a user keeps application data. `postgres` is the admin database the
// installer creates, `template1` is the source every `CREATE DATABASE` clones
// from, and `rdsadmin` is the management database AWS RDS provisions. Hiding
// them is opt-out: a connection can show them with `hideBuiltinDatabases:
// false`, and a database that legitimately chose the name `postgres` still
// appears (the cluster-side `datallowconn = false` on `template0` is what
// already keeps that one out).
export const PG_BUILTIN_DATABASES = new Set([
  "postgres",
  "template1",
  "rdsadmin",
]);

export function pgBuiltinDatabase(name) {
  return PG_BUILTIN_DATABASES.has(String(name || "").toLowerCase());
}

export function quoteIdent(type, name) {
  const value = String(name || "");
  if (value === "" || /[\0\n\r\\]/.test(value)) throw new Error("invalid-identifier");
  if (type === "mysql") return "`" + value.replace(/`/g, "``") + "`";
  return '"' + value.replace(/"/g, '""') + '"';
}

export function qualifyTable(type, schema, table) {
  if (schema) return quoteIdent(type, schema) + "." + quoteIdent(type, table);
  return quoteIdent(type, table);
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

// IDEA-style local timestamp: yyyy-MM-dd HH:mm:ss (.SSS only when non-zero).
export function localDateTime(value) {
  if (Number.isNaN(value.getTime())) return String(value);
  const text = value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate())
    + " " + pad2(value.getHours()) + ":" + pad2(value.getMinutes()) + ":" + pad2(value.getSeconds());
  const ms = value.getMilliseconds();
  return ms ? text + "." + String(ms).padStart(3, "0") : text;
}

// Longest cell value a grid will receive. Anything past this is cut with an
// ellipsis, so a producer that wants a trailing note ("… (N bytes total)") to
// survive must stay under it — see `MAX_STRING_BYTES` in engines/redis.js.
export const CELL_CHARS_MAX = 8000;

// node-oracledb hands a CLOB/BLOB back as a Lob stream. `JSON.stringify` on that
// stream is the object itself (`_events`, `_readableState`), not the payload,
// which is what a JSON body column was showing. Read a bounded slice here, then
// close the locator — an unread Lob holds the Oracle session, and this plugin
// shares one session across every later request.
const LOB_TEXT = new Set([2017, 2018]);
const LOB_BIN = new Set([2019, 2020]);

function lobKind(value) {
  if (!value || typeof value.getData !== "function") return "";
  const type = value.type;
  const num = typeof type === "number" ? type : type && type.num;
  const name = type && typeof type.name === "string" ? type.name : "";
  if (LOB_TEXT.has(num) || name === "DB_TYPE_CLOB" || name === "DB_TYPE_NCLOB") return "text";
  if (LOB_BIN.has(num) || name === "DB_TYPE_BLOB" || name === "DB_TYPE_BFILE") return "bin";
  if (value._readableState) return "text";
  return "";
}

async function closeLob(lob) {
  // `close()` is the call that actually releases the Oracle locator, and it
  // returns when that is done. `destroy()` is only a fallback; waiting on its
  // "close" event would hang if the object never emits one.
  if (typeof lob.close === "function") {
    try { await lob.close(); } catch {}
    return;
  }
  try { if (typeof lob.destroy === "function") lob.destroy(); } catch {}
}

// Grid cells only ever show a short hex prefix. The fetch-on-edit path passes
// a much higher `max` and is the only caller that should receive more.
const BIN_PREVIEW_BYTES = 64;

// How many bytes a binary preview at `max` renders. The note that follows a
// cut value counts against `max`, so the byte cap is derived from its length.
function binaryCap(total, max) {
  if (max > CELL_CHARS_MAX) {
    const noteLen = ("… (" + total + " bytes)").length;
    return Math.min(total, Math.max(1, Math.floor((max - noteLen - 2) / 2)));
  }
  return Math.min(total, BIN_PREVIEW_BYTES);
}

// `\x…` preview of a buffer, plus whether bytes were left behind. The caller
// gets that flag instead of having to guess from the trailing `…`.
function hexPreview(value, max) {
  const total = value.length;
  const cap = binaryCap(total, max);
  const hex = value.subarray(0, cap).toString("hex");
  if (total <= cap) return { value: "\\x" + hex, cut: false };
  return {
    value: "\\x" + hex + (max > CELL_CHARS_MAX ? "… (" + total + " bytes)" : "…"),
    cut: true,
  };
}

async function readLobCellInfo(value, max = CELL_CHARS_MAX) {
  const kind = lobKind(value);
  if (!kind) return { value, cut: false };
  const total = Number(value.length) || 0;
  try {
    if (!total) return { value: "", cut: false };
    if (kind === "bin") {
      const cap = binaryCap(total, max);
      const data = await value.getData(1, cap);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
      const cut = total > cap;
      const hex = buf.subarray(0, cap).toString("hex");
      return { value: "\\x" + hex + (cut ? "… (" + total + " bytes)" : ""), cut };
    }
    const data = await value.getData(1, Math.min(total, max));
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data == null ? "" : data);
    if (total <= max) return { value: text, cut: false };
    const note = "… (" + total + " chars)";
    return { value: text.slice(0, Math.max(0, max - note.length)) + note, cut: true };
  } catch {
    return { value: null, cut: false };
  } finally {
    await closeLob(value);
  }
}

async function readLobCell(value, max = CELL_CHARS_MAX) {
  return (await readLobCellInfo(value, max)).value;
}

export async function materializeLobs(rows) {
  if (!Array.isArray(rows)) return rows;
  for (const row of rows) {
    if (Array.isArray(row)) {
      for (let i = 0; i < row.length; i++) row[i] = await readLobCell(row[i]);
    } else if (row && typeof row === "object") {
      for (const key of Object.keys(row)) row[key] = await readLobCell(row[key]);
    }
  }
  return rows;
}

// One cell for the editor's fetch-on-edit path: the grid's copy was
// display-truncated, so the server re-reads this single value with a higher
// ceiling. `cut` reports whether even this read left data behind — the client
// must not treat that as the column's real text. The value is shaped exactly
// like `cell`, so the client gets a string (or null), never a driver object.
export async function materializeCell(value, maxChars) {
  const max = Number(maxChars) || CELL_CHARS_MAX;
  if (lobKind(value)) return readLobCellInfo(value, max);
  return shapeCell(value, max);
}

function shapeCell(value, max) {
  if (value === null || value === undefined) return { value: null, cut: false };
  if (typeof value === "string") {
    const cut = value.length > max;
    return { value: cut ? value.slice(0, max) + "…" : value, cut };
  }
  if (typeof value === "number" || typeof value === "boolean") return { value, cut: false };
  if (typeof value === "bigint") return { value: String(value), cut: false };
  if (value instanceof Date) return { value: localDateTime(value), cut: false };
  if (Buffer.isBuffer(value)) return hexPreview(value, max);
  try {
    const text = JSON.stringify(value);
    const cut = text.length > max;
    return { value: cut ? text.slice(0, max) + "…" : text, cut };
  } catch {
    const text = String(value);
    return { value: text.slice(0, 400), cut: text.length > 400 };
  }
}

export function cell(value, max = CELL_CHARS_MAX) {
  return shapeCell(value, max).value;
}

export function firstCell(row) {
  if (Array.isArray(row)) return row[0];
  if (row && typeof row === "object") {
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : "";
  }
  return row;
}

// One-line label for a table comment shown beside the name in the tree.
// Catalogue text is often padded or split across lines; collapsing it keeps the
// row a single line. MySQL stores the literal "VIEW" as TABLE_COMMENT when the
// user never set one — that placeholder is not a comment.
export function catalogueComment(value, tableType) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (tableType === "view" && text.toUpperCase() === "VIEW") return "";
  return text;
}

export function resultOf(columns, rawRows, truncated) {
  const rows = rawRows.map((row) => {
    // Not `row.map(cell)`: map passes the column index as a second argument,
    // which `cell`'s `max` parameter would swallow as a per-column truncation.
    if (Array.isArray(row)) return row.map((v) => cell(v));
    return columns.map((col) => cell(row[col]));
  });
  return { columns, rows, truncated: truncated === true, rowCount: rows.length };
}

// A statement that came back with no columns is a write or DDL, not an empty
// SELECT (those still have a field list). Keep the driver's affected-row count
// — 0 is a real result, not "missing" — and the verb when the driver knows it.
export function writeMeta(data, affected, command) {
  if (!data || (data.columns && data.columns.length)) return data;
  const out = { ...data };
  if (typeof affected === "number" && Number.isFinite(affected)) out.affected = affected;
  if (command) out.command = String(command).toUpperCase();
  return out;
}

// Leading verb of a statement, after comments and a wrapping CTE. Used when the
// driver does not report a command tag (MySQL, Oracle) so `UPDATE` is not shown
// as an empty query.
export function statementCommand(sql) {
  const text = stripSqlNoise(sql).replace(/;\s*$/, "").trim();
  if (!text) return "";
  if (/^with\s+/i.test(text)) {
    const body = text.replace(/^with\s+(recursive\s+)?[A-Za-z_"`\[][\s\S]*?\)\s*/i, "");
    const keyword = (body.trim().match(/^([A-Za-z]+)/) || [])[1];
    return keyword ? keyword.toUpperCase() : "";
  }
  const word = (text.match(/^([A-Za-z]+)/) || [])[1];
  return word ? word.toUpperCase() : "";
}

export function sqlLiteral(type, value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") {
    if (type === "mysql" || type === "oracle") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  // MySQL (unless NO_BACKSLASH_ESCAPES is set, which cannot be assumed) reads
  // `\'` inside a single-quoted string as an escaped quote. Doubling only `'`
  // lets a stored value like `abc\` swallow the closing quote and leak into the
  // rest of the statement. Escaping the backslashes themselves first keeps the
  // doubling authoritative. The other engines treat a backslash as an ordinary
  // character, so they keep the doubling-only form.
  if (type === "mysql") {
    return "'" + text.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  }
  return "'" + text.replace(/'/g, "''") + "'";
}

export function ph(type, index) {
  if (type === "postgres") return "$" + index;
  if (type === "oracle") return ":" + index;
  return "?";
}

export function schemaNamesOf(row) {
  const raw = row && row.schemas;
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const name = String(item == null ? "" : item).trim().slice(0, MAX_SCHEMA_NAME);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_SCHEMAS) break;
  }
  return out;
}

// null = unrestricted; otherwise case-insensitive name set.
//
// SCOPE: this is a *display* filter for the tree, not an access control. It is
// consulted only by the engines' `children` enumeration, so it decides which
// schemas the sidebar lists. It deliberately does not gate `previewTable`,
// `describeTable`, `updateRows` or `runQuery`: the user holds working
// credentials for this database and the SQL console exists precisely to run
// arbitrary statements, so a schema filter that also blocked `SELECT … FROM
// other_schema.t` would be trivially bypassed and would only create a false
// sense of confinement. The client copy says the same thing ("显示" / "limit
// the tree"). If real confinement is ever wanted it belongs on the database
// side, as a role with no grants outside the intended schemas.
export function schemaFilterOf(conn) {
  const names = schemaNamesOf(conn);
  return names.length ? new Set(names.map((name) => name.toLowerCase())) : null;
}

export function schemaAllowed(conn, name) {
  const filter = schemaFilterOf(conn);
  if (!filter) return true;
  return filter.has(String(name == null ? "" : name).toLowerCase());
}

// Whether the statement returns rows, and can therefore be wrapped in a derived
// table to bound it.
//
// A bare `SELECT` is the obvious case, but two others return rows just as well
// and used to slip past every "is this a query?" test here:
//   - a CTE:        `WITH x AS (…) SELECT …`   (and `WITH RECURSIVE`)
//   - a parenthesised union: `(SELECT 1) UNION (SELECT 2)`
// Both are ordinary things to type in a SQL console, so leaving them out meant
// the very queries most likely to be large were the ones left unbounded.
//
// Deliberately conservative: anything that does not clearly begin a
// row-returning statement is reported as false, because the alternative —
// wrapping a statement that cannot be wrapped — is a syntax error on the user's
// own query.
export function looksLikeSelect(sql) {
  const text = String(sql || "").trim();
  if (/^select\b/i.test(text)) return true;
  // `WITH [RECURSIVE] name [(cols)] AS [NOT MATERIALIZED] ( … )` then the body.
  if (/^with\s+(recursive\s+)?[A-Za-z_"`\[]/i.test(text)) {
    // A CTE can also prefix a write — `WITH x AS (…) INSERT INTO t SELECT …` —
    // and SQLite additionally allows `WITH … DELETE` / `UPDATE`. Those return no
    // rows (PostgreSQL only returns some with a RETURNING clause), so they must
    // not be treated as queries: wrapping one in a derived table is a syntax
    // error on the user's own statement.
    const body = stripSqlNoise(text, "sqlserver").replace(/^with\s+(recursive\s+)?[A-Za-z_"`\[][\s\S]*?\)\s*/i, "");
    const keyword = (body.trim().match(/^([A-Za-z]+)/) || [])[1];
    return !keyword || /^(select|values|table)$/i.test(keyword);
  }
  // A leading parenthesised SELECT.
  if (/^\(\s*select\b/i.test(text)) return true;
  return false;
}

// Drop comments and string literals so LIMIT inside a comment is not a real bound.
// Identifiers stay: PG/Oracle use ", MySQL uses `.
export function stripSqlNoise(sql, type) {
  const text = String(sql || "");
  const mysql = type === "mysql";
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) { i += 1; continue; }
        quote = "";
      }
      continue;
    }
    if (ch === "'" || (mysql && ch === '"')) { quote = ch; continue; }
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

export function alreadyPaged(sql, type) {
  const text = stripSqlNoise(sql, type);
  if (/\bfetch\s+(first|next)\b/i.test(text)) return true;
  if (/\boffset\s+\d+\s+(rows|row)\b/i.test(text)) return true;
  return /\blimit\s+(\d+|all|\?|\$\d+)/i.test(text);
}

export function unquoteIdent(value) {
  return String(value || "").replace(/^["`]|["`]$/g, "");
}

// Simple single-table SELECT → { schema, table }; null if the rows cannot map back.
export function writableTarget(conn, sql, defaultSchema) {
  const text = stripSqlNoise(sql, conn.type).replace(/;\s*$/, "").trim();
  if (!/^select\b/i.test(text)) return null;
  if (/\b(join|group\s+by|having|distinct|union|intersect|except|over\s*\(|\bwith\b)/i.test(text)) return null;
  if (/\bfrom\s*\(/i.test(text)) return null;
  if ((text.match(/\bselect\b/gi) || []).length > 1) return null;
  const ident = "(\"[^\"]+\"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)";
  const m = new RegExp("\\bfrom\\s+" + ident + "(?:\\s*\\.\\s*" + ident + ")?", "i").exec(text);
  if (!m) return null;
  const fromTail = text.slice(m.index + m[0].length).split(/\bwhere\b|\border\b|\blimit\b|\boffset\b/i)[0];
  if (fromTail.includes(",")) return null;
  const first = unquoteIdent(m[1]);
  const second = unquoteIdent(m[2]);
  if (second) return { schema: first, table: second };
  if (conn.type === "oracle") return { schema: String(defaultSchema || ""), table: first };
  return {
    schema: conn.type === "postgres" ? "public" : (conn.database || ""),
    table: first,
  };
}

// Split a script into statements on `;`, respecting the dialect's literal
// syntax. Only MySQL reads `\'` as an escaped quote (standard_conforming_strings
// makes a backslash ordinary in PostgreSQL, and Oracle agrees), so elsewhere an
// unterminated `'a\'; ...'` literal must stay closed over its `;`. PostgreSQL
// additionally dollar-quotes bodies (`$$…$$`, `$tag$…$tag$`) whose contents are
// never split.
export function splitSql(text, dialect) {
  const out = [];
  let cur = "";
  let i = 0;
  let quote = "";
  let dollar = "";
  let lineComment = false;
  let blockComment = false;
  const src = String(text || "");
  // The pre-dialect behaviour treated `\` as an escape everywhere, so an
  // unspecified dialect keeps that legacy (MySQL-compatible) reading.
  const escapes = dialect !== "postgres" && dialect !== "oracle";
  const dollarTag = () => (/^\$(?:[A-Za-z][A-Za-z0-9_]*)?\$/.exec(src.slice(i)) || [""])[0];
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) {
      cur += ch;
      if (ch === "\n") lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      cur += ch;
      if (ch === "*" && next === "/") {
        cur += next;
        i += 2;
        blockComment = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (dollar) {
      if (src.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length;
        dollar = "";
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (quote) {
      if (escapes && ch === "\\") {
        cur += ch + (next || "");
        i += 2;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      cur += ch;
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      cur += ch;
      blockComment = true;
      i += 1;
      continue;
    }
    if (dialect === "postgres" && ch === "$") {
      const tag = dollarTag();
      if (tag) {
        dollar = tag;
        cur += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === ";") {
      const stmt = cur.trim();
      if (stmt) out.push(stmt);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// Walk `items` with `worker`, at most `width` in flight at a time, returning
// results in input order.
//
// A full export has to ask each schema (PostgreSQL) or each owner (Oracle) for
// its tables. Doing that one `await` at a time inside a `for` loop turns a
// 50-schema database into 50 serial round trips, which dominates the export;
// doing them all at once instead would open as many sockets as the server has
// schemas. A small fixed window keeps the round trips overlapped while leaving
// the pool's own connection limit as the real bound.
export async function mapBounded(items, width, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  const limit = Math.max(1, Math.min(Number(width) || 1, list.length || 1));
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      out[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, run));
  return out;
}

export function affected(result) {
  if (!result) return 1;
  const n = result.rowCount ?? result.rowsAffected ?? result.affectedRows;
  // `0` is a real answer — a PK that matched nothing, a WHERE clause that
  // selected no row — and reporting it as 1 made a failed write look applied.
  // Only an absent count falls back to 1 (the driver said nothing either way).
  return typeof n === "number" && Number.isFinite(n) ? n : 1;
}

// Statements that destroy data or structure wholesale. An import is a
// deliberate, user-initiated action — CREATE/INSERT/UPDATE are its whole point
// — but these two are the ones whose damage is not visible in the confirmation
// dialog's line count, and neither is needed to restore an export this plugin
// produced (it emits CREATE-less INSERTs and, for MySQL, the table's own DDL,
// both of which pass through unflagged). Reported so the caller can require an
// explicit acknowledgement rather than running them silently.
const DESTRUCTIVE_RE = /^\s*(drop|truncate)\b/i;

export function destructiveStatements(statements) {
  return (statements || []).filter((stmt) => DESTRUCTIVE_RE.test(stripSqlNoise(stmt)));
}

// Rewrite a SELECT so the SERVER returns at most `limit` rows.
//
// The engine layers truncate only after the driver has buffered the whole
// result set: `pg` accumulates every row before its promise resolves, so a
// `SELECT * FROM big_table` pulled hundreds of megabytes into the host process
// just for the existing `cap` to keep 200 rows. Oracle was already safe
// (its `maxRows` bounds the fetch server-side); this brings the others in line
// for the one path that cannot simply append `LIMIT` — a statement the paging
// predicate does not recognise.
//
// Wrapping in a derived table is what makes it safe for arbitrary user SQL: the
// outer bound cannot change the statement's meaning, and a query carrying its
// own LIMIT/OFFSET keeps it. `limit + 1` is requested so the caller can still
// tell "exactly at the cap" from "there is more".
//
// Only SELECTs are wrapped. A non-SELECT returns no rows to buffer, and wrapping
// one in a subquery is a syntax error, so it passes through untouched.
export function boundedSelect(type, sql, limit) {
  const text = String(sql || "").trim().replace(/;\s*$/, "");
  if (!looksLikeSelect(text)) return sql;
  // A missing or nonsensical limit means "no bound was requested", so the
  // statement is returned untouched. Coercing it to a small number instead would
  // silently truncate the result to a couple of rows.
  const requested = Math.floor(Number(limit));
  if (!Number.isFinite(requested) || requested < 1) return sql;
  const n = requested;
  // A CTE is bounded by a trailing clause instead of a derived table: MySQL
  // rejects `SELECT * FROM (WITH … SELECT …) x`, while `WITH … SELECT … LIMIT n`
  // is valid everywhere. A leading parenthesised SELECT cannot take a trailing
  // LIMIT either (it is part of a larger expression), so only a plain SELECT is
  // wrapped.
  if (/^with\s+/i.test(text)) {
    return type === "oracle"
      ? text + " FETCH FIRST " + (n + 1) + " ROWS ONLY"
      : text + " LIMIT " + (n + 1);
  }
  const inner = "SELECT * FROM (" + text + ") " + quoteIdent(type, "ddb_q");
  // Oracle only grew OFFSET/FETCH in 12.1, so the bound is a ROWNUM predicate
  // there; the wrapper itself is shared because a derived table is valid in all
  // three dialects (the alias is required by MySQL/PostgreSQL, harmless on
  // Oracle).
  return type === "oracle"
    ? inner + " WHERE ROWNUM <= " + (n + 1)
    : inner + " LIMIT " + (n + 1);
}

export function wherePk(type, pkCols, pkValues, params) {
  return pkCols.map((col) => {
    const value = pkValues ? pkValues[col] : undefined;
    if (value === null || value === undefined) return quoteIdent(type, col) + " IS NULL";
    params.push(value);
    return quoteIdent(type, col) + " = " + ph(type, params.length);
  }).join(" AND ");
}

export function oracleVersionLabel(version) {
  const n = Number(version) || 0;
  if (n <= 0) return "";
  const text = String(n).padStart(10, "0");
  const parts = [0, 2, 4, 6, 8].map((i) => String(Number(text.slice(i, i + 2))));
  while (parts.length > 2 && parts[parts.length - 1] === "0") parts.pop();
  return parts.join(".");
}

export function oracleUsesFetch(handle) {
  return (Number(handle && handle.serverVersion) || 0) >= ORACLE_FETCH_MIN;
}

export async function pageQuery(type, handle, sql, limit, offset) {
  const lim = Math.max(1, Number(limit) || PREVIEW_ROWS);
  const off = Math.max(0, Number(offset) || 0);
  if (type === "oracle" && !oracleUsesFetch(handle)) {
    const bound = off + lim;
    const data = await handle.query(
      "SELECT * FROM (" + sql + ") WHERE ROWNUM <= " + (bound + 1),
      undefined,
      bound + 1,
    );
    const rows = data.rows || [];
    const page = rows.slice(off, off + lim);
    return { ...data, rows: page, truncated: rows.length > bound, rowCount: page.length };
  }
  const paged = off > 0
    ? (type === "oracle" ? sql + " OFFSET " + off + " ROWS FETCH NEXT " + lim + " ROWS ONLY" : sql + " LIMIT " + lim + " OFFSET " + off)
    : (type === "oracle" ? sql + " FETCH FIRST " + lim + " ROWS ONLY" : sql + " LIMIT " + lim);
  return handle.query(paged, undefined, lim);
}

export function oracleMissingName(sql) {
  const text = stripSqlNoise(sql, "oracle");
  const ident = "(\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_$#]*)";
  const m = new RegExp("\\b(?:from|join|into|update|table)\\s+" + ident + "(?:\\s*\\.\\s*" + ident + ")?", "i").exec(text);
  if (!m) return { schema: "", table: "" };
  return m[2]
    ? { schema: unquoteIdent(m[1]), table: unquoteIdent(m[2]) }
    : { schema: "", table: unquoteIdent(m[1]) };
}
