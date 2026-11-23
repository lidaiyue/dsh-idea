import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearCommandCache,
  resolveCommand,
  resolveServer,
  serverFor,
  serversFor,
  setStrictCommandPath
} from "../lib/lsp/servers.js";

/** Put only the named fake commands on PATH and restore afterwards. */
async function withCommands(names, fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-idea-lsp-"));
  const previous = process.env.PATH;
  try {
    for (const name of names) {
      const file = join(dir, name);
      await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(file, 0o755);
    }
    process.env.PATH = dir;
    setStrictCommandPath(true);
    return await fn();
  } finally {
    process.env.PATH = previous;
    setStrictCommandPath(false);
    await rm(dir, { recursive: true, force: true });
  }
}

test("Java uses only jindex", () => {
  const servers = serversFor("java");
  assert.deepEqual(servers.map((s) => s.id), ["java-index"]);
  assert.equal(serverFor("java").command, "jindex");
});

test("resolveServer picks jindex when it is on PATH", async () => {
  await withCommands(["jindex"], async () => {
    const server = await resolveServer("java");
    assert.equal(server.id, "java-index");
    assert.equal(server.command, "jindex");
    assert.equal(await resolveCommand("jindex"), join(process.env.PATH, "jindex"));
  });
});

test("resolveServer returns null when jindex is missing", async () => {
  await withCommands(["jdtls"], async () => {
    assert.equal(await resolveServer("java"), null);
  });
});

test("resolveServer finds jindex in ~/.local/bin when PATH omits it", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-idea-home-"));
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const jindex = join(bin, "jindex");
  await writeFile(jindex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  try {
    process.env.HOME = home;
    process.env.PATH = "/usr/bin:/bin";
    setStrictCommandPath(false);
    const server = await resolveServer("java");
    assert.equal(server.id, "java-index");
    assert.equal(server.commandPath, jindex);
  } finally {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    setStrictCommandPath(false);
    await rm(home, { recursive: true, force: true });
  }
});
