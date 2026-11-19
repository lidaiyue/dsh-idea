import { MAX_ROWS, MAX_CHILDREN, resultOf, writeMeta, firstCell, schemaAllowed, catalogueComment, materializeCell } from "../sql.js";
import { CONNECT_MS, QUERY_MS, loadModule, liveKey, peekLive, rememberLive, touchLive, tlsOptions } from "../live.js";

export const type = "mysql";

export async function handle(conn, database) {
  const key = liveKey(conn, database || conn.database || "");
  const existing = peekLive(key);
  if (existing) {
    touchLive(key);
    return existing;
  }
  const mysql = await loadModule("mysql2/promise", "MySQL");
  const pool = mysql.createPool({
    host: conn.host || "127.0.0.1",
    port: Number(conn.port) || 3306,
    user: conn.user || undefined,
    password: conn.password || undefined,
    database: database || conn.database || undefined,
    ssl: conn.ssl === true ? tlsOptions(conn) : undefined,
    connectTimeout: CONNECT_MS,
    connectionLimit: 3,
    multipleStatements: true,
    // BIGINT/DECIMAL beyond 2^53 lose digits as JS numbers before the grid ever
    // sees them; strings keep the exact text. Dates as strings also avoid the
    // driver's Date round-trip re-rendering them in the local time zone.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  const next = {
    type: "mysql",
    async query(sql, params, limit) {
      const cap = typeof limit === "number" ? limit : MAX_ROWS;
      const [rows, fields] = await pool.query({
        sql,
        values: Array.isArray(params) ? params : undefined,
        rowsAsArray: true,
        timeout: QUERY_MS,
      });
      const list = Array.isArray(rows) ? rows : [];
      const columns = Array.isArray(fields) ? fields.map((field) => field.name) : [];
      const truncated = list.length > cap;
      // DML comes back as a ResultSetHeader, not a row array. affectedRows of 0
      // must survive — a truthiness check would report it as unknown.
      const header = Array.isArray(rows) ? null : rows;
      return writeMeta(
        resultOf(columns, truncated ? list.slice(0, cap) : list, truncated),
        header && typeof header.affectedRows === "number" ? header.affectedRows : undefined,
      );
    },
    // Same contract as the PostgreSQL handle: shape the one cell here, at the
    // editor's ceiling, instead of letting `resultOf` cut it to the grid's.
    async queryCell(sql, params, limit, column, maxChars) {
      const cap = typeof limit === "number" ? limit : 2;
      const [rows] = await pool.query({
        sql,
        values: Array.isArray(params) ? params : undefined,
        rowsAsArray: true,
        timeout: QUERY_MS,
      });
      const list = (Array.isArray(rows) ? rows : []).slice(0, cap);
      if (list.length !== 1) return { found: false, value: null, cut: false };
      const row = list[0];
      const shaped = await materializeCell(Array.isArray(row) ? row[0] : row[column], maxChars);
      return { found: true, value: shaped.value, cut: shaped.cut === true };
    },
    async exec(sql, params) {
      const [result] = await pool.query({
        sql,
        values: Array.isArray(params) ? params : undefined,
        timeout: QUERY_MS,
      });
      return { rowCount: result && result.affectedRows ? result.affectedRows : 0 };
    },
    async transact(fn) {
      const client = await pool.getConnection();
      try {
        await client.beginTransaction();
        const q = async (sql, params) => {
          const [result] = await client.query({
            sql,
            values: Array.isArray(params) ? params : undefined,
            // Same cap as the pool path: one slow statement inside a
            // transaction must not hold its connection forever.
            timeout: QUERY_MS,
          });
          return result;
        };
        const value = await fn(q);
        await client.commit();
        return value;
      } catch (error) {
        try { await client.rollback(); } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return rememberLive(key, next);
}

export async function schemas(conn) {
  const db = await handle(conn, conn.database || undefined);
  const result = await db.query("SHOW DATABASES", undefined, MAX_CHILDREN);
  return { items: result.rows.map((row) => ({ name: String(firstCell(row)), database: String(firstCell(row)) })) };
}

export async function children(conn, path) {
  const kind = path && path.kind ? path.kind : "root";
  if (kind === "root") {
    const db = await handle(conn, conn.database || undefined);
    const result = await db.query("SHOW DATABASES");
    return result.rows
      .map((row) => String(firstCell(row)))
      .filter((name) => schemaAllowed(conn, name))
      .slice(0, MAX_CHILDREN)
      .map((name) => ({ kind: "database", name }));
  }
  if (kind === "database") {
    const db = await handle(conn, path.name);
    const result = await db.query(
      "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME",
      [path.name],
    );
    return result.rows.slice(0, MAX_CHILDREN).map((row) => {
      const tableType = String(row[1] || "").toLowerCase().indexOf("view") >= 0 ? "view" : "table";
      return {
        kind: "table",
        name: String(row[0]),
        tableType,
        comment: catalogueComment(row[2], tableType),
        database: path.name,
        schema: path.name,
      };
    });
  }
  return [];
}

export async function primaryKeys(db, path) {
  const result = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE lower(TABLE_SCHEMA) = lower(?) AND lower(TABLE_NAME) = lower(?) AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
    [path.database || path.schema, path.table],
    50,
  );
  return result.rows.map((row) => String(row[0]));
}

export async function describe(db, path) {
  const table = String(path.table || "");
  const result = await db.query(
    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE lower(TABLE_SCHEMA) = lower(?) AND lower(TABLE_NAME) = lower(?) ORDER BY ORDINAL_POSITION",
    [path.database || path.schema, table],
    MAX_ROWS,
  );
  const columns = result.rows.map((row) => {
    const extra = String(row[6] || "");
    return {
      name: String(row[0]),
      dataType: String(row[1] || ""),
      nullable: String(row[2] || "").toUpperCase() === "YES",
      default: row[3] === null || row[3] === undefined ? "" : String(row[3]),
      comment: String(row[4] || ""),
      autoIncrement: /auto_increment/i.test(extra),
      primaryKey: String(row[5] || "").toUpperCase() === "PRI",
    };
  });
  let comment = "";
  try {
    const desc = await db.query(
      "SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE lower(TABLE_SCHEMA) = lower(?) AND lower(TABLE_NAME) = lower(?)",
      [path.database || path.schema, table],
      1,
    );
    const value = desc.rows.length ? firstCell(desc.rows[0]) : null;
    comment = value === null || value === undefined ? "" : String(value);
  } catch {}
  return { columns, comment };
}

export async function test(conn) {
  const db = await handle(conn, conn.database);
  await db.query("SELECT 1");
  return { ok: true, message: "ok" };
}
