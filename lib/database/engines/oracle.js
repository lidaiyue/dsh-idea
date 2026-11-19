import {
  MAX_ROWS,
  MAX_CHILDREN,
  ORACLE_FETCH_MIN,
  quoteIdent,
  firstCell,
  resultOf,
  writeMeta,
  materializeLobs,
  materializeCell,
  schemaFilterOf,
  schemaAllowed,
  catalogueComment,
  oracleVersionLabel,
  oracleMissingName,
} from "../sql.js";
import { CONNECT_MS, QUERY_MS, loadModule, liveKey, peekLive, rememberLive, touchLive, safeMessage } from "../live.js";

export const type = "oracle";

// node-oracledb takes `connectTimeout` in seconds while every other driver here
// takes milliseconds, so the shared constant cannot be passed through directly.
// Derived from CONNECT_MS rather than written as a second literal, so the two
// cannot drift apart.
const CONNECT_SECONDS = Math.max(1, Math.round(CONNECT_MS / 1000));

const oracleClients = new Map();

function oracleClientDir(conn) {
  const raw = conn && conn.instantClient;
  return typeof raw === "string" ? raw.trim() : "";
}

function oracleErrorMessage(error, libDir, serverVersion) {
  const code = (error && error.code) || "";
  const text = (error && error.message) ? String(error.message) : String(error);
  if (code === "ORA-00933" || /ORA-00933/.test(text)) {
    const old = (Number(serverVersion) || 0) > 0 && (Number(serverVersion) || 0) < ORACLE_FETCH_MIN;
    return "该 Oracle 服务端" + (old ? "（" + oracleVersionLabel(serverVersion) + "）" : "")
      + "不支持 `FETCH FIRST` / `OFFSET … FETCH` 这类 12.1 才有的分页语法，请改用 ROWNUM，例如："
      + "`SELECT * FROM (SELECT t.*, ROWNUM rn FROM (…) t WHERE ROWNUM <= :end) WHERE rn > :start`。原始错误：" + safeMessage(error);
  }
  if (code === "NJS-138" || /NJS-138/.test(text)) {
    return "该 Oracle 服务端协商出的 TNS 协议版本低于 315（12.2），node-oracledb 的 Thin 模式不支持，"
      + "需要用 Thick 模式（Instant Client）连接：在连接的「Instant Client 路径」里填入本机解压好的 Instant Client 目录后重试。";
  }
  if (code === "DPI-1047" || code === "DPI-1050" || /DPI-10(47|50|12)/.test(text)) {
    const where = libDir ? "（" + libDir + "）" : "";
    return "无法加载 Oracle Instant Client" + where + "：请确认路径指向解压后的 Instant Client 目录（内含 libclntsh.dylib），"
      + "且版本与本机架构一致（Apple Silicon 需 arm64 包）。原始错误：" + safeMessage(error);
  }
  if (code === "NJS-118" || /NJS-118/.test(text)) {
    return "无法切换到 Thick 模式：本进程已经建立过 Thin 模式连接，node-oracledb 不允许两种模式混用。"
      + "请重启 dsh web 后再用 Instant Client 路径连接。";
  }
  return safeMessage(error);
}

async function initOracleClient(conn) {
  const libDir = oracleClientDir(conn);
  const key = libDir || "<default>";
  const cached = oracleClients.get(key);
  if (cached) {
    if (cached.error) throw cached.error;
    return cached.module;
  }
  const oracle = await loadModule("oracledb", "Oracle");
  try {
    oracle.initOracleClient(libDir ? { libDir } : {});
    oracleClients.set(key, { module: oracle });
    return oracle;
  } catch (error) {
    const wrapped = new Error(oracleErrorMessage(error, libDir));
    oracleClients.set(key, { error: wrapped });
    throw wrapped;
  }
}

