import { Buffer } from "node:buffer";
import {
  MAX_ROWS,
  PREVIEW_ROWS,
  EXPORT_ROWS,
  IMPORT_STATEMENTS_MAX,
  IMPORT_BYTES_MAX,
  EXPORT_BYTES_MAX,
  quoteIdent,
  qualifyTable,
  resultOf,
  sqlLiteral,
  ph,
  looksLikeSelect,
  alreadyPaged,
  writableTarget,
  splitSql,
  affected,
  wherePk,
  pageQuery,
  oracleUsesFetch,
  destructiveStatements,
  mapBounded,
  boundedSelect,
  statementCommand,
  statementForExecute,
} from "./sql.js";
import * as postgres from "./engines/postgres.js";
import * as mysql from "./engines/mysql.js";
import * as oracle from "./engines/oracle.js";
import * as redis from "./engines/redis.js";
import { safeMessage } from "./live.js";

// How many catalogue lookups one export fans out at a time. Small on purpose:
// the pool behind a handle holds 3 connections, so a wide window would only
// queue inside the driver.
const SCHEMA_FANOUT = 4;

const engines = { postgres, mysql, oracle, redis };

function engineOf(conn) {
  return engines[conn && conn.type];
}

export async function sqlHandle(conn, database) {
  const engine = engineOf(conn);
  if (!engine || conn.type === "redis") throw new Error("not-sql");
  return engine.handle(conn, database);
}

export async function redisHandle(conn, dbIndex) {
  return redis.handle(conn, dbIndex);
}

export async function listSchemas(conn) {
  const engine = engineOf(conn);
  if (!engine || !engine.schemas) return { items: [] };
  return engine.schemas(conn);
}

export async function childrenOf(conn, path) {
  const engine = engineOf(conn);
  if (!engine || !engine.children) return [];
  return engine.children(conn, path || { kind: "root" });
}

export async function primaryKeys(conn, handle, path) {
  const engine = engineOf(conn);
  if (!engine || !engine.primaryKeys) return [];
  try {
    return await engine.primaryKeys(handle, path);
  } catch {
    return [];
  }
}

export async function describeTable(conn, path) {
  if (conn.type === "redis") throw new Error("redis-not-table");
  const engine = engineOf(conn);
  if (!engine || !engine.describe) throw new Error("unsupported-type");
  const database = path.database || conn.database || "";
  const handle = await engine.handle(conn, database);
  const table = String(path.table || "");
  if (!table) throw new Error("table-required");
  const described = await engine.describe(handle, { ...path, table });
  const columns = described.columns || [];
  let pk = [];
  try { pk = await primaryKeys(conn, handle, { ...path, table }); } catch { pk = []; }
  const pkSet = new Set(pk.map((name) => String(name).toLowerCase()));
  for (const column of columns) {
    if (column.primaryKey === undefined) column.primaryKey = pkSet.has(column.name.toLowerCase());
  }
  return {
    kind: path.tableType === "view" ? "view" : "table",
    table,
    schema: path.schema || "",
    database,
    comment: described.comment || "",
    pk,
    columns,
  };
}

/**
 * One page, with "there is more" made observable — on the paths that promise
 * everything.
 *
 * `pageQuery` appends `LIMIT cap`, so a result of exactly `cap` rows is
 * indistinguishable from a truncated one: the driver returns no flag, and an
 * `all:true` export of a 200k-row table arrived as 5000 rows labelled complete.
 * Ask for one row past the cap and drop it; the overflow is the signal.
 *
 * Only `exact` (the `all` paths) does this. A paged preview already knows
 * `total` from its own COUNT, and flagging every page but the last as truncated
 * would read as data loss to the user.
 */
async function cappedPage(conn, handle, sql, cap, offset, exact) {
  if (exact !== true) return pageQuery(conn.type, handle, sql, cap, offset);
  const data = await pageQuery(conn.type, handle, sql, cap + 1, offset);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const overflow = rows.length > cap || data.truncated === true;
  const page = rows.length > cap ? rows.slice(0, cap) : rows;
  return { ...data, rows: page, truncated: overflow, rowCount: page.length };
}

