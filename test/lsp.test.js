import assert from "node:assert/strict";
import test from "node:test";
import { LspService } from "../lib/lsp/index.js";

/** A language server stand-in: `reap` only needs `stop()`. */
function fakeClient(stopped, name) {
  return {
    stopped: false,
    async stop() { stopped.push(name); }
  };
}

test("the idle reaper stops only servers nobody has used recently", () => {
  const service = new LspService();
  const stopped = [];
  service.clients.set("old", fakeClient(stopped, "old"));
  service.clients.set("fresh", fakeClient(stopped, "fresh"));
  // An epoch-zero clock is older than any sane idle window; a touched client is not.
  service.lastUsed.set("old", 0);
  service.touch("fresh");

  service.reap();

  assert.deepEqual([...service.clients.keys()], ["fresh"]);
  assert.deepEqual(stopped, ["old"]);
});

test("adding a server arms the sweep only once, and stop clears it", async () => {
  const service = new LspService();
  service.armReaper();
  const armed = service.reaper;
  service.armReaper();
  assert.equal(service.reaper, armed);

  await service.stop();

  assert.equal(service.reaper, null);
  assert.equal(service.clients.size, 0);
  assert.equal(service.lastUsed.size, 0);
});
