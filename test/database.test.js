import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import {
  CRED_SCOPE,
  PREFIX,
  PREFIX_NEW,
  PREFIXES,
  consolesPath,
  normalizeConsoleView,
  prefixOf,
  publicConn,
  routeOf,
  storePath,
  stripPasswords,
} from "../lib/database/index.js";
import {
  alreadyPaged,
  boundedSelect,
  destructiveStatements,
  pgBuiltinDatabase,
  qualifyTable,
  quoteIdent,
  schemaAllowed,
  schemaFilterOf,
  schemaNamesOf,
  splitSql,
  statementCommand,
  looksLikeSelect,
} from "../lib/database/sql.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("credential scope and store paths stay on the dsh-database names", () => {
  assert.equal(CRED_SCOPE, "dsh-database");
  assert.equal(credentialKey(CRED_SCOPE, "conn-abc"), "dsh-database/conn-abc");
  assert.equal(storePath(), join(homedir(), ".dsh", "database-connections.json"));
  assert.equal(consolesPath(), join(homedir(), ".dsh", "database-consoles.json"));
});

test("legacy and idea prefixes both map to the same route", () => {
  assert.deepEqual(PREFIXES, ["/plugins/dsh-idea/database", "/plugins/dsh-database"]);
  assert.equal(PREFIX, "/plugins/dsh-database");
  assert.equal(PREFIX_NEW, "/plugins/dsh-idea/database");
  assert.equal(prefixOf("/plugins/dsh-database/list"), PREFIX);
  assert.equal(prefixOf("/plugins/dsh-idea/database/list"), PREFIX_NEW);
  assert.equal(prefixOf("/plugins/dsh-idea/git/log"), null);
  const legacy = routeOf({ url: "/plugins/dsh-database/list" });
  const next = routeOf({ url: "/plugins/dsh-idea/database/list" });
  assert.equal(legacy, "/list");
  assert.equal(next, "/list");
  assert.equal(routeOf({ url: "/plugins/dsh-database/vendor/codemirror.js" }), "/vendor/codemirror.js");
  assert.equal(routeOf({ url: "/plugins/dsh-idea/database/vendor/codemirror.js" }), "/vendor/codemirror.js");
  assert.equal(routeOf({ url: "/plugins/dsh-database/" }), "/");
});

test("normalizeConsoleView caps, dedupes, and drops bad rows", () => {
  const view = normalizeConsoleView({
    page: "console-1",
    consoles: [
      { id: "console-1", title: "Main", connId: "c1", database: "app", sql: "select 1" },
      { id: "console-1", title: "dup", connId: "c2", sql: "select 2" },
      { id: 3 },
      null,
      { id: "console-2", sql: "x".repeat(200_000) },
    ],
    closed: [
      { id: "old", title: "Old", connId: "c1", sql: "select 3", at: 42 },
      { title: "no-id" },
    ],
  });
  assert.equal(view.page, "console-1");
  assert.equal(view.consoles.length, 2);
  assert.equal(view.consoles[0].title, "Main");
  assert.equal(view.consoles[0].sql, "select 1");
  assert.equal(view.consoles[1].id, "console-2");
  assert.equal(view.consoles[1].sql.length, 100 * 1024);
  assert.equal(view.closed.length, 1);
  assert.equal(view.closed[0].at, 42);
});

test("publicConn never returns the password, and stripPasswords drops it when a store is present", () => {
  const row = {
    id: "c1",
    name: "local",
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "me",
    password: "s3cret",
    database: "app",
    ssl: true,
    schemas: ["public"],
  };
  const published = publicConn(row, null);
  assert.equal(published.hasPassword, true);
  assert.equal(published.plaintextPassword, true);
  assert.equal("password" in published, false);
  const credentials = {
    modifyRecord() {},
    readRecord() {},
  };
  const stripped = stripPasswords([row], credentials);
  assert.equal(stripped[0].password, undefined);
  assert.equal(stripped[0].name, "local");
  const kept = stripPasswords([row], null);
  assert.equal(kept[0].password, "s3cret");
});