export async function previewTable(conn, path) {
  if (conn.type === "redis") throw new Error("redis-not-table");
  const database = path.database || conn.database || "";
  const handle = await sqlHandle(conn, database);
  const table = qualifyTable(conn.type, path.schema, path.table);
  const all = path.all === true;
  const pageSize = Math.min(Math.max(1, Number(path.limit) || PREVIEW_ROWS), EXPORT_ROWS);
  const offset = all ? 0 : Math.max(0, Number(path.offset) || 0);
  const cap = all ? EXPORT_ROWS : pageSize;
  let total = 0;
  try {
    const count = await handle.query("SELECT COUNT(*) FROM " + table, undefined, 1);
    const value = count.rows && count.rows[0] ? count.rows[0][0] : 0;
    total = Number(value) || 0;
  } catch {
    total = 0;
  }
  const data = await cappedPage(conn, handle, "SELECT * FROM " + table, cap, offset, all);
  const pk = await primaryKeys(conn, handle, path);
  if (!total) total = offset + (data.rows || []).length + (data.truncated ? 1 : 0);
  return { ...data, pk, total, offset, limit: cap, all };
}

// One cell at full length, fetched by primary key. The grid only ever receives
// display-truncated values (CELL_CHARS_MAX), so editing a long cell starts from
// a cut string — and committing that cut string would corrupt the column. The
// client re-reads the single value through here before the editor opens.
//
// The ceiling is deliberately far above the display cap but not unlimited: a
// multi-megabyte string cannot be edited in a single-line input anyway, and
// handing it to the page would stall the grid. Past this the caller is told
// the value is still cut and refuses to edit it.
const CELL_FETCH_CHARS = 100_000;

function limitSql(type, handle, sql, n) {
  if (type === "oracle" && !oracleUsesFetch(handle)) {
    return "SELECT * FROM (" + sql + ") WHERE ROWNUM <= " + n;
  }
  if (type === "oracle") return sql + " FETCH FIRST " + n + " ROWS ONLY";
  return sql + " LIMIT " + n;
}

export async function readCell(conn, body) {
  if (conn.type === "redis") throw new Error("redis-not-table");
  const column = String(body.column || "");
  if (!column) throw new Error("column-required");
  if (!body.table) throw new Error("table-required");
  const handle = await sqlHandle(conn, body.database || conn.database);
  if (typeof handle.queryCell !== "function") throw new Error("cell-unavailable");
  const table = qualifyTable(conn.type, body.schema, body.table);
  const pk = await primaryKeys(conn, handle, body);
  if (pk.length === 0) throw new Error("no-primary-key");
  const params = [];
  const inner = "SELECT " + quoteIdent(conn.type, column) + " FROM " + table
    + " WHERE " + wherePk(conn.type, pk, body.pk || {}, params);
  // Not `pageQuery` / `handle.query`: those run `resultOf`, which has already
  // cut the value to the grid cap (and, on Oracle, closed the LOB) before this
  // function could read it. Bind params have to travel with the statement;
  // `pageQuery` drops them. `queryCell` reads and closes LOBs inside the
  // handle's own serialization slot, so this wait is not on the shared session.
  const data = await handle.queryCell(limitSql(conn.type, handle, inner, 2), params, 2, column, CELL_FETCH_CHARS);
  if (!data || data.found !== true) return { value: null, missing: true };
  return { value: data.value, truncated: data.cut === true };
}

