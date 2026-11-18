import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { languageOf, paintDocument } from "../lib/highlight.js";

function region(path) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const start = source.indexOf("/* @highlight-start */");
  const end = source.indexOf("/* @highlight-end */");
  assert.ok(start >= 0 && end > start, path);
  return source.slice(start, end);
}

test("the browser copy of the painter matches highlight.js", () => {
  assert.equal(region("lib/client.js"), region("lib/highlight.js"));
});

test("SQL keywords are coloured regardless of case", () => {
  const html = paintDocument(
    "SELECT id FROM users WHERE name = 'a' AND deleted = 0;\n-- note\n",
    "sql",
    null
  ).html;
  for (const word of ["SELECT", "FROM", "WHERE", "AND"]) {
    assert.ok(html.includes('<span class="dce-k">' + word + "</span>"), word);
  }
  assert.ok(html.includes('<span class="dce-s">\'a\'</span>'));
  assert.ok(html.includes('<span class="dce-n">0</span>'));
  assert.ok(html.includes('<span class="dce-c">-- note</span>'));
  assert.equal(languageOf("db/schema.SQL").id, "sql");
});

test("SQL ranges use source offsets, including past a newline", () => {
  const text = "SELECT 1;\n-- note\n";
  const { ranges } = paintDocument(text, "sql", null);
  const slice = (cls) => ranges.filter((range) => range.cls === cls).map((range) => text.slice(range.start, range.end));
  assert.deepEqual(slice("dce-k"), ["SELECT"]);
  assert.deepEqual(slice("dce-n"), ["1"]);
  assert.deepEqual(slice("dce-c"), ["-- note"]);
  const again = paintDocument(text, "sql", paintDocument(text, "sql", null).cache);
  assert.deepEqual(again.ranges, ranges);
});

test("other languages stay case-sensitive", () => {
  const html = paintDocument("const Select = 1;\n", "js", null).html;
  assert.ok(html.includes('<span class="dce-k">const</span>'));
  assert.equal(html.includes('<span class="dce-k">Select</span>'), false);
});