test("SQL helpers quote, page, and classify statements", () => {
  assert.equal(quoteIdent("postgres", 'weird"name'), '"weird""name"');
  assert.equal(qualifyTable("mysql", "app", "users"), "`app`.`users`");
  assert.equal(pgBuiltinDatabase("postgres"), true);
  assert.equal(pgBuiltinDatabase("app"), false);
  assert.deepEqual(schemaNamesOf({ schemas: [" Public ", "", "app"] }), ["Public", "app"]);
  const conn = { schemas: ["public"] };
  assert.deepEqual(schemaFilterOf(conn), new Set(["public"]));
  assert.equal(schemaAllowed(conn, "public"), true);
  assert.equal(schemaAllowed(conn, "other"), false);
  assert.equal(looksLikeSelect("  WITH x AS (SELECT 1) SELECT * FROM x"), true);
  assert.equal(looksLikeSelect("update t set a = 1"), false);
  assert.equal(statementCommand("  Update t set a = 1"), "UPDATE");
  assert.equal(alreadyPaged("select * from t limit 10", "postgres"), true);
  assert.equal(alreadyPaged("select * from t", "postgres"), false);
  assert.match(boundedSelect("postgres", "select * from t", 50), /limit\s+51/i);
  const statements = splitSql("select 1; drop table t; update t set a = 1;", "postgres");
  assert.deepEqual(destructiveStatements(statements), ["drop table t"]);
});

test("idea wires the database module and keeps the legacy plugin surface", () => {
  const index = read("lib/index.js");
  assert.match(index, /apply as applyDatabase/);
  assert.match(index, /applyDatabase\(ctx\)/);
  const client = read("lib/client.js");
  assert.match(client, /bootChunk\("client\.database\.js"\)/);
  assert.match(client, /const DATABASE_KEYS_KEY = "dsh\.database\.keys"/);
  assert.match(client, /KEY_GROUPS = \["files", "editor", "git", "run", "database"\]/);
  const chunk = read("lib/client.database.js");
  assert.match(chunk, /id: "dsh-idea"/);
  assert.match(chunk, /chunk: "client\.database\.js"/);
  assert.match(chunk, /const EXPLORER_ID = "dsh-database"/);
  assert.match(chunk, /const EXPLORER_KIND = "database"/);
  assert.match(chunk, /const API = "\/plugins\/dsh-database"/);
  assert.match(chunk, /const TREE_W_KEY = "dsh\.database\.treew"/);
  assert.match(chunk, /"database\.toggle"/);
  assert.match(chunk, /code: "Digit2"/);
  assert.match(chunk, /window\.__ddbCodeMirror/);
  assert.equal(chunk.includes("createDbKeys"), false);
  const vendor = read("lib/database/vendor/codemirror.js");
  assert.match(vendor, /__ddbCodeMirror/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies.ioredis, "^5.8.2");
  assert.equal(pkg.dependencies.mysql2, "^3.15.3");
  assert.equal(pkg.dependencies.pg, "^8.16.3");
  assert.equal(pkg.optionalDependencies.oracledb, "^6.9.0");
});

