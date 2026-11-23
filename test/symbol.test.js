import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { attachLineText, clipSnippet, locationsInside } from "../lib/symbol.js";

test("clipSnippet trims indent and clips long lines", () => {
  assert.equal(clipSnippet("    foo();"), "foo();");
  assert.equal(clipSnippet("\tbar();"), "bar();");
  const long = "x".repeat(250);
  const clipped = clipSnippet(long);
  assert.equal(clipped.length, 201);
  assert.equal(clipped.endsWith("…"), true);
});

test("attachLineText adds the source line to each location", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-sym-"));
  try {
    const dir = join(root, "src");
    await mkdir(dir);
    await writeFile(join(dir, "A.java"), "package demo;\n\n    public void onLogin(Event ev) {\n        ev.run();\n    }\n", "utf8");
    const locations = [
      { rel: "src/A.java", line: 2, character: 16 },
      { rel: "src/A.java", line: 3, character: 8 },
      { rel: "missing.java", line: 0, character: 0 }
    ];
    const out = await attachLineText(root, locations);
    assert.equal(out[0].text, "public void onLogin(Event ev) {");
    assert.equal(out[1].text, "ev.run();");
    assert.equal(out[2].text, undefined);
    assert.equal(locations[0].text, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locationsInside keeps paths inside root and attachLineText fills them", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-sym-"));
  try {
    await writeFile(join(root, "Main.java"), "class Main {\n  void use() { foo(); }\n}\n", "utf8");
    const uri = pathToFileURL(join(root, "Main.java")).href;
    const inside = locationsInside(root, {
      kind: "locations",
      locations: [{ uri, range: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } } }]
    });
    assert.equal(inside.length, 1);
    assert.equal(inside[0].rel, "Main.java");
    assert.equal(inside[0].line, 1);
    const out = await attachLineText(root, inside);
    assert.equal(out[0].text, "void use() { foo(); }");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attachLineText refuses a workspace symlink onto a secret directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-sym-"));
  const outside = await mkdtemp(join(tmpdir(), "dsh-idea-sym-out-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "url = https://user:token@example\n", "utf8");
    await symlink(join(root, ".git", "config"), join(root, "notes.md"));
    await writeFile(join(outside, "id_rsa"), "private\n", "utf8");
    await symlink(join(outside, "id_rsa"), join(root, "key.md"));
    const out = await attachLineText(root, [
      { rel: "notes.md", line: 0, character: 0 },
      { rel: "key.md", line: 0, character: 0 },
    ]);
    assert.equal(out[0].text, undefined);
    assert.equal(out[1].text, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
