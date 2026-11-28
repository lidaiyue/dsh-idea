import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FsError, readExternalText, resolveExternalFile } from "../lib/files.js";
import { destructiveStatements, splitSql, stripSqlNoise } from "../lib/database/sql.js";
import { refIssue } from "../lib/git/git.js";
import { pullArgs } from "../lib/git/ops.js";

test("MySQL executable comments are not stripped from the safety check", () => {
  // /*!50000 ... */ is executed by MySQL, not ignored. The old stripSqlNoise
  // deleted it, so a DROP hidden there passed the destructive confirmation.
  const stmt = "/*!50000 DROP TABLE users */";
  assert.match(stripSqlNoise(stmt, "mysql"), /DROP TABLE/i);
  const parts = splitSql(stmt, "mysql");
  assert.deepEqual(destructiveStatements(parts, "mysql").length, 1);
  // Ordinary comments are still noise.
  assert.doesNotMatch(stripSqlNoise("/* DROP TABLE users */", "mysql"), /DROP/);
});

test("git pull ref rejects option-shaped segments at every level", () => {
  const payloads = [
    "origin/--upload-pack=/x",
    "--upload-pack=/x/main",
    "origin/-c",
    "origin/--exec=x"
  ];
  for (const ref of payloads) {
    const planned = pullArgs(ref, false);
    assert.equal(planned.ok, false, ref);
    assert.equal(planned.error, "ref-invalid", ref);
  }
  // refIssue alone does not catch a "-"-leading segment; pullArgs must.
  assert.equal(refIssue("origin/--upload-pack=/x"), "");
});

test("executable comments cannot hide a DROP behind another statement", () => {
  const payloads = [
    "/*!50000 SELECT 1; DROP TABLE users */",
    "SELECT 1 /*!50000; DROP TABLE users */",
    "INSERT INTO t VALUES (1) /*! ; DROP TABLE users */",
    "SELECT 1 /*M! ; DROP TABLE users */",
    "/*M!100100 DROP TABLE users */",
  ];
  for (const sql of payloads) {
    const parts = splitSql(sql, "mysql");
    assert.equal(destructiveStatements(parts, "mysql").length, 1, sql);
  }
  assert.equal(destructiveStatements(splitSql("SELECT 1 /* not a drop */", "mysql"), "mysql").length, 0);
});

test("the editor refuses the credential files DSH itself writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-secret-"));
  try {
    const home = join(root, "home");
    const dsh = join(home, ".dsh");
    await mkdir(dsh, { recursive: true });
    for (const name of [".credentials.yaml", ".credentials.yaml.bak-1792640472809", "database-connections.json", "db-passwords.json"]) {
      await writeFile(join(dsh, name), "secret", "utf8");
      // The whole `.dsh` directory is off limits, whichever name is inside it.
      await assert.rejects(
        () => resolveExternalFile(join(dsh, name)),
        (error) => error instanceof FsError && error.code === "secret-path",
        name
      );
    }
    // The same filenames copied outside `~/.dsh` are still refused by name.
    for (const name of [".credentials.yaml", "database-connections.json", "db-passwords.json"]) {
      const path = join(root, name);
      await writeFile(path, "secret", "utf8");
      await assert.rejects(
        () => resolveExternalFile(path),
        (error) => error instanceof FsError && error.code === "secret-path",
        name
      );
    }
    // An ordinary file next door is still readable.
    const ok = join(root, "notes.md");
    await writeFile(ok, "hello", "utf8");
    assert.equal((await readExternalText(ok)).text, "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