export async function updateRows(conn, body) {
  if (conn.type === "redis") throw new Error("redis-not-table");
  const updates = Array.isArray(body.changes) ? body.changes : [];
  const inserts = Array.isArray(body.inserts) ? body.inserts : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  if (updates.length === 0 && inserts.length === 0 && deletes.length === 0) return { ok: true, rowCount: 0 };
  const handle = await sqlHandle(conn, body.database || conn.database);
  const table = qualifyTable(conn.type, body.schema, body.table);
  const pk = await primaryKeys(conn, handle, body);
  if ((updates.length || deletes.length) && pk.length === 0) throw new Error("no-primary-key");
  let total = 0;
  await handle.transact(async (q) => {
    for (const row of deletes) {
      const params = [];
      const sql = "DELETE FROM " + table + " WHERE " + wherePk(conn.type, pk, row.pk || {}, params);
      total += affected(await q(sql, params));
    }
    for (const change of updates) {
      const setCols = Object.keys(change.set || {});
      if (setCols.length === 0) continue;
      const params = [];
      const setSql = setCols.map((col) => {
        params.push(change.set[col]);
        return quoteIdent(conn.type, col) + " = " + ph(conn.type, params.length);
      });
      const sql = "UPDATE " + table + " SET " + setSql.join(", ") + " WHERE " + wherePk(conn.type, pk, change.pk || {}, params);
      total += affected(await q(sql, params));
    }
    for (const row of inserts) {
      const set = row.set || {};
      const cols = Object.keys(set).filter((col) => set[col] !== undefined);
      if (cols.length === 0) continue;
      const params = cols.map((col) => set[col]);
      const sql = "INSERT INTO " + table + " (" + cols.map((col) => quoteIdent(conn.type, col)).join(", ") + ") VALUES (" + cols.map((_, i) => ph(conn.type, i + 1)).join(", ") + ")";
      total += affected(await q(sql, params));
    }
  });
  return { ok: true, rowCount: total };
}

async function runStatement(conn, handle, sql, body) {
  const executable = statementForExecute(conn.type, sql);
  const all = body.all === true;
  const wantPage = all || body.limit != null || body.offset != null;
  const sessionSchema = conn.type === "oracle" ? (handle.schema || "") : "";
  const target = writableTarget(conn, executable, sessionSchema);
  const pk = target ? await primaryKeys(conn, handle, { ...target, database: body.database || conn.database }) : [];
  const meta = {
    writable: false,
    target: target || null,
    pk,
    connId: conn.id,
    connType: conn.type,
    database: body.database || conn.database || "",
  };
  const finalize = (data) => {
    const cols = (data && data.columns) || [];
    const pkPresent = pk.length > 0 && pk.every((name) => cols.indexOf(name) >= 0);
    const out = { ...data, ...meta, writable: !!target && pkPresent };
    // No field list means this was not a query. MySQL and Oracle do not tag the
    // verb; fill it from the SQL so the client can say "updated N" instead of
    // "no rows returned".
    if (!cols.length && !out.command) out.command = statementCommand(executable);
    return out;
  };
  if (wantPage && looksLikeSelect(executable) && !alreadyPaged(executable, conn.type)) {
    const pageSize = Math.min(Math.max(1, Number(body.limit) || PREVIEW_ROWS), EXPORT_ROWS);
    const offset = all ? 0 : Math.max(0, Number(body.offset) || 0);
    const cap = all ? EXPORT_ROWS : pageSize;
    let total = 0;
    try {
      const count = await handle.query("SELECT COUNT(*) FROM (" + executable + ") q", undefined, 1);
      const value = count.rows && count.rows[0] ? count.rows[0][0] : 0;
      total = Number(value) || 0;
    } catch {
      total = 0;
    }
    const data = await cappedPage(conn, handle, executable, cap, offset, all);
    if (!total) total = offset + (data.rows || []).length + (data.truncated ? 1 : 0);
    return finalize({ ...data, total, offset, limit: cap, all });
  }
  // The paged paths append LIMIT/OFFSET, so the server bounds them. This last
  // path cannot: the statement is arbitrary user SQL (a CTE, a UNION, or one
  // that already carries its own LIMIT), so the bound is applied by wrapping it
  // in a derived table. Without that, the driver buffers the entire result set —
  // `pg` accumulates every row before resolving — and only then is it sliced to
  // MAX_ROWS.
  return finalize(await handle.query(boundedSelect(conn.type, executable, MAX_ROWS), undefined, MAX_ROWS));
}

