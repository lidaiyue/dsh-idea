import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { annotateSql, bindSqlText, openSqlFile } from "../lib/database/sqlfile.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-sqlfile-"));
  await mkdir(join(root, "db"), { recursive: true });
  return root;
}

test("a file with a JetBrains header names its data source", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "db", "a.sql"), "-- a comment\n-- datasource: My PG\nselect 1;\n");
    assert.equal((await openSqlFile(root, "db/a.sql")).datasource, "My PG");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a header comment alone binds nothing", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "db", "b.sql"), "-- a comment\n\n-- datasource: x\nselect 1;\n");
    // The label sits below the first statement's blank line but still inside
    // the comment block, so it is read; a label after real SQL is not.
    await writeFile(join(root, "db", "c.sql"), "select 1;\n-- datasource: later\n");
    assert.equal((await openSqlFile(root, "db/b.sql")).datasource, "x");
    assert.equal((await openSqlFile(root, "db/c.sql")).datasource, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DataGrip's `--/ ##name` header names the database of a connection", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "db", "e.sql"), "--/ ##production\nselect 1;\n");
    assert.equal((await openSqlFile(root, "db/e.sql")).datasource, "production");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the console annotation wins over the header and is rewritten in place", async () => {
  const root = await workspace();
  try {
    const text = "-- datasource: My PG\nselect 1;\n";
    const annotated = annotateSql(text, "conn-1");
    assert.equal(annotated, "-- @dsh-connection conn-1\n-- datasource: My PG\nselect 1;\n");
    await writeFile(join(root, "db", "d.sql"), annotated);
    assert.equal((await openSqlFile(root, "db/d.sql")).connId, "conn-1");
    // A second run against another connection replaces the line, never stacks it.
    const again = annotateSql(annotated, "conn-2");
    assert.equal(again.split("\n").filter((line) => line.startsWith("-- @dsh-connection")).length, 1);
    assert.match(again, /^-- @dsh-connection conn-2\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opening a script refuses traversal, secrets, and missing files", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "db", "ok.sql"), "select 1;\n");
    const file = await openSqlFile(root, "db/ok.sql");
    assert.equal(file.text, "select 1;\n");
    await assert.rejects(() => openSqlFile(root, "../outside.sql"), /bad-path/);
    await assert.rejects(() => openSqlFile(root, "db/missing.sql"), /not-found/);
    await assert.rejects(() => openSqlFile(root, "/etc/passwd"), /bad-path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding text: annotation first, header second, neither twice", async () => {
  const out = bindSqlText("select 1;\n", "conn-1", "My PG");
  assert.equal(out, "-- @dsh-connection conn-1\n-- datasource: My PG\nselect 1;\n");
  // Re-binding another connection on already-bound text replaces both lines.
  const again = bindSqlText(out, "conn-2", "Other");
  assert.equal(again, "-- @dsh-connection conn-2\n-- datasource: My PG\nselect 1;\n");
  // No header asked for: the existing one is left alone.
  assert.equal(bindSqlText("-- datasource: x\nselect 1;\n", "c", ""), "-- @dsh-connection c\n-- datasource: x\nselect 1;\n");
});

test("a callback reply is a script whose name is the one the page sent", async () => {
  const { jsCallback } = await import("../lib/database/index.js");
  const sent = (name) => {
    const out = {};
    const res = { writeHead(status, headers) { out.status = status; out.headers = headers; }, end(body) { out.body = String(body); } };
    jsCallback(res, name, { ok: true, text: "a\u2028b" });
    return out;
  };
  const ok = sent("window.__dshSqlFile1");
  assert.equal(ok.status, 200);
  assert.match(ok.body, /^window\.__dshSqlFile1\(\{"ok":true/);
  // U+2028 is a line terminator in JavaScript source: it must stay escaped.
  assert.equal(ok.body.includes("\u2028"), false);
  assert.equal(sent("alert(1)//").status, 400);
  assert.equal(sent("").status, 400);
});
