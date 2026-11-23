import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { FsError, readExternalText, resolveExternalFile, resolveQueryFile } from "../lib/files.js";
import { clientCapabilities, normalizeLocations } from "../lib/lsp/client.js";
import { LspService } from "../lib/lsp/index.js";
import { findProjectRoot } from "../lib/lsp/servers.js";
import { attachLineText, locationsInside } from "../lib/symbol.js";

const clientSrc = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

function gotoSymbolSource(src) {
  const start = src.indexOf("const gotoSymbol = (operation) => {");
  assert.ok(start >= 0, "gotoSymbol not found");
  const end = src.indexOf("const seek = (target) => {", start);
  assert.ok(end > start, "seek after gotoSymbol not found");
  return src.slice(start, end);
}

test("LocationLink prefers targetSelectionRange over targetRange", () => {
  const result = normalizeLocations([
    {
      targetUri: "file:///tmp/demo.ts",
      targetRange: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
      targetSelectionRange: { start: { line: 12, character: 6 }, end: { line: 12, character: 9 } }
    }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].uri, "file:///tmp/demo.ts");
  assert.equal(result[0].range.start.line, 12);
  assert.equal(result[0].range.start.character, 6);
});

test("normalizeLocations still accepts a plain Location", () => {
  const result = normalizeLocations({
    uri: "file:///tmp/demo.ts",
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].range.start.line, 1);
  assert.equal(result[0].range.start.character, 2);
});

test("initialize capabilities declare implementation and utf-16", () => {
  const caps = clientCapabilities();
  assert.deepEqual(caps.textDocument.implementation, { dynamicRegistration: false });
  assert.deepEqual(caps.textDocument.definition, { dynamicRegistration: false });
  assert.deepEqual(caps.textDocument.references, { dynamicRegistration: false });
  assert.deepEqual(caps.general.positionEncodings, ["utf-16"]);
});