export async function runQuery(conn, body) {
  if (conn.type === "redis") {
    const handle = await redisHandle(conn, body.database);
    const command = String(body.sql || body.command || "").trim();
    if (command === "") throw new Error("empty-command");
    const parts = command.split(/\s+/);
    if (redis.commandBlocked(command)) throw new Error("command-not-allowed");
    const value = await handle.client.call(parts[0], ...parts.slice(1));
    let text;
    if (value === null) text = "(nil)";
    else if (Array.isArray(value)) text = value.map((item) => (item === null ? "(nil)" : String(item))).join("\n");
    else text = String(value);
    return {
      ...resultOf(["result"], [[text]], false),
      writable: false,
      target: null,
      pk: [],
      connType: conn.type,
      connId: conn.id,
      database: body.database || conn.database || "",
    };
  }
  const handle = await sqlHandle(conn, body.database || conn.database);
  return runStatement(conn, handle, String(body.sql || ""), body);
}

// One script, one request. Statements run in order on the same handle. A
// failure is reported on that statement and the rest still run, matching a
// SQL*Plus script: one bad ALTER must not abandon the later statements.
// Each result still carries its own `sql` for paging and a result tab.
export async function runScript(conn, body) {
  if (conn.type === "redis") {
    const value = await runQuery(conn, body);
    return { results: [{ ...value, sql: String(body.sql || body.command || "") }] };
  }
  const statements = splitSql(String(body.sql || ""), conn.type);
  if (statements.length === 0) throw new Error("empty-sql");
  const handle = await sqlHandle(conn, body.database || conn.database);
  const results = [];
  for (const stmt of statements) {
    try {
      const value = await runStatement(conn, handle, stmt, { ...body, offset: 0, all: false });
      results.push({ ...value, sql: stmt });
    } catch (error) {
      const message = safeMessage(error);
      results.push({
        error: message,
        sql: stmt,
        columns: ["error"],
        rows: [[message]],
        writable: false,
        connType: conn.type,
        connId: conn.id,
        database: body.database || conn.database || "",
      });
    }
  }
  return { results };
}

export async function inspectKey(conn, path) {
  return redis.inspect(conn, path);
}

export async function deleteKey(conn, body) {
  if (!conn || conn.type !== "redis") throw new Error("not-redis");
  return redis.removeKey(conn, { database: body && body.database, key: body && body.key });
}

export async function testConn(conn) {
  const engine = engineOf(conn);
  if (!engine || !engine.test) throw new Error("unsupported-type");
  return engine.test(conn);
}

export async function listTables(conn, path) {
  const kind = path && path.table ? "table" : path && path.schema ? "schema" : path && path.database ? "database" : "root";
  if (kind === "root") {
    if (conn.type === "postgres") return listTables(conn, { database: conn.database || "postgres" });
    if (conn.type === "mysql") {
      if (conn.database) return listTables(conn, { database: conn.database });
      const dbs = (await childrenOf(conn, { kind: "root" })).filter((item) => ["information_schema", "mysql", "performance_schema", "sys"].indexOf(item.name) < 0);
      const lists = await mapBounded(dbs.slice(0, 8), SCHEMA_FANOUT, (db) =>
        listTables(conn, { database: db.name }));
      return lists.flat();
    }
  }
  if (kind === "table") {
    return [{ name: path.table, schema: path.schema || "", database: path.database || "", tableType: "table" }];
  }
  if (conn.type === "mysql" && kind === "database") {
    const items = await childrenOf(conn, { kind: "database", name: path.database });
    return items.filter((item) => item.kind === "table").map((item) => ({ ...item, database: path.database, schema: path.database }));
  }
  if (conn.type === "postgres" && kind === "database") {
    const schemas = await childrenOf(conn, { kind: "database", name: path.database });
    // One round trip per schema, overlapped instead of serialized: a database
    // with 50 schemas used to take 50 sequential queries before the export
    // could even start writing rows.
    const lists = await mapBounded(schemas, SCHEMA_FANOUT, (schema) =>
      childrenOf(conn, { kind: "schema", name: schema.name, database: path.database }));
    const tables = [];
    for (const items of lists) {
      for (const item of items) if (item.kind === "table" && item.tableType !== "view") tables.push(item);
    }
    return tables;
  }
  if ((conn.type === "postgres" || conn.type === "oracle") && kind === "schema") {
    const items = await childrenOf(conn, { kind: "schema", name: path.schema, database: path.database });
    return items.filter((item) => item.kind === "table");
  }
  if (conn.type === "oracle" && kind === "root") {
    const schemas = await childrenOf(conn, { kind: "root" });
    const lists = await mapBounded(schemas.slice(0, 40), SCHEMA_FANOUT, (schema) =>
      childrenOf(conn, { kind: "schema", name: schema.name, database: conn.database }));
    const tables = [];
    for (const items of lists) {
      for (const item of items) if (item.kind === "table" && item.tableType !== "view") tables.push(item);
    }
    return tables;
  }
  return [];
}

