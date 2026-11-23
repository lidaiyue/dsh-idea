import assert from "node:assert/strict";
import test from "node:test";
import { Runner } from "../lib/run/runner.js";

const ENTRY = {
  id: "app",
  name: "app",
  command: "node server.js",
  cwd: ".",
  sandbox: "workspace-write"
};

function fakeShell() {
  const started = [];
  return {
    started,
    resolve(request) {
      return { ...request, workdir: "/tmp", timeoutMs: 0, onExpiry: "none", stdoutMaxBytes: 65536 };
    },
    execute(spec) {
      let settle;
      const done = new Promise((resolve) => { settle = resolve; });
      const streams = { stdout: "", stderr: "" };
      const reader = (channel) => ({
        readFrom(fromByte) {
          const text = streams[channel].slice(fromByte);
          return { text, nextOffset: streams[channel].length, lossy: false };
        }
      });
      const exec = {
        spec,
        status: "running",
        exitCode: null,
        done,
        kill() { exec.status = "killed"; settle(); return true; },
        observed: { stdout: reader("stdout"), stderr: reader("stderr") },
        write(text) { streams.stdout += text; },
        finish(exitCode) { exec.status = "completed"; exec.exitCode = exitCode; settle(); }
      };
      started.push(exec);
      return Promise.resolve(exec);
    }
  };
}

test("an out-of-range announced port never reaches net.connect", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", ENTRY);
    // 99999 matches the 2-5 digit pattern. Before the fix net.connect threw
    // ERR_SOCKET_BAD_PORT synchronously, which the host's fail-loud handler
    // turns into exit(1). The port must be rejected before the socket call.
    shell.started[0].write("Tomcat started on port(s): 99999 (http)\n");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const tail = runner.tail("/tmp", "app", { stdout: 0, stderr: 0 });
    assert.equal(tail.port, undefined);
    assert.equal(tail.phase, "running");
  } finally {
    runner.dispose();
  }
});