test("SQL consoles are idea editor tabs, not a visible host database page", () => {
  const client = read("lib/client.js");
  const chunk = read("lib/client.database.js");
  assert.match(chunk, /const EXPLORER_ID = "dsh-database"/);
  assert.match(chunk, /const EXPLORER_KIND = "database"/);
  assert.match(chunk, /dsh-database-open/);
  assert.match(chunk, /dsh-database-toggle/);
  assert.match(chunk, /window\.__dshDatabaseHotkeys/);
  assert.match(chunk, /isDatabaseOpenId/);
  assert.match(chunk, /__dshIdeaDbGuard/);
  assert.match(chunk, /openDatabasePanel/);
  assert.equal(chunk.includes("openTab(EXPLORER_KIND)"), false);
  assert.equal(chunk.includes("function DatabaseRedirect"), false);
  assert.equal(chunk.includes("function ExplorerTitle"), false);
  assert.equal(/tabs\.register\(explorerDefinition\)/.test(chunk), false);
  assert.equal(/guide:\s*\[/.test(chunk), false);
  assert.match(chunk, /showLeftTool\("database"\)/);
  assert.match(chunk, /activateDatabaseTab/);
  assert.match(chunk, /function focusConsole/);
  assert.match(chunk, /className: "ddb-worktab"/);
  assert.match(chunk, /className: "ddb-sql-tools"/);
  assert.match(chunk, /h\(RunIcon\)/);
  assert.match(chunk, /h\(StopIcon\)/);
  assert.match(chunk, /t\("rowLimitN"/);
  assert.match(chunk, /className: "ddb-sql-spacer"/);
  assert.equal(chunk.includes('h(BottomPanel, { consoleId: id })'), false);
  assert.equal(chunk.includes('className: "ddb-sql-results"'), false);
  assert.equal(chunk.includes('className: "ddb-sql-vsplit"'), false);
  assert.match(chunk, /className: "ddb-dock"/);
  assert.match(chunk, /h\(BottomPanel\)/);
  assert.match(chunk, /hosts\.dock \? portalTo\(dockUi, hosts\.dock\)/);
  assert.match(chunk, /window\.__dshDatabaseDock/);
  assert.match(chunk, /stowGitAndRun/);
  assert.match(chunk, /dsh-git-dock/);
  assert.match(chunk, /dsh-run-dock/);
  assert.match(chunk, /openDbDock\(\)/);
  assert.equal(chunk.includes("ddb-resultpane"), false);
  assert.equal(chunk.includes("ddb-treefold"), false);
  assert.equal(chunk.includes('className: "ddb-root"'), false);
  const toolsAt = chunk.indexOf('className: "ddb-sql-tools"');
  const findAt = chunk.indexOf('className: "ddb-sql-find"', toolsAt);
  const bodyAt = chunk.indexOf('className: "ddb-sql-body"', toolsAt);
  const toolsEnd = (findAt > toolsAt ? findAt : bodyAt);
  assert.ok(toolsAt >= 0 && toolsEnd > toolsAt);
  const tools = chunk.slice(toolsAt, toolsEnd);
  assert.equal(tools.includes("searchSqlPlaceholder"), false);
  assert.equal(tools.includes("ddb-btn-primary"), false);
  assert.match(tools, /h\(RunIcon\)/);
  assert.match(tools, /h\(StopIcon\)/);
  assert.match(tools, /className: "ddb-sql-spacer"/);

  assert.match(chunk, /portalTo\(/);
  assert.match(client, /dce-dbtree/);
  assert.match(client, /dce-dbwork/);
  assert.match(client, /dce-db-tabs/);
  assert.match(client, /dce-toolswitch/);
  assert.match(client, /dsh\.idea\.lefttool/);
  assert.match(client, /dsh-db:/);
  assert.match(client, /dbActive \? null : h\(React\.Fragment/);
  assert.match(client, /data-dsh-db-dock/);
  assert.match(client, /t\("dbDock"\)/);
  assert.match(client, /className: "dce-dbpane"/);
  assert.match(client, /databaseDockHost/);
  assert.match(client, /__dshDatabaseDock/);
  assert.match(client, /showLeftTool/);
  assert.match(client, /activateDatabaseTab/);
  assert.match(client, /__dshDatabaseHotkeys/);
  assert.match(client, /closeTab\(\) === true/);
});

test("query results share the editor bottom dock with Git and Run", () => {
  const client = read("lib/client.js");
  const chunk = read("lib/client.database.js");
  // Same splitter and height key as Git / Run; only one of the three is shown.
  assert.match(client, /html\[data-dsh-db-dock=\\"1\\"\] \.dce-gitsplit/);
  assert.match(client, /html\[data-dsh-git-dock=\\"1\\"\] \.dce-gitsplit/);
  assert.match(client, /html\[data-dsh-run-dock=\\"1\\"\] \.dce-gitsplit/);
  assert.match(client, /box\.querySelector\("\.dce-dbpane"\)/);
  assert.match(client, /dataset\.dshDbDock === "1"/);
  assert.match(client, /dsh-bottom-dock-height/);
  assert.equal(client.includes("dsh.code-editor.gith"), true);
  // Console editor no longer splits out an in-page results pane.
  const toolsAt = chunk.indexOf('className: "ddb-sql-tools"');
  const pageEnd = chunk.indexOf("function StructurePopover");
  const sqlPage = chunk.slice(toolsAt, pageEnd);
  assert.ok(toolsAt >= 0 && pageEnd > toolsAt);
  assert.equal(sqlPage.includes('className: "ddb-sql-results"'), false);
  assert.equal(sqlPage.includes("onResultDrag"), false);
  assert.equal(sqlPage.includes("BottomPanel"), false);
  assert.match(chunk, /git\.close/);
  assert.match(chunk, /run\.close/);
  assert.match(chunk, /event\.detail\.open === true\) closeDbDock/);
  assert.match(chunk, /function focusTable/);
  assert.match(chunk.slice(chunk.indexOf("function focusTable"), chunk.indexOf("function publishWorkTabs")), /openDbDock\(\)/);
  assert.equal(chunk.slice(chunk.indexOf("function focusTable"), chunk.indexOf("function publishWorkTabs")).includes("activateDatabaseTab"), false);
});