test("goToDefinition does not replace a single result with implementations", async () => {
  const service = new LspService();
  const calls = [];
  const def = [{ uri: "file:///a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }];
  const impls = [{ uri: "file:///b.ts", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } }];
  const client = {
    stopped: false,
    async definition() { calls.push("definition"); return def; },
    async implementations() { calls.push("implementation"); return impls; },
    async references() { calls.push("references"); return []; }
  };
  service.clientFor = async () => client;
  service.ensureOpen = async () => "file:///a.ts";
  const result = await service.query({
    operation: "goToDefinition",
    filePath: "/a.ts",
    workspaceRoot: "/",
    position: { line: 0, character: 0 }
  });
  assert.deepEqual(calls, ["definition"]);
  assert.equal(result.locations, def);
  const impl = await service.query({
    operation: "goToImplementation",
    filePath: "/a.ts",
    workspaceRoot: "/",
    position: { line: 0, character: 0 }
  });
  assert.deepEqual(calls, ["definition", "implementation"]);
  assert.equal(impl.locations, impls);
});

test("locationsInside keeps out-of-workspace file locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-idea-goto-ws-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "dsh-idea-goto-ext-"));
  try {
    await writeFile(join(root, "app.ts"), "import { foo } from 'lib';\nfoo();\n", "utf8");
    const outsideFile = join(outsideDir, "lib.d.ts");
    await writeFile(outsideFile, "export function foo(): void {}\n", "utf8");
    const insideUri = pathToFileURL(join(root, "app.ts")).href;
    const outsideUri = pathToFileURL(outsideFile).href;
    const locations = locationsInside(root, {
      kind: "locations",
      locations: [
        { uri: insideUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
        { uri: outsideUri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } },
        { uri: "jdt://contents/jdk/Object.class", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
      ]
    });
    assert.equal(locations.length, 2);
    assert.equal(locations[0].rel, "app.ts");
    assert.equal(locations[0].outside, undefined);
    assert.equal(locations[1].outside, true);
    assert.equal(locations[1].abs, outsideFile);
    assert.equal(locations[1].rel, outsideFile.split("\\").join("/"));
    assert.equal(locations[1].line, 0);
    assert.equal(locations[1].character, 16);
    const withText = await attachLineText(root, locations);
    assert.equal(withText[0].text, "foo();");
    assert.equal(withText[1].text, "export function foo(): void {}");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("findProjectRoot walks up to the first rootFile and stops at the workspace", async () => {
  const outer = await mkdtemp(join(tmpdir(), "dsh-idea-goto-root-"));
  try {
    await writeFile(join(outer, "Cargo.toml"), "[package]\nname = 'outer'\n", "utf8");
    const root = join(outer, "workspace");
    const web = join(root, "apps", "web");
    const srcDir = join(web, "src");
    await mkdir(srcDir, { recursive: true });
    await mkdir(join(root, "apps", "other", "src"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(web, "tsconfig.json"), "{}\n", "utf8");
    await writeFile(join(srcDir, "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(root, "apps", "other", "src", "b.ts"), "export const b = 1;\n", "utf8");
    await writeFile(join(root, "readme.md"), "x\n", "utf8");
    const realRoot = resolve(root);
    const realWeb = resolve(web);
    const tsRoots = ["tsconfig.json", "jsconfig.json", "package.json"];
    assert.equal(
      await findProjectRoot(join(srcDir, "a.ts"), tsRoots, root),
      realWeb
    );
    assert.equal(
      await findProjectRoot(join(root, "apps", "other", "src", "b.ts"), tsRoots, root),
      realRoot
    );
    assert.equal(
      await findProjectRoot(join(root, "readme.md"), ["Cargo.toml"], root),
      realRoot
    );

    const ext = await mkdtemp(join(tmpdir(), "dsh-idea-goto-extroot-"));
    try {
      const crate = join(ext, "crate");
      await mkdir(join(crate, "src"), { recursive: true });
      await writeFile(join(crate, "Cargo.toml"), "[package]\nname = 'demo'\n", "utf8");
      await writeFile(join(crate, "src", "lib.rs"), "pub fn f() {}\n", "utf8");
      assert.equal(
        await findProjectRoot(join(crate, "src", "lib.rs"), ["Cargo.toml"], root),
        resolve(crate)
      );
    } finally {
      await rm(ext, { recursive: true, force: true });
    }
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("readExternalText opens an absolute path and resolveQueryFile uses it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dsh-idea-goto-cwd-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "dsh-idea-goto-lib-"));
  try {
    await writeFile(join(workspace, "main.go"), "package main\n", "utf8");
    const lib = join(outsideDir, "print.go");
    await writeFile(lib, "package fmt\nfunc Print() {}\n", "utf8");
    const read = await readExternalText(lib);
    assert.equal(read.text, "package fmt\nfunc Print() {}\n");
    assert.equal(read.abs, await realpath(lib));
    const located = await resolveQueryFile(workspace, "main.go", lib);
    assert.equal(located.abs, await realpath(lib));
    assert.equal(located.root, await realpath(workspace));
    await assert.rejects(() => readExternalText("relative/path.go"), (err) => err instanceof FsError && err.code === "bad-path");
    await assert.rejects(() => resolveExternalFile(join(outsideDir, "missing.go")), (err) => err instanceof FsError && err.code === "not-found");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("gotoSymbol falls back to references only for goToDefinition, with parentheses", () => {
  const body = gotoSymbolSource(clientSrc);
  assert.match(body, /if \(operation === "goToDefinition" && \(locations\.length === 0 \|\| selfOnly\)\)/);
  assert.equal(body.includes('if (operation === "goToDefinition" && locations.length === 0 || selfOnly)'), false);
});

test("gotoSymbol does not block non-ASCII or non-word cursors", () => {
  const body = gotoSymbolSource(clientSrc);
  assert.equal(body.includes("/^[A-Za-z_$]"), false);
  assert.match(body, /if \(current === null \|\| current\.binary \|\| !el\) return;/);
  assert.match(body, /character: at\.character/);
});
