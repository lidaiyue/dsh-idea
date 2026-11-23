import assert from "node:assert/strict";
import test from "node:test";
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