// `query` must run on the connection directly. The only caller is the ORA-00942
// hint, and that hint runs while `query` / `exec` / `transact` still hold the
// session queue. Passing `db.query` back in waits for the same queue and never
// starts: the original request stays open, and every later request on this
// connection piles up behind it.
async function oracleOwnersOf(conn, query, table) {
  const name = String(table || "").replace(/^["`\[]|["`\]]$/g, "").trim();
  if (name === "") return [];
  const filter = schemaFilterOf(conn);
  try {
    const result = await query(
      "SELECT owner FROM all_tables WHERE upper(table_name) = upper(:1)"
      + " UNION SELECT owner FROM all_views WHERE upper(view_name) = upper(:1)",
      [name],
      50,
    );
    return result.rows
      .map((row) => String(firstCell(row)))
      .filter((owner) => !filter || filter.has(owner.toLowerCase()))
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function oracleMissingHint(conn, query, activeSchema, sql) {
  const missing = oracleMissingName(sql);
  if (!missing.table) return "";
  const asked = missing.schema;
  const where = activeSchema ? "当前会话的 Schema 是 `" + activeSchema + "`" : "当前会话没有切换到任何 Schema";
  const label = asked ? "`" + asked + "." + missing.table + "`" : "`" + missing.table + "`";
  let owners = [];
  try {
    owners = await oracleOwnersOf(conn, query, missing.table);
  } catch {}
  const listed = owners.filter((owner) => owner.toLowerCase() !== String(asked || activeSchema || "").toLowerCase());
  if (listed.length) {
    return "找不到 " + label + "，" + where + "；但 `" + missing.table + "` 存在于 Schema："
      + listed.map((owner) => "`" + owner + "`").join("、")
      + "。在控制台左上角的 Schema 下拉里选它，或按 `" + listed[0] + "." + missing.table + "` 全限定写。";
  }
  if (asked) return "";
  return "找不到 " + label + "，" + where + "。若该表属于其他用户，请在控制台左上角切换 Schema，"
    + "或按 `SCHEMA." + missing.table + "` 全限定写。原始错误：ORA-00942: table or view does not exist";
}

async function oracleSchemaOf(connection, wanted) {
  const name = String(wanted || "").trim();
  if (name === "") return "";
  try {
    const result = await connection.execute(
      "SELECT username FROM all_users WHERE upper(username) = upper(:1)",
      [name],
      { maxRows: 1 },
    );
    const row = result.rows && result.rows[0];
    return row ? String(row[0]) : "";
  } catch {
    return "";
  }
}

async function oracleCurrentSchema(connection) {
  try {
    const result = await connection.execute("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual", {}, { maxRows: 1 });
    const row = result.rows && result.rows[0];
    const name = row ? String(row[0] || "").trim() : "";
    if (name) return name;
  } catch {}
  try {
    const result = await connection.execute("SELECT USER FROM dual", {}, { maxRows: 1 });
    const row = result.rows && result.rows[0];
    return row ? String(row[0] || "").trim() : "";
  } catch {
    return "";
  }
}

export async function handle(conn, schema) {
  const service = String(conn.database || "").trim();
  const wanted = String(schema || "").trim();
  const dir = oracleClientDir(conn);
  const keyOf = (name) => liveKey(conn, service + "|" + dir + "|" + name.toLowerCase());
  const existing = peekLive(keyOf(wanted));
  if (existing) {
    touchLive(keyOf(wanted));
    return existing;
  }
  if (service === "") {
    throw new Error("请填写「数据库 / 服务名」（Oracle 服务名，例如 ORCL）。留空时监听器收不到 SERVICE_NAME，会报 ORA-12504。");
  }
  const useThick = dir !== "" || process.env.ORACLE_HOME;
  const oracledb = useThick ? await initOracleClient(conn) : await loadModule("oracledb", "Oracle");
  oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
  // NUMBER beyond 2^53 loses digits as a JS number; strings keep the exact
  // value, matching what pg already does for int8/numeric.
  oracledb.fetchAsString = [oracledb.NUMBER];
  const ezConnect = (conn.host || "127.0.0.1") + ":" + (Number(conn.port) || 1521) + "/" + service;
  // Some listeners register the instance only as a SID (no matching service —
  // typical for old instances without SERVICE_NAMES). EZConnect can only carry
  // a service name, so a ORA-12514 there falls back to an explicit SID
  // descriptor built from the same host/port/service value.
  const sidDescriptor = "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=" + (conn.host || "127.0.0.1")
    + ")(PORT=" + (Number(conn.port) || 1521) + "))(CONNECT_DATA=(SID=" + service + ")))";
  const attemptConnect = (connectString) => oracledb.getConnection({
    user: conn.user || undefined,
    password: conn.password || undefined,
    connectString,
    // In SECONDS, not milliseconds: node-oracledb multiplies this by 1000
    // internally (`sessionAtts.js`: `params.connectTimeout * 1000`). Passing
    // the shared millisecond constant here meant 15000 seconds — about four
    // hours, i.e. no bound at all — and the 20 s that actually fired was the
    // driver's own `DEFAULT_TRANSPORT_CONNECT_TIMEOUT`, not this setting.
    connectTimeout: CONNECT_SECONDS,
  });
  let connection;
  try {
    connection = await attemptConnect(ezConnect);
  } catch (error) {
    const text = (error && error.message) ? String(error.message) : "";
    if (!/ORA-12514/.test(text)) throw new Error(oracleErrorMessage(error, oracleClientDir(conn)));
    try {
      connection = await attemptConnect(sidDescriptor);
    } catch (fallback) {
      const fallbackText = (fallback && fallback.message) ? String(fallback.message) : "";
      if (fallbackText === text || /ORA-12514/.test(fallbackText)) {
        throw new Error("监听器既没有注册服务名也没有注册 SID「" + service + "」。"
          + "在服务器上执行 `lsnrctl status` 确认实际注册的名称后填入「数据库 / 服务名」。原始错误：" + safeMessage(fallback));
      }
      throw new Error(oracleErrorMessage(fallback, oracleClientDir(conn)));
    }
  }
  // A round-trip cap, matching what MySQL and PostgreSQL already apply. On a
  // dedicated connection one slow statement otherwise blocks every later
  // request on this handle, because they all share it.
  try { connection.callTimeout = QUERY_MS; } catch {}
  const serverVersion = Number(connection.oracleServerVersion) || 0;
  const requested = await oracleSchemaOf(connection, wanted);
  if (requested) {
    try {
      await connection.execute("ALTER SESSION SET CURRENT_SCHEMA = " + quoteIdent("oracle", requested));
    } catch {}
  }
  const activeSchema = requested || await oracleCurrentSchema(connection);
  const canonical = keyOf(activeSchema);
  const reused = peekLive(canonical);
  if (reused) {
    try { await connection.close(); } catch {}
    return reused;
  }
  // Direct execute. Callers of `explain` already hold the session queue, so this
  // must not go back through `db.query` — that waits for the queue the caller is
  // still holding. `autoCommit` is the caller's: true for a one-shot statement,
  // false inside `transact`, where a committed hint lookup would publish the
  // half-finished edit before its rollback.
  const queryDirect = async (sql, params, limit, autoCommit) => {
    const cap = typeof limit === "number" ? limit : MAX_ROWS;
    const binds = Array.isArray(params) ? params : {};
    const result = await connection.execute(sql, binds, { maxRows: cap + 1, autoCommit: autoCommit === true });
    const columns = (result.metaData || []).map((col) => col.name);
    const rows = result.rows || [];
    // Before resultOf: a CLOB is still a stream here, and stringifying it shows
    // the stream, not the JSON (or whatever text) stored in the column.
    await materializeLobs(rows);
    const truncated = rows.length > cap;
    return writeMeta(
      resultOf(columns, truncated ? rows.slice(0, cap) : rows, truncated),
      typeof result.rowsAffected === "number" ? result.rowsAffected : undefined,
    );
  };
  const explain = async (error, sql, autoCommit) => {
    const code = (error && error.code) || "";
    const text = (error && error.message) ? String(error.message) : String(error);
    if (code === "ORA-00942" || /ORA-00942/.test(text)) {
      const hinted = await oracleMissingHint(
        conn,
        (q, params, limit) => queryDirect(q, params, limit, autoCommit),
        activeSchema,
        sql,
      );
      if (hinted) return new Error(hinted);
    }
    return new Error(oracleErrorMessage(error, oracleClientDir(conn), serverVersion));
  };
  // One Oracle handle is ONE session, shared by every request for that
  // connection. node-oracledb does not queue concurrent work on a connection, so
  // without this a `/children` fired while a table edit is open would run inside
  // that edit's transaction — and the edit's `rollback()` would discard it (or
  // its `commit()` would publish the half-finished edit). PostgreSQL and MySQL
  // avoid this by taking a pooled client per transaction; Oracle has a single
  // dedicated connection, so the serialization has to happen here.
  //
  // A promise chain, not a lock: work is queued in arrival order and each item
  // runs only after the previous one settles, including on failure.
  //
  // A queued item must not call back into `db.query` / `db.exec` / `db.transact`.
  // Those wait for this same chain, so the callback never starts and neither does
  // anything queued behind it. The ORA-00942 hint uses `queryDirect` instead.
  let queue = Promise.resolve();
  const serialize = (work) => {
    const run = queue.then(work, work);
    // Keep the chain alive past a rejected item; the caller still sees its own
    // rejection through `run`.
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const db = {
    type: "oracle",
    serverVersion,
    schema: activeSchema,
    async query(sql, params, limit) {
      return serialize(async () => {
        try {
          return await queryDirect(sql, params, limit, true);
        } catch (error) {
          throw await explain(error, sql, true);
        }
      });
    },
    // One cell at the editor's ceiling, read and closed on this handle's single
    // session. `query` would materialize a LOB at the grid cap and close it;
    // returning an unread Lob to the caller would let another queued request
    // run between execute and getData, which this shared connection cannot do.
    async queryCell(sql, params, limit, column, maxChars) {
      return serialize(async () => {
        const cap = typeof limit === "number" ? limit : 2;
        const binds = Array.isArray(params) ? params : {};
        let result;
        try {
          result = await connection.execute(sql, binds, { maxRows: cap + 1, autoCommit: true });
        } catch (error) {
          throw await explain(error, sql, true);
        }
        const rows = result.rows || [];
        if (rows.length !== 1) {
          // No row, or a key that matched more than one: drain every locator
          // before this slot is released.
          await materializeLobs(rows);
          return { found: false, value: null, cut: false };
        }
        const row = rows[0];
        const shaped = await materializeCell(Array.isArray(row) ? row[0] : row[column], maxChars);
        return { found: true, value: shaped.value, cut: shaped.cut === true };
      });
    },
    async exec(sql, params) {
      const binds = Array.isArray(params) ? params : {};
      return serialize(async () => {
        let result;
        try {
          result = await connection.execute(sql, binds, { autoCommit: true });
        } catch (error) {
          throw await explain(error, sql, true);
        }
        return { rowCount: result.rowsAffected || 0 };
      });
    },
    async transact(fn) {
      // The queue is held for the WHOLE transaction, not per statement: the
      // point is that no other request's statement can run between this
      // transaction's first statement and its commit/rollback.
      return serialize(async () => {
        const q = async (sql, params) => {
          const binds = Array.isArray(params) ? params : {};
          try {
            return await connection.execute(sql, binds, { autoCommit: false });
          } catch (error) {
            throw await explain(error, sql, false);
          }
        };
        try {
          const value = await fn(q);
          await connection.commit();
          return value;
        } catch (error) {
          try { await connection.rollback(); } catch {}
          throw error;
        }
      });
    },
    async close() {
      // Drain first: closing while a queued statement is still pending would
      // fail that request with an obscure "connection closed" instead of its
      // own result.
      await queue.then(() => undefined, () => undefined);
      await connection.close();
    },
  };
  return rememberLive(canonical, db);
}

export async function schemas(conn) {
  const db = await handle(conn);
  const result = await db.query("SELECT username FROM all_users ORDER BY 1", undefined, MAX_CHILDREN);
  return { items: result.rows.map((row) => ({ name: String(firstCell(row)), database: conn.database || "" })) };
}

export async function children(conn, path) {
  const kind = path && path.kind ? path.kind : "root";
  if (kind === "root") {
    const db = await handle(conn);
    const result = await db.query("SELECT username FROM all_users ORDER BY 1");
    return result.rows
      .map((row) => String(firstCell(row)))
      .filter((name) => schemaAllowed(conn, name))
      .slice(0, MAX_CHILDREN)
      .map((name) => ({ kind: "schema", name, database: conn.database || "" }));
  }
  if (kind === "schema") {
    const db = await handle(conn);
    const owner = String(path.name).toUpperCase();
    const result = await db.query(
      "SELECT t.table_name, c.comments FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name AND c.table_type = 'TABLE' WHERE t.owner = :1 ORDER BY 1",
      [owner],
    );
    const tables = result.rows.slice(0, MAX_CHILDREN).map((row) => ({
      kind: "table",
      name: String(row[0]),
      tableType: "table",
      comment: catalogueComment(row[1], "table"),
      database: conn.database || "",
      schema: path.name,
    }));
    try {
      const views = await db.query(
        "SELECT v.view_name, c.comments FROM all_views v LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name AND c.table_type = 'VIEW' WHERE v.owner = :1 ORDER BY 1",
        [owner],
      );
      for (const row of views.rows) {
        if (tables.length >= MAX_CHILDREN) break;
        tables.push({
          kind: "table",
          name: String(row[0]),
          tableType: "view",
          comment: catalogueComment(row[1], "view"),
          database: conn.database || "",
          schema: path.name,
        });
      }
    } catch {}
    return tables;
  }
  return [];
}

export async function primaryKeys(db, path) {
  const result = await db.query(
    "SELECT cols.column_name FROM all_constraints cons JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner WHERE cons.constraint_type = 'P' AND upper(cons.owner) = upper(:1) AND upper(cons.table_name) = upper(:2) ORDER BY cols.position",
    [String(path.schema || ""), String(path.table || "")],
    50,
  );
  return result.rows.map((row) => String(row[0]));
}

export async function describe(db, path) {
  const table = String(path.table || "");
  const result = await db.query(
    "SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale, c.nullable, c.data_default, m.comments FROM all_tab_columns c LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name WHERE upper(c.owner) = upper(:1) AND upper(c.table_name) = upper(:2) ORDER BY c.column_id",
    [String(path.schema || ""), table],
    MAX_ROWS,
  );
  const columns = result.rows.map((row) => {
    const typeName = String(row[1] || "");
    const length = Number(row[2]) || 0;
    const precision = row[3] === null || row[3] === undefined ? null : Number(row[3]);
    const scale = row[4] === null || row[4] === undefined ? null : Number(row[4]);
    let dataType = typeName;
    if (/^(CHAR|VARCHAR2|NCHAR|NVARCHAR2|RAW)$/i.test(typeName) && length) dataType += "(" + length + ")";
    else if (precision !== null) dataType += "(" + precision + (scale ? "," + scale : "") + ")";
    return {
      name: String(row[0]),
      dataType,
      nullable: String(row[5] || "").toUpperCase() === "Y",
      default: row[6] === null || row[6] === undefined ? "" : String(row[6]).trim(),
      comment: row[7] === null || row[7] === undefined ? "" : String(row[7]),
    };
  });
  let comment = "";
  try {
    const desc = await db.query(
      "SELECT comments FROM all_tab_comments WHERE upper(owner) = upper(:1) AND upper(table_name) = upper(:2)",
      [String(path.schema || ""), table],
      1,
    );
    const value = desc.rows.length ? firstCell(desc.rows[0]) : null;
    comment = value === null || value === undefined ? "" : String(value);
  } catch {}
  return { columns, comment };
}

export async function test(conn) {
  const db = await handle(conn, conn.database);
  await db.query("SELECT 1 FROM dual");
  return { ok: true, message: "ok" };
}