export async function exportSql(conn, path) {
  if (conn.type === "redis") {
    const index = path && path.database !== undefined && path.database !== "" ? Number(path.database) : 0;
    const handle = await redisHandle(conn, index);
    const keys = await redis.scanKeys(handle.client, EXPORT_ROWS);
    const records = [];
    for (const key of keys) {
      const type = await handle.client.type(key);
      let value = null;
      if (type === "string") value = await handle.client.get(key);
      else if (type === "hash") value = await handle.client.hgetall(key);
      else if (type === "list") value = await handle.client.lrange(key, 0, 999);
      else if (type === "set") value = await handle.client.smembers(key);
      else if (type === "zset") value = await handle.client.zrange(key, 0, 999, "WITHSCORES");
      records.push({ key, type, value });
    }
    const filename = (conn.name || "redis") + "-db" + index + ".json";
    return { filename, sql: JSON.stringify({ db: index, keys: records }, null, 2), truncated: keys.length >= EXPORT_ROWS };
  }
  const tables = await listTables(conn, path || {});
  if (tables.length === 0) throw new Error("nothing-to-export");
  const chunks = ["-- dsh-database export", "-- connection: " + conn.name, ""];
  // The whole dump is assembled in memory and returned as a single response
  // body, so it needs a ceiling of its own: rows are already capped per table,
  // but a database with hundreds of tables still adds up. Passing the cap is
  // reported through `truncated`, which beats an out-of-memory kill that would
  // lose the entire export.
  let bytes = 0;
  let truncated = false;
  for (const table of tables) {
    // Stop before the accumulated dump outgrows what one response can carry.
    if (bytes >= EXPORT_BYTES_MAX) { truncated = true; break; }
    const handle = await sqlHandle(conn, table.database || conn.database);
    const qname = qualifyTable(conn.type, table.schema, table.name);
    chunks.push("-- table " + qname);
    if (conn.type === "mysql") {
      try {
        const create = await handle.query("SHOW CREATE TABLE " + qname, undefined, 1);
        const ddl = create.rows[0] && create.rows[0][1];
        if (ddl) chunks.push(String(ddl) + ";", "");
      } catch {}
    }
    // Bounded in the statement, not after the fact: `SELECT * FROM t` buffers
    // the whole table in the driver before the `EXPORT_ROWS` slice runs, so a
    // large table cost its full size in host memory to export 5000 rows of it.
    // Asking the server for one row past the cap keeps the existing truncation
    // signal intact.
    const data = await handle.query(
      boundedSelect(conn.type, "SELECT * FROM " + qname, EXPORT_ROWS),
      undefined,
      EXPORT_ROWS + 1,
    );
    if (data.truncated || data.rows.length > EXPORT_ROWS) truncated = true;
    const rows = data.rows.slice(0, EXPORT_ROWS);
    const cols = data.columns.map((col) => quoteIdent(conn.type, col)).join(", ");
    for (const row of rows) {
      const values = row.map((value) => sqlLiteral(conn.type, value)).join(", ");
      const line = "INSERT INTO " + qname + " (" + cols + ") VALUES (" + values + ");";
      // Counted as UTF-8, so a table of CJK text is measured by what it will
      // actually occupy rather than by its character count.
      bytes += Buffer.byteLength(line, "utf8") + 1;
      chunks.push(line);
      if (bytes >= EXPORT_BYTES_MAX) { truncated = true; break; }
    }
    if (bytes >= EXPORT_BYTES_MAX) break;
    chunks.push("");
  }
  const scope = path && path.table ? path.table : path && path.schema ? path.schema : path && path.database ? path.database : conn.name;
  return { filename: String(scope || "export") + ".sql", sql: chunks.join("\n"), truncated };
}

