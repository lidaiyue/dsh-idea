import { MAX_ROWS, MAX_CHILDREN, resultOf, writeMeta, firstCell, schemaFilterOf, pgBuiltinDatabase, catalogueComment, materializeCell, mapBounded } from "../sql.js";
import { CONNECT_MS, QUERY_MS, loadModule, liveKey, peekLive, rememberLive, touchLive, tlsOptions } from "../live.js";

export const type = "postgres";

// Caps for the schema picker's per-database fan-out. A picker with thousands of
// databases is unusable anyway; a smaller cap keeps the live registry from
// parking a pool behind every database in the cluster.
const SCHEMA_DATABASES_MAX = 50;
const SCHEMA_FANOUT = 6;

export async function handle(conn, database) {
  const key = liveKey(conn, database || conn.database || "postgres");
  const existing = peekLive(key);
  if (existing) {
    touchLive(key);
    return existing;
  }
  const pg = await loadModule("pg", "PostgreSQL");
  const pool = new pg.Pool({
    host: conn.host || "127.0.0.1",
    port: Number(conn.port) || 5432,
    user: conn.user || undefined,
    password: conn.password || undefined,
    database: database || conn.database || "postgres",
    ssl: conn.ssl === true ? tlsOptions(conn) : undefined,
    max: 3,
    connectionTimeoutMillis: CONNECT_MS,
    idleTimeoutMillis: 60000,
    // A query on a locked table never returns on its own, and it holds one of
    // this pool's three slots while it waits — three of those and the whole
    // connection is unresponsive, including the tree. MySQL already capped this
    // per query (`timeout: QUERY_MS`); PostgreSQL had no bound at all.
    //
    // Two layers on purpose: `statement_timeout` makes the *server* abandon the
    // work (releasing locks and CPU), and `query_timeout` is the client-side
    // backstop for anything the server-side setting does not cover.
    statement_timeout: QUERY_MS,
    query_timeout: QUERY_MS,
  });
  const next = {
    type: "postgres",
    async query(sql, params, limit) {
      const cap = typeof limit === "number" ? limit : MAX_ROWS;
      const result = await pool.query({
        text: sql,
        values: Array.isArray(params) ? params : undefined,
        rowMode: "array",
      });
      const columns = (result.fields || []).map((field) => field.name);
      const rows = result.rows || [];
      const truncated = rows.length > cap;
      // UPDATE/INSERT/DELETE have no fields. rowCount is affected rows, and 0 is
      // real — `||` would turn it into "unknown".
      return writeMeta(
        resultOf(columns, truncated ? rows.slice(0, cap) : rows, truncated),
        typeof result.rowCount === "number" ? result.rowCount : undefined,
        result.command,
      );
    },
    // One cell past the grid's display cap. `query` would already have cut it
    // through `resultOf`, so the value is shaped here from the driver's bytes.
    async queryCell(sql, params, limit, column, maxChars) {
      const cap = typeof limit === "number" ? limit : 2;
      const result = await pool.query({
        text: sql,
        values: Array.isArray(params) ? params : undefined,
        rowMode: "array",
      });
      const rows = (result.rows || []).slice(0, cap);
      if (rows.length !== 1) return { found: false, value: null, cut: false };
      const row = rows[0];
      const shaped = await materializeCell(Array.isArray(row) ? row[0] : row[column], maxChars);
      return { found: true, value: shaped.value, cut: shaped.cut === true };
    },
    async exec(sql, params) {
      const result = await pool.query({
        text: sql,
        values: Array.isArray(params) ? params : undefined,
      });
      return { rowCount: result.rowCount || 0 };
    },
    async transact(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q = async (sql, params) => client.query({
          text: sql,
          values: Array.isArray(params) ? params : undefined,
        });
        const value = await fn(q);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
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

// PG namespace is per-database, so a connection with `database = mydb` cannot see
// `otherdb.public`. The picker still wants every choice the user could mean, and
// all of them would have to coexist on screen if they share a name across
// databases. Each option is therefore named `<database>.<schema>` and carries the
// owning database in a separate field, so the picker can render an unambiguous
// label and a connection that filters on it can match the same string back out
// in `children()`.
export async function schemas(conn) {
  const db = await handle(conn, conn.database || "postgres");
  const dbs = await db.query("SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1", undefined, MAX_CHILDREN);
  const hideBuiltins = conn.hideBuiltinDatabases !== false;
  const names = dbs.rows
    .map((row) => String(firstCell(row)))
    .filter((name) => name && (!hideBuiltins || !pgBuiltinDatabase(name)))
    .slice(0, SCHEMA_DATABASES_MAX);
  // One serial `await` per database turned a many-database cluster into that
  // many round trips, and left a live pool parked behind every one of them for
  // the idle TTL. A small fixed window (the same helper exports use) overlaps
  // the round trips without opening a socket per database.
  const lists = await mapBounded(names, SCHEMA_FANOUT, async (database) => {
    const perDb = await handle(conn, database);
    try {
      const result = await perDb.query(
        "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1",
        undefined,
        MAX_CHILDREN,
      );
      return result.rows;
    } catch {
      // The user may list databases but lack CONNECT on some; skip the ones
      // they cannot read rather than fail the whole picker for one bad grant.
      return [];
    }
  });
  const items = [];
  lists.forEach((rows, index) => {
    const database = names[index];
    for (const schemaRow of rows) {
      const schema = String(firstCell(schemaRow));
      if (!schema) continue;
      items.push({ name: database + "." + schema, database, schema });
    }
  });
  return { items };
}

export async function children(conn, path) {
  const kind = path && path.kind ? path.kind : "root";
  if (kind === "root") {
    const db = await handle(conn, conn.database || "postgres");
    const result = await db.query("SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1");
    // A PG cluster ships with three or four internal databases the user has no
    // reason to see by default. `template0` is already excluded by
    // `datallowconn = false`; `postgres` / `template1` / `rdsadmin` would still
    // slip through and clutter the tree. Hide them when the connection opts in
    // (the default). `hideBuiltinDatabases: false` keeps them visible.
    const hideBuiltins = conn.hideBuiltinDatabases !== false;
    return result.rows
      .map((row) => String(row[0]))
      .filter((name) => !hideBuiltins || !pgBuiltinDatabase(name))
      .slice(0, MAX_CHILDREN)
      .map((name) => ({ kind: "database", name }));
  }
  if (kind === "database") {
    const db = await handle(conn, path.name);
    const result = await db.query(
      "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1",
    );
    // Schemas come back bare (just the namespace name), but the picker stores
    // them as `<database>.<schema>` so two databases can each have their own
    // `public`. Build both candidates and let either hit the filter — an old
    // connection that picked plain `public` keeps matching it, a new one that
    // picked `mydb.public` matches it too, and never the wrong one.
    const filter = schemaFilterOf(conn);
    return result.rows
      .map((row) => String(firstCell(row)))
      .filter((name) => {
        if (!filter) return true;
        const lower = name.toLowerCase();
        return filter.has(lower) || filter.has(path.name.toLowerCase() + "." + lower);
      })
      .slice(0, MAX_CHILDREN)
      .map((name) => ({ kind: "schema", name, database: path.name }));
  }
  if (kind === "schema") {
    const db = await handle(conn, path.database);
    const result = await db.query(
      "SELECT c.relname, CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' WHEN 'p' THEN 'table' ELSE 'other' END, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') ORDER BY 2, 1",
      [path.name],
    );
    return result.rows.slice(0, MAX_CHILDREN).map((row) => ({
      kind: "table",
      name: String(row[0]),
      tableType: String(row[1]),
      comment: catalogueComment(row[2], String(row[1])),
      database: path.database,
      schema: path.name,
    }));
  }
  return [];
}

export async function primaryKeys(db, path) {
  const exact = await db.query(
    "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY a.attnum",
    [path.schema, path.table],
    50,
  );
  if (exact.rows.length) return exact.rows.map((row) => String(row[0]));
  const folded = await db.query(
    "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE i.indisprimary AND lower(n.nspname) = lower($1) AND lower(c.relname) = lower($2) ORDER BY a.attnum",
    [path.schema, path.table],
    50,
  );
  return folded.rows.map((row) => String(row[0]));
}

export async function describe(db, path) {
  const table = String(path.table || "");
  const result = await db.query(
    "SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS column_default, col_description(a.attrelid, a.attnum) AS comment FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE a.attnum > 0 AND NOT a.attisdropped AND n.nspname = $1 AND c.relname = $2 ORDER BY a.attnum",
    [path.schema, table],
    MAX_ROWS,
  );
  const columns = result.rows.map((row) => ({
    name: String(row[0]),
    dataType: String(row[1] || ""),
    nullable: row[2] !== true,
    default: row[3] === null || row[3] === undefined ? "" : String(row[3]),
    comment: row[4] === null || row[4] === undefined ? "" : String(row[4]),
  }));
  let comment = "";
  try {
    const desc = await db.query(
      "SELECT obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
      [path.schema, table],
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