export async function importSql(conn, body) {
  if (conn.type === "redis") {
    const parsed = typeof body.sql === "string" && body.sql.trim().charAt(0) === "{"
      ? JSON.parse(body.sql)
      : body.data;
    const db = parsed && parsed.db !== undefined ? Number(parsed.db) : Number(body.database || 0);
    const handle = await redisHandle(conn, db);
    const keys = parsed && Array.isArray(parsed.keys) ? parsed.keys : [];
    let n = 0;
    for (const item of keys) {
      if (!item || typeof item.key !== "string") continue;
      // Every branch replaces the key wholesale, matching what the export wrote:
      // merging into an existing key would silently resurrect old members the
      // dump no longer has.
      if (item.type === "string" || item.type === undefined) await handle.client.set(item.key, item.value == null ? "" : String(item.value));
      else if (item.type === "hash" && item.value && typeof item.value === "object") {
        const entries = Object.entries(item.value);
        if (entries.length) {
          await handle.client.del(item.key);
          await handle.client.hset(item.key, item.value);
        }
      } else if (item.type === "list" && Array.isArray(item.value) && item.value.length) {
        await handle.client.del(item.key);
        await handle.client.rpush(item.key, ...item.value.map(String));
      } else if (item.type === "set" && Array.isArray(item.value) && item.value.length) {
        await handle.client.del(item.key);
        await handle.client.sadd(item.key, ...item.value.map(String));
      } else if (item.type === "zset" && Array.isArray(item.value) && item.value.length) {
        // The export shape is zrange(..., WITHSCORES): flat [member, score, ...].
        await handle.client.del(item.key);
        const args = [];
        for (let i = 0; i + 1 < item.value.length; i += 2) {
          args.push(String(item.value[i + 1]), String(item.value[i]));
        }
        if (args.length) await handle.client.zadd(item.key, ...args);
      }
      n += 1;
    }
    return { ok: true, statements: n };
  }
  const handle = await sqlHandle(conn, body.database || conn.database);
  const text = body.sql || "";
  if (Buffer.byteLength(text, "utf8") > IMPORT_BYTES_MAX) throw new Error("import-too-large");
  const statements = splitSql(text, conn.type);
  if (statements.length === 0) throw new Error("empty-sql");
  if (statements.length > IMPORT_STATEMENTS_MAX) throw new Error("import-too-many-statements");
  // DROP/TRUNCATE are held back for an explicit second confirmation. The client
  // sends `confirmDestructive` only after showing the user exactly which
  // statements they are; an unacknowledged import of them runs nothing at all
  // rather than running them silently.
  const destructive = destructiveStatements(statements, conn.type);
  if (destructive.length > 0 && body.confirmDestructive !== true) {
    return { ok: false, needsConfirm: true, destructive, statements: 0 };
  }
  // One package, one transaction: a statement that fails mid-way rolls the whole
  // import back instead of leaving the database holding a prefix of the dump.
  let n = 0;
  await handle.transact(async (q) => {
    for (const stmt of statements) {
      try {
        await q(stmt);
      } catch (error) {
        // Everything so far has been rolled back; say how far it got and which
        // statement failed (truncated — a dump line can be megabytes).
        throw new Error("import-failed（已执行 " + n + " 条，已回滚）："
          + stmt.replace(/\s+/g, " ").slice(0, 80)
          + " —— " + safeMessage(error));
      }
      n += 1;
    }
  });
  return { ok: true, statements: n };
}
