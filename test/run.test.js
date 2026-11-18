import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, loadRuns, saveRuns, upsertRun } from "../lib/run/config.js";
import { discover, resolveRuns } from "../lib/run/discover.js";
import { filterLines, stripAnsi } from "../lib/run/ansi.js";
import { classifyFailure } from "../lib/run/reason.js";
import { shouldScheduleRestart } from "../lib/run/restart.js";
import { Runner, spawnEnvOf } from "../lib/run/runner.js";

/** A workspace directory with an optional `.dsh/run.json` body. */
async function workspace(body) {
  const root = await mkdtemp(join(tmpdir(), "dsh-run-test-"));
  await mkdir(join(root, ".dsh"), { recursive: true });
  if (body !== undefined) await writeFile(join(root, ".dsh", "run.json"), body, "utf8");
  return root;
}

/** A shell service whose processes the test drives by hand. */
function fakeShell() {
  const started = [];
  return {
    started,
    resolve(request) {
      return { ...request, workdir: request.workdir ?? "/tmp", timeoutMs: 0, onExpiry: "none", stdoutMaxBytes: 65536 };
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
        kill() {
          exec.status = "killed";
          settle();
          return true;
        },
        observed: { stdout: reader("stdout"), stderr: reader("stderr") },
        write(text) { streams.stdout += text; },
        finish(exitCode) {
          exec.status = "completed";
          exec.exitCode = exitCode;
          settle();
        }
      };
      started.push(exec);
      return Promise.resolve(exec);
    }
  };
}

const ENTRY = { id: "app", name: "app", command: "node server.js", cwd: "/tmp", sandbox: "workspace-write" };

test("a workspace without a configuration file yields an empty list", async () => {
  const root = await workspace();
  try {
    const document = await loadRuns(root);
    assert.deepEqual(document.runs, []);
    assert.equal(document.file, join(root, ".dsh", "run.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entries default their id to the name and resolve a relative cwd", async () => {
  const root = await workspace(JSON.stringify({
    runs: [
      { name: "api", command: "npm start", cwd: "services/api" },
      { id: "worker", name: "worker", command: "node worker.js", sandbox: "danger-full-access", env: { PORT: "8080" } }
    ]
  }));
  try {
    const document = await loadRuns(root);
    assert.equal(document.runs.length, 2);
    assert.equal(document.runs[0].id, "api");
    assert.equal(document.runs[0].cwd, join(root, "services", "api"));
    assert.equal(document.runs[0].sandbox, "workspace-write");
    assert.equal(document.runs[1].id, "worker");
    assert.equal(document.runs[1].cwd, root);
    assert.equal(document.runs[1].sandbox, "danger-full-access");
    assert.deepEqual(document.runs[1].env, { PORT: "8080" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken configuration file names the offending entry", async () => {
  const cases = [
    ["{ not json", "config-bad-json"],
    [JSON.stringify({}), "config-missing-runs"],
    [JSON.stringify({ runs: [{ name: "api" }] }), "config-entry-command"],
    [JSON.stringify({ runs: [{ command: "npm start" }] }), "config-entry-name"],
    [JSON.stringify({ runs: [{ name: "api", command: "a" }, { name: "api", command: "b" }] }), "config-duplicate-id"],
    [JSON.stringify({ runs: [{ name: "api", command: "a", sandbox: "loose" }] }), "config-entry-sandbox"]
  ];
  for (const [body, code] of cases) {
    const root = await workspace(body);
    try {
      await assert.rejects(loadRuns(root), (error) => error instanceof ConfigError && error.code === code, `expected ${code}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a run reports its output by absolute offset until it is stopped", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    const started = await runner.start("/tmp", ENTRY);
    assert.equal(started.state, "running");
    assert.equal(shell.started.length, 1);
    // The application writes its own project root as the sandbox workspace.
    assert.deepEqual(shell.started[0].spec.sandboxPolicy, { mode: "workspace-write", workspaceRoot: "/tmp" });
    assert.equal(shell.started[0].spec.onExpiry, "none");

    shell.started[0].write("listening on 8080\n");
    const first = runner.tail("/tmp", "app", { stdout: 0, stderr: 0 });
    assert.equal(first.stdout.text, "listening on 8080\n");
    assert.equal(first.stdout.next, 18);

    const again = runner.tail("/tmp", "app", { stdout: first.stdout.next, stderr: 0 });
    assert.equal(again.stdout.text, "");

    runner.stop("/tmp", "app");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settled = runner.tail("/tmp", "app", { stdout: 18, stderr: 0 });
    assert.equal(settled.state, "stopped");
  } finally {
    runner.dispose();
  }
});

test("a process that exits on its own is reported as exited with its code", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", ENTRY);
    shell.started[0].write("done\n");
    shell.started[0].finish(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tail = runner.tail("/tmp", "app", { stdout: 0, stderr: 0 });
    assert.equal(tail.state, "exited");
    assert.equal(tail.exitCode, 2);
  } finally {
    runner.dispose();
  }
});

test("a configuration this process never started reads as idle", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    assert.equal(runner.tail("/tmp", "app", { stdout: 0, stderr: 0 }), null);
    const rows = runner.list("/tmp", [ENTRY]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "idle");
  } finally {
    runner.dispose();
  }
});

test("starting twice keeps one process", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", ENTRY);
    await runner.start("/tmp", ENTRY);
    assert.equal(shell.started.length, 1);
  } finally {
    runner.dispose();
  }
});

/** Write a project file, creating its directory. */
async function put(root, rel, text) {
  const file = join(root, rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text, "utf8");
}

test("discovery reads npm scripts, a Spring Boot module, and compose", async () => {
  const root = await workspace();
  try {
    await put(root, "package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build", postinstall: "x" } }));
    await put(root, "pom.xml", "<project><modules><module>api</module></modules></project>");
    await put(root, "api/pom.xml", "<project/>");
    await put(root, "api/src/main/java/com/example/ApiApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class ApiApplication {}\n");
    await put(root, "api/src/main/resources/application.properties", "server.port=9091\n");
    await put(root, "compose.yaml", "services: {}\n");

    const document = await resolveRuns(root);
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(byId.get("script:dev").command, "npm run dev");
    assert.equal(byId.has("script:build"), false);
    assert.equal(byId.has("script:postinstall"), false);
    assert.equal(document.runs.filter((run) => run.source === "package.json").length, 1);
    assert.equal(byId.get("maven:api").name, "ApiApplication");
    assert.equal(byId.get("maven:api").command, "mvn -pl api spring-boot:run");
    assert.equal(byId.get("maven:api").cwd, root);
    assert.equal(byId.get("maven:api").port, 9091);
    assert.equal(byId.get("compose:up").command, "docker compose up");
    assert.equal(document.declared, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit entry replaces the discovered one with the same id", async () => {
  const root = await workspace(JSON.stringify({ runs: [{ id: "script:dev", name: "dev", command: "pnpm dev --host" }] }));
  try {
    await put(root, "package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    const document = await resolveRuns(root);
    const dev = document.runs.filter((run) => run.id === "script:dev");
    assert.equal(dev.length, 1);
    assert.equal(dev[0].command, "pnpm dev --host");
    assert.equal(document.declared, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery caches briefly and a forced read sees new files", async () => {
  const root = await workspace();
  try {
    await put(root, "package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    assert.equal((await discover(root)).runs.length, 1);
    await put(root, "package.json", JSON.stringify({ scripts: { dev: "vite", serve: "vite preview" } }));
    assert.equal((await discover(root)).runs.length, 1);
    await put(root, "compose.yaml", "services: {}\n");
    assert.equal((await discover(root)).runs.length, 1);
    assert.equal((await discover(root, true)).runs.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an announced port becomes the run's port and readiness follows the socket", async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", { ...ENTRY, port: port });
    assert.equal(runner.tail("/tmp", "app", { stdout: 0, stderr: 0 }).phase, "starting");
    // The probe runs on its own timer; one beat is enough for a listening port.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const tail = runner.tail("/tmp", "app", { stdout: 0, stderr: 0 });
    assert.equal(tail.port, port);
    assert.equal(tail.phase, "ready");
  } finally {
    runner.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an application that announces its port on stdout is picked up", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", ENTRY);
    shell.started[0].write("Tomcat started on port(s): 18080 (http) with context path ''\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tail = runner.tail("/tmp", "app", { stdout: 0, stderr: 0 });
    assert.equal(tail.port, 18080);
    assert.equal(tail.phase, "starting");
  } finally {
    runner.dispose();
  }
});

test("restart replaces the process", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", ENTRY);
    assert.equal(shell.started.length, 1);
    const restarted = await runner.restart("/tmp", ENTRY);
    assert.equal(shell.started.length, 2);
    assert.equal(restarted.state, "running");
  } finally {
    runner.dispose();
  }
});

test("a restart that outlives the stop wait keeps the old process killable", async () => {
  const shell = fakeShell();
  const kills = new Map();
  shell.execute = (spec) => {
    const exec = {
      spec,
      status: "running",
      exitCode: null,
      done: new Promise(() => {}),
      kill() {
        kills.set(exec, (kills.get(exec) || 0) + 1);
        return false;
      },
      observed: {
        stdout: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } },
        stderr: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } }
      }
    };
    shell.started.push(exec);
    return Promise.resolve(exec);
  };
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) }, { stopWaitMs: 0 });
  try {
    await runner.start("/tmp", ENTRY);
    const old = shell.started[0];
    const restarted = await runner.restart("/tmp", ENTRY);
    assert.equal(restarted.state, "running");
    assert.equal(shell.started.length, 2);
    assert.equal(kills.get(old) >= 2, true);
    runner.dispose();
    assert.equal(kills.get(old) >= 3, true);
  } finally {
    runner.dispose();
  }
});

test("saving a configuration file round-trips and writes a relative cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-run-test-"));
  try {
    const saved = await saveRuns(root, [
      { id: "api", name: "api", command: "npm start", cwd: join(root, "services", "api"), port: 8080, env: { NODE_ENV: "development" } },
      { id: "worker", name: "worker", command: "node worker.js", sandbox: "danger-full-access" }
    ]);
    assert.equal(saved.runs[0].cwd, join(root, "services", "api"));
    assert.equal(saved.runs[1].cwd, root);

    const raw = JSON.parse(await readFile(join(root, ".dsh", "run.json"), "utf8"));
    assert.equal(raw.runs[0].id, "api");
    assert.equal(raw.runs[0].cwd, join("services", "api").split("\\").join("/"));
    assert.equal(raw.runs[0].port, 8080);
    assert.deepEqual(raw.runs[0].env, { NODE_ENV: "development" });
    assert.equal(raw.runs[0].sandbox, undefined);
    assert.equal(raw.runs[1].cwd, undefined);
    assert.equal(raw.runs[1].sandbox, "danger-full-access");

    const document = await loadRuns(root);
    assert.equal(document.runs.length, 2);
    assert.equal(document.runs[0].cwd, join(root, "services", "api"));
    assert.equal(document.runs[0].port, 8080);
    assert.deepEqual(document.runs[0].env, { NODE_ENV: "development" });
    assert.equal(document.runs[1].cwd, root);
    assert.equal(document.runs[1].sandbox, "danger-full-access");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upserting by id overrides the same entry and keeps omitted fields", async () => {
  const root = await workspace(JSON.stringify({
    runs: [{ id: "maven:api", name: "ApiApplication", command: "mvn -pl api spring-boot:run", port: 8080, env: { SPRING_PROFILES_ACTIVE: "dev" } }]
  }));
  try {
    await put(root, "pom.xml", "<project/>");
    const updated = await upsertRun(root, { id: "maven:api", port: 9091, command: "mvn -pl api spring-boot:run -DskipTests" });
    assert.equal(updated.runs.length, 1);
    assert.equal(updated.runs[0].id, "maven:api");
    assert.equal(updated.runs[0].name, "ApiApplication");
    assert.equal(updated.runs[0].command, "mvn -pl api spring-boot:run -DskipTests");
    assert.equal(updated.runs[0].port, 9091);
    assert.deepEqual(updated.runs[0].env, { SPRING_PROFILES_ACTIVE: "dev" });

    const raw = JSON.parse(await readFile(join(root, ".dsh", "run.json"), "utf8"));
    assert.equal(raw.runs[0].id, "maven:api");
    assert.equal(raw.runs[0].port, 9091);

    await upsertRun(root, { id: "worker", name: "worker", command: "node worker.js" });
    const document = await loadRuns(root);
    assert.equal(document.runs.map((run) => run.id).join(","), "maven:api,worker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid entry is rejected and leaves the existing file untouched", async () => {
  const root = await workspace(JSON.stringify({ runs: [{ name: "ok", command: "npm start" }] }));
  try {
    await assert.rejects(
      saveRuns(root, [{ name: "api" }]),
      (error) => error instanceof ConfigError && error.code === "config-entry-command"
    );
    await assert.rejects(
      saveRuns(root, [{ name: "api", command: "npm start", port: 70000 }]),
      (error) => error instanceof ConfigError && error.code === "config-entry-port"
    );
    await assert.rejects(
      upsertRun(root, { id: "ok", env: { PORT: 8080 } }),
      (error) => error instanceof ConfigError && error.code === "config-entry-env"
    );
    const document = await loadRuns(root);
    assert.equal(document.runs.length, 1);
    assert.equal(document.runs[0].name, "ok");
    assert.equal(document.runs[0].command, "npm start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("failure reasons are classified from error text, logs, and exit code", () => {
  assert.equal(classifyFailure({ error: "listen EADDRINUSE: address already in use :::8080" }), "port-in-use");
  assert.equal(classifyFailure({ output: "Web server failed to start. Port 8080 was already in use." }), "port-in-use");
  assert.equal(classifyFailure({ output: "java.net.BindException: Address already in use" }), "port-in-use");
  assert.equal(classifyFailure({ error: "spawn mvn ENOENT" }), "command-not-found");
  assert.equal(classifyFailure({ output: "/bin/sh: mvn: command not found", exitCode: 127 }), "command-not-found");
  assert.equal(classifyFailure({ exitCode: 127 }), "command-not-found");
  assert.equal(classifyFailure({ output: "npm: not found" }), "command-not-found");
  assert.equal(classifyFailure({ error: "EACCES: permission denied, open '/etc/hosts'" }), "sandbox-denied");
  assert.equal(classifyFailure({ output: "Operation not permitted" }), "sandbox-denied");
  assert.equal(classifyFailure({ error: "sandbox write denied under /Users/me/.m2" }), "sandbox-denied");
  assert.equal(classifyFailure({ exitCode: 1, output: "Application run failed" }), undefined);
  assert.equal(classifyFailure({ error: "failed" }), undefined);
  assert.equal(classifyFailure({}), undefined);
});

test("an exited process carries a classified reason and a failed spawn carries its error", async () => {
  const shell = fakeShell();
  const runner = new Runner({ get: (name) => (name === "shell" ? shell : undefined) });
  try {
    await runner.start("/tmp", ENTRY);
    shell.started[0].write("***************************\nAPPLICATION FAILED TO START\n***************************\n\nWeb server failed to start. Port 8080 was already in use.\n");
    shell.started[0].finish(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = runner.list("/tmp", [ENTRY]);
    assert.equal(rows[0].state, "exited");
    assert.equal(rows[0].exitCode, 1);
    assert.equal(rows[0].reason, "port-in-use");
    assert.equal(rows[0].error, undefined);

    const idle = runner.list("/tmp", [{ ...ENTRY, id: "other", name: "other" }])[0];
    assert.equal(idle.state, "idle");
    assert.equal(idle.reason, undefined);

    const crashing = fakeShell();
    crashing.execute = (spec) => {
      const exec = {
        spec,
        status: "failed",
        exitCode: null,
        done: Promise.reject(new Error("spawn mvn ENOENT")),
        kill() { return false; },
        observed: {
          stdout: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } },
          stderr: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } }
        }
      };
      crashing.started.push(exec);
      return Promise.resolve(exec);
    };
    const failing = new Runner({ get: (name) => (name === "shell" ? crashing : undefined) });
    try {
      await failing.start("/tmp", ENTRY);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const failed = failing.list("/tmp", [ENTRY])[0];
      assert.equal(failed.state, "failed");
      assert.equal(failed.error, "spawn mvn ENOENT");
      assert.equal(failed.reason, "command-not-found");
    } finally {
      failing.dispose();
    }
  } finally {
    runner.dispose();
  }
});


test("stripAnsi removes CSI, OSC, and leftover SGR without touching ordinary brackets", () => {
  assert.equal(stripAnsi("\u001b[32mhello\u001b[0m"), "hello");
  assert.equal(stripAnsi("\u001b[1;31mred\u001b[0m"), "red");
  assert.equal(stripAnsi("\u001b[38;5;82mgreen\u001b[0m"), "green");
  assert.equal(stripAnsi("ok [32mgreen[0m done"), "ok green done");
  assert.equal(stripAnsi("[stderr]\nboom\n[foo] and [output clipped]"), "[stderr]\nboom\n[foo] and [output clipped]");
  assert.equal(stripAnsi("\u001b]0;title\u0007prompt"), "prompt");
  assert.equal(stripAnsi("[stderr]\n\u001b[31mboom\u001b[0m\n[32mleftover[0m"), "[stderr]\nboom\nleftover");
  assert.equal(stripAnsi(""), "");
});

test("filterLines keeps lines that contain the keyword, case-insensitively", () => {
  const text = "Hello\nERROR: boom\ninfo: ok\n";
  assert.equal(filterLines(text, ""), text);
  assert.equal(filterLines(text, undefined), text);
  assert.equal(filterLines(text, "error"), "ERROR: boom");
  assert.equal(filterLines(text, "INFO"), "info: ok");
  assert.equal(filterLines(text, "nope"), "");
  assert.equal(filterLines("", "x"), "");
});


/** A runner whose auto-restart delays fit inside a short test. */
function runnerOf(shell, restart) {
  return new Runner({ get: (name) => (name === "shell" ? shell : undefined) }, { restart });
}

/** Resolve once `fn` is truthy, or fail after `timeoutMs`. */
async function waitUntil(fn, timeoutMs = 600) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

const AUTO = { ...ENTRY, autoRestart: true };
const FAST = { delaysMs: [15], limit: 3, healthyMs: 5000 };

test("autoRestart is persisted on an entry and an upsert can flip only the flag", async () => {
  const root = await workspace(JSON.stringify({
    runs: [{ id: "api", name: "api", command: "npm start", port: 8080, env: { NODE_ENV: "development" } }]
  }));
  try {
    const document = await loadRuns(root);
    assert.equal(document.runs[0].autoRestart, undefined);

    const saved = await upsertRun(root, { id: "api", autoRestart: true });
    assert.equal(saved.runs[0].autoRestart, true);
    assert.equal(saved.runs[0].port, 8080);
    assert.deepEqual(saved.runs[0].env, { NODE_ENV: "development" });

    const raw = JSON.parse(await readFile(join(root, ".dsh", "run.json"), "utf8"));
    assert.equal(raw.runs[0].autoRestart, true);
    assert.equal(raw.runs[0].port, 8080);
    assert.deepEqual(raw.runs[0].env, { NODE_ENV: "development" });

    const cleared = await upsertRun(root, { id: "api", autoRestart: false });
    assert.equal(cleared.runs[0].autoRestart, undefined);
    assert.equal(cleared.runs[0].port, 8080);
    const after = JSON.parse(await readFile(join(root, ".dsh", "run.json"), "utf8"));
    assert.equal(after.runs[0].autoRestart, undefined);

    await assert.rejects(
      saveRuns(root, [{ name: "api", command: "npm start", autoRestart: "yes" }]),
      (error) => error instanceof ConfigError && error.code === "config-entry-auto-restart"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shouldScheduleRestart allows an exited crash and refuses a user stop or an unrecoverable failure", () => {
  const base = { autoRestart: true, attempt: 0, limit: 8, failedRetries: 0 };
  assert.equal(shouldScheduleRestart({ ...base, state: "exited" }), true);
  assert.equal(shouldScheduleRestart({ ...base, state: "stopped" }), false);
  assert.equal(shouldScheduleRestart({ ...base, state: "failed", reason: "command-not-found" }), false);
  assert.equal(shouldScheduleRestart({ ...base, state: "failed", reason: "sandbox-denied" }), false);
  assert.equal(shouldScheduleRestart({ ...base, state: "exited", reason: "port-in-use" }), false);
  assert.equal(shouldScheduleRestart({ ...base, state: "failed", reason: undefined }), true);
  assert.equal(shouldScheduleRestart({ ...base, state: "failed", reason: undefined, failedRetries: 1 }), false);
  assert.equal(shouldScheduleRestart({ ...base, state: "exited", attempt: 8, limit: 8 }), false);
  assert.equal(shouldScheduleRestart({ ...base, autoRestart: false, state: "exited" }), false);
});

test("an exited process with autoRestart on is started again", async () => {
  const shell = fakeShell();
  const runner = runnerOf(shell, FAST);
  try {
    const started = await runner.start("/tmp", AUTO);
    assert.equal(started.state, "running");
    assert.equal(started.autoRestart, true);
    assert.equal(shell.started.length, 1);
    shell.started[0].write("boom\n");
    shell.started[0].finish(1);
    await waitUntil(() => shell.started.length === 2);
    const rows = runner.list("/tmp", [AUTO]);
    assert.equal(rows[0].state, "running");
    assert.equal(rows[0].autoRestart, true);
    assert.equal(shell.started.length, 2);
  } finally {
    runner.dispose();
  }
});

test("a user stop does not auto-restart even if the flag is on", async () => {
  const shell = fakeShell();
  const runner = runnerOf(shell, FAST);
  try {
    await runner.start("/tmp", AUTO);
    runner.stop("/tmp", "app");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(shell.started.length, 1);
    const rows = runner.list("/tmp", [AUTO]);
    assert.equal(rows[0].state, "stopped");
    assert.equal(rows[0].restartStatus, undefined);
  } finally {
    runner.dispose();
  }
});

test("an unrecoverable classified failure is not retried", async () => {
  const crashing = fakeShell();
  crashing.execute = (spec) => {
    const exec = {
      spec,
      status: "failed",
      exitCode: null,
      done: Promise.reject(new Error("spawn mvn ENOENT")),
      kill() { return false; },
      observed: {
        stdout: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } },
        stderr: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } }
      }
    };
    crashing.started.push(exec);
    return Promise.resolve(exec);
  };
  const failing = runnerOf(crashing, FAST);
  try {
    await failing.start("/tmp", AUTO);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(crashing.started.length, 1);
    const failed = failing.list("/tmp", [AUTO])[0];
    assert.equal(failed.state, "failed");
    assert.equal(failed.reason, "command-not-found");
    assert.equal(failed.restartStatus, undefined);
  } finally {
    failing.dispose();
  }

  const shell = fakeShell();
  const runner = runnerOf(shell, FAST);
  try {
    await runner.start("/tmp", AUTO);
    shell.started[0].write("Web server failed to start. Port 8080 was already in use.\n");
    shell.started[0].finish(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(shell.started.length, 1);
    const rows = runner.list("/tmp", [AUTO]);
    assert.equal(rows[0].state, "exited");
    assert.equal(rows[0].reason, "port-in-use");
    assert.equal(rows[0].restartStatus, undefined);
  } finally {
    runner.dispose();
  }
});

test("auto-restart stops after the retry limit and surfaces the stopped status", async () => {
  const shell = fakeShell();
  const runner = runnerOf(shell, { delaysMs: [10], limit: 3, healthyMs: 10_000 });
  try {
    await runner.start("/tmp", AUTO);
    for (let count = 1; count <= 4; count += 1) {
      await waitUntil(() => shell.started.length === count);
      shell.started[count - 1].finish(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(shell.started.length, 4);
    const rows = runner.list("/tmp", [AUTO]);
    assert.equal(rows[0].state, "exited");
    assert.equal(rows[0].exitCode, 2);
    assert.equal(rows[0].restartStatus, "stopped");
    assert.equal(rows[0].restartAttempt, 3);
    assert.equal(rows[0].restartLimit, 3);
  } finally {
    runner.dispose();
  }
});

test("turning autoRestart off or stopping cancels a pending retry", async () => {
  const shell = fakeShell();
  const runner = runnerOf(shell, { delaysMs: [80], limit: 5, healthyMs: 5000 });
  try {
    await runner.start("/tmp", AUTO);
    shell.started[0].finish(1);
    await waitUntil(() => runner.list("/tmp", [AUTO])[0].restartStatus === "scheduled");
    runner.list("/tmp", [ENTRY]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(shell.started.length, 1);
    const afterFlag = runner.list("/tmp", [ENTRY])[0];
    assert.equal(afterFlag.state, "exited");
    assert.equal(afterFlag.autoRestart, false);
    assert.equal(afterFlag.restartStatus, undefined);
  } finally {
    runner.dispose();
  }

  const again = fakeShell();
  const second = runnerOf(again, { delaysMs: [80], limit: 5, healthyMs: 5000 });
  try {
    await second.start("/tmp", AUTO);
    again.started[0].finish(1);
    await waitUntil(() => second.list("/tmp", [AUTO])[0].restartStatus === "scheduled");
    const stopped = second.stop("/tmp", "app");
    assert.equal(stopped.state, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(again.started.length, 1);
    assert.equal(second.list("/tmp", [AUTO])[0].state, "stopped");
  } finally {
    second.dispose();
  }
});

test("a healthy stretch resets the retry budget so a later crash can retry again", async () => {
  const shell = fakeShell();
  const runner = runnerOf(shell, { delaysMs: [10], limit: 2, healthyMs: 30 });
  try {
    await runner.start("/tmp", AUTO);
    shell.started[0].finish(1);
    await waitUntil(() => shell.started.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runner.list("/tmp", [AUTO])[0].state, "running");
    shell.started[1].finish(1);
    await waitUntil(() => shell.started.length === 3);
    shell.started[2].finish(1);
    await waitUntil(() => shell.started.length === 4);
    shell.started[3].finish(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(shell.started.length, 4);
    const rows = runner.list("/tmp", [AUTO]);
    assert.equal(rows[0].state, "exited");
    assert.equal(rows[0].restartStatus, "stopped");
  } finally {
    runner.dispose();
  }
});

test("discovery reads Gradle include lines that use a leading colon", async () => {
  const root = await workspace();
  try {
    await put(root, "settings.gradle", "include ':api', ':web'\n");
    await put(root, "gradlew", "#!/bin/sh\n");
    await put(root, "api/build.gradle", "plugins { id 'org.springframework.boot' }\n");
    await put(root, "api/src/main/java/com/example/ApiApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class ApiApplication {}\n");
    await put(root, "web/build.gradle", "plugins { id 'org.springframework.boot' }\n");
    await put(root, "web/src/main/java/com/example/WebApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class WebApplication {}\n");

    const document = await resolveRuns(root, true);
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(byId.get("gradle:api").name, "ApiApplication");
    assert.equal(byId.get("gradle:api").command, "./gradlew :api:bootRun");
    assert.equal(byId.get("gradle:api").cwd, join(root, "api"));
    assert.equal(byId.get("gradle:web").name, "WebApplication");
    assert.equal(byId.get("gradle:web").command, "./gradlew :web:bootRun");
    assert.equal(byId.has("gradle::api"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery follows a two-level Maven reactor and skips aggregator modules", async () => {
  const root = await workspace();
  try {
    await put(root, "pom.xml", "<project><modules><module>platform</module></modules></project>");
    await put(root, "platform/pom.xml", "<project><packaging>pom</packaging><modules><module>api</module></modules></project>");
    await put(root, "platform/api/pom.xml", "<project/>");
    await put(root, "platform/api/src/main/java/com/example/ApiApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class ApiApplication {}\n");
    await put(root, "platform/api/src/main/resources/application.properties", "server.port=8088\n");
    await put(root, "mvnw", "#!/bin/sh\n");

    const document = await resolveRuns(root, true);
    const maven = document.runs.filter((run) => run.id.startsWith("maven:"));
    assert.equal(maven.length, 1);
    assert.equal(maven[0].id, "maven:platform/api");
    assert.equal(maven[0].name, "ApiApplication");
    assert.equal(maven[0].command, "./mvnw -pl platform/api spring-boot:run");
    assert.equal(maven[0].cwd, root);
    assert.equal(maven[0].port, 8088);
    assert.equal(document.runs.some((run) => run.id === "maven:platform" || run.name === "platform"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery finds Maven and package.json projects under a workspace parent", async () => {
  const root = await workspace();
  try {
    await put(root, "web/package.json", JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }));
    await put(root, "project/pom.xml", "<project><modules><module>services</module></modules></project>");
    await put(root, "project/services/pom.xml", "<project><packaging>pom</packaging><modules><module>admin</module></modules></project>");
    await put(root, "project/services/admin/pom.xml", "<project/>");
    await put(root, "project/services/admin/src/main/java/com/example/AdminApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class AdminApplication {}\n");
    await put(root, "project/mvnw", "#!/bin/sh\n");
    await put(root, "app/pom.xml", "<project/>");
    await put(root, "app/src/main/java/com/example/DemoApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class DemoApplication {}\n");

    const document = await resolveRuns(root, true);
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(byId.get("script:web/dev").command, "npm run dev");
    assert.equal(byId.get("script:web/dev").cwd, join(root, "web"));
    assert.equal(byId.has("script:web/test"), false);
    assert.equal(document.runs.filter((run) => run.source === "package.json").length, 1);
    assert.equal(byId.get("maven:project/services/admin").name, "AdminApplication");
    assert.equal(byId.get("maven:project/services/admin").command, "./mvnw -pl services/admin spring-boot:run");
    assert.equal(byId.get("maven:project/services/admin").cwd, join(root, "project"));
    assert.equal(byId.get("maven:app").name, "DemoApplication");
    assert.equal(byId.get("maven:app").command, "mvn spring-boot:run");
    assert.equal(byId.get("maven:app").cwd, join(root, "app"));
    assert.equal(document.runs.filter((run) => run.id.startsWith("maven:")).length, 2);
    assert.equal(document.sources.includes("pom.xml"), true);
    assert.equal(document.sources.includes("package.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery keeps one dev-like script per package.json and skips build-only packages", async () => {
  const root = await workspace();
  try {
    await put(root, "package.json", JSON.stringify({
      scripts: { build: "vite build", "build-test": "vite build --mode test", "build-uat": "x", test: "vitest", lint: "eslint", analy: "webpack --analyze", postinstall: "x" }
    }));
    await put(root, "web/package.json", JSON.stringify({ scripts: { start: "vite", "dev:app": "vite --open", serve: "vite preview" } }));
    await put(root, "admin/package.json", JSON.stringify({ scripts: { "dev:legacy": "vite --config legacy.js", "start:app": "node server.js" } }));
    await put(root, "tools/package.json", JSON.stringify({ scripts: { build: "tsc", lint: "eslint", test: "node --test" } }));

    const document = await resolveRuns(root, true);
    const scripts = document.runs.filter((run) => run.source === "package.json");
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(scripts.length, 2);
    assert.equal(byId.has("script:start"), false);
    assert.equal(byId.has("script:dev"), false);
    assert.equal(byId.get("script:web/start").command, "npm run start");
    assert.equal(byId.get("script:web/start").cwd, join(root, "web"));
    assert.equal(byId.has("script:web/dev:app"), false);
    assert.equal(byId.has("script:web/serve"), false);
    assert.equal(byId.get("script:admin/dev:legacy").command, "npm run dev:legacy");
    assert.equal(byId.get("script:admin/dev:legacy").cwd, join(root, "admin"));
    assert.equal(byId.has("script:admin/start:app"), false);
    assert.equal(document.runs.some((run) => run.cwd === join(root, "tools") || String(run.id).includes("tools")), false);
    assert.equal(document.runs.some((run) => /build|test|lint|analy/i.test(run.name)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spawnEnvOf fills JAVA_HOME only when the Host and the entry did not already name a JDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-run-jdk-"));
  const real = join(root, "jdk");
  const other = join(root, "other");
  try {
    await mkdir(join(real, "bin"), { recursive: true });
    await writeFile(join(real, "bin", "java"), "#!/bin/sh\n", { mode: 0o755 });
    await mkdir(join(other, "bin"), { recursive: true });
    await writeFile(join(other, "bin", "java"), "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(spawnEnvOf(undefined, { PATH: "/usr/bin" }, () => undefined), undefined);
    assert.equal(spawnEnvOf(undefined, { PATH: "/usr/bin" }, () => join(root, "missing")), undefined);

    const injected = spawnEnvOf(undefined, { PATH: "/usr/bin" }, () => real);
    assert.equal(injected.JAVA_HOME, real);
    assert.equal(injected.PATH, join(real, "bin") + ":/usr/bin");

    const hostSet = spawnEnvOf(undefined, { JAVA_HOME: real, PATH: "/usr/bin" }, () => other);
    assert.equal(hostSet, undefined);

    const entryWins = spawnEnvOf({ JAVA_HOME: real, FOO: "bar" }, { PATH: "/usr/bin" }, () => other);
    assert.equal(entryWins.JAVA_HOME, real);
    assert.equal(entryWins.FOO, "bar");
    assert.equal(entryWins.PATH, join(real, "bin") + ":/usr/bin");

    const bogusEntry = spawnEnvOf({ JAVA_HOME: join(root, "missing") }, { PATH: "/usr/bin" }, () => real);
    assert.equal(bogusEntry.JAVA_HOME, real);
    assert.equal(bogusEntry.PATH, join(real, "bin") + ":/usr/bin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery skips turbo-run and lists concrete monorepo apps", async () => {
  const root = await workspace();
  try {
    await put(root, "service/pom.xml", "<project/>");
    await put(root, "service/src/main/java/com/example/BNGSApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class BNGSApplication {}\n");
    await put(root, "web/package.json", JSON.stringify({
      name: "vben-admin-monorepo",
      packageManager: "pnpm@10.10.0",
      scripts: {
        dev: "turbo-run dev",
        "dev:antd": "pnpm -F @vben/web-antd run dev",
        "dev:docs": "pnpm -F @vben/docs run dev",
        "dev:play": "pnpm -F @vben/playground run dev",
        preview: "turbo-run preview",
        build: "turbo build"
      }
    }));
    await put(root, "web/pnpm-workspace.yaml", "packages:\n  - apps/*\n  - docs\n");
    await put(root, "web/turbo.json", "{ \"tasks\": { \"dev\": {} } }\n");
    await put(root, "web/apps/web-antd/package.json", JSON.stringify({ name: "@vben/web-antd", scripts: { dev: "vite" } }));
    await put(root, "web/apps/ie-supplement/package.json", JSON.stringify({ name: "ie-supplement", scripts: { dev: "webpack serve --mode development" } }));
    await put(root, "web/apps/backend-mock/package.json", JSON.stringify({ name: "@vben/backend-mock", scripts: { start: "nitro dev" } }));
    await put(root, "web/playground/package.json", JSON.stringify({ name: "playground", scripts: { dev: "vite" } }));
    await put(root, "web/docs/package.json", JSON.stringify({ name: "docs", scripts: { dev: "vitepress dev" } }));
    await put(root, "web/packages/utils/package.json", JSON.stringify({ name: "@vben/utils", scripts: { dev: "tsup --watch" } }));

    const document = await resolveRuns(root, true);
    const scripts = document.runs.filter((run) => run.source === "package.json");
    const maven = document.runs.filter((run) => run.source === "pom.xml");
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(maven.length, 1);
    assert.equal(maven[0].name, "BNGSApplication");
    assert.equal(scripts.length, 2);
    assert.equal(byId.get("script:web/dev:antd").name, "dev:antd");
    assert.equal(byId.get("script:web/dev:antd").command, "pnpm run dev:antd");
    assert.equal(byId.get("script:web/dev:antd").cwd, join(root, "web"));
    assert.equal(byId.get("script:web/ie-supplement").name, "ie-supplement");
    assert.equal(byId.get("script:web/ie-supplement").command, "pnpm -F ie-supplement run dev");
    assert.equal(byId.get("script:web/ie-supplement").cwd, join(root, "web"));
    assert.equal(byId.has("script:web/dev"), false);
    assert.equal(byId.has("script:web/dev:docs"), false);
    assert.equal(byId.has("script:web/dev:play"), false);
    assert.equal(byId.has("script:web/preview"), false);
    assert.equal(byId.has("script:web/apps/web-antd/dev"), false);
    assert.equal(byId.has("script:web/apps/backend-mock/start"), false);
    assert.equal(byId.has("script:web/playground/dev"), false);
    assert.equal(byId.has("script:web/docs/dev"), false);
    assert.equal(document.runs.some((run) => String(run.id).includes("packages") || /docs|play|mock|preview/i.test(run.name)), false);
    assert.equal(document.runs.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery still lists one script per sibling frontend outside a monorepo", async () => {
  const root = await workspace();
  try {
    await put(root, "mmcp_web/package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
    await put(root, "mmcp/admin_web/package.json", JSON.stringify({ scripts: { dev: "vite", lint: "eslint" } }));
    await put(root, "backend/pom.xml", "<project/>");
    await put(root, "backend/src/main/java/com/example/ApiApplication.java",
      "package com.example;\n@SpringBootApplication\npublic class ApiApplication {}\n");

    const document = await resolveRuns(root, true);
    const scripts = document.runs.filter((run) => run.source === "package.json");
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(scripts.length, 2);
    assert.equal(byId.get("script:mmcp_web/dev").cwd, join(root, "mmcp_web"));
    assert.equal(byId.get("script:mmcp/admin_web/dev").cwd, join(root, "mmcp", "admin_web"));
    assert.equal(byId.get("maven:backend").name, "ApiApplication");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a monorepo emits root aliases and uncovered apps, not mock or preview", async () => {
  const root = await workspace();
  try {
    await put(root, "package.json", JSON.stringify({
      workspaces: ["apps/*"],
      scripts: {
        start: "node server.js",
        "dev:web": "npm run dev -w web",
        preview: "turbo-run preview"
      }
    }));
    await put(root, "apps/web/package.json", JSON.stringify({ name: "web", scripts: { dev: "vite" } }));
    await put(root, "apps/mock/package.json", JSON.stringify({ name: "mock", scripts: { start: "nitro dev" } }));
    await put(root, "apps/extra/package.json", JSON.stringify({ name: "extra", scripts: { dev: "vite" } }));

    const document = await resolveRuns(root, true);
    const scripts = document.runs.filter((run) => run.source === "package.json");
    const byId = new Map(document.runs.map((run) => [run.id, run]));
    assert.equal(scripts.length, 3);
    assert.equal(byId.get("script:start").command, "npm run start");
    assert.equal(byId.get("script:start").cwd, root);
    assert.equal(byId.get("script:dev:web").command, "npm run dev:web");
    assert.equal(byId.get("script:extra").name, "extra");
    assert.equal(byId.get("script:extra").command, "npm run dev -w extra");
    assert.equal(byId.get("script:extra").cwd, root);
    assert.equal(byId.has("script:preview"), false);
    assert.equal(byId.has("script:mock"), false);
    assert.equal(document.runs.some((run) => String(run.id).includes("apps/")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a standalone package skips an interactive preferred script and keeps a concrete one", async () => {
  const root = await workspace();
  try {
    await put(root, "package.json", JSON.stringify({
      scripts: { dev: "turbo-run dev", "dev:antd": "vite", lint: "eslint" }
    }));
    const document = await resolveRuns(root, true);
    assert.equal(document.runs.length, 1);
    assert.equal(document.runs[0].id, "script:dev:antd");
    assert.equal(document.runs[0].command, "npm run dev:antd");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("run.json rejects a cwd or writable root outside the workspace, and unsafe env keys", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, ".dsh", "run.json"), JSON.stringify({
      runs: [{ name: "escape", command: "pwd", cwd: "/tmp" }]
    }), "utf8");
    await assert.rejects(loadRuns(root), (error) => error instanceof ConfigError && error.code === "config-entry-cwd");

    await writeFile(join(root, ".dsh", "run.json"), JSON.stringify({
      runs: [{ name: "home", command: "pwd", cwd: "~" }]
    }), "utf8");
    await assert.rejects(loadRuns(root), (error) => error instanceof ConfigError && error.code === "config-entry-cwd");

    await writeFile(join(root, ".dsh", "run.json"), JSON.stringify({
      runs: [{ name: "wide", command: "pwd", writableRoots: ["/"] }]
    }), "utf8");
    await assert.rejects(loadRuns(root), (error) => error instanceof ConfigError && error.code === "config-entry-writable-roots");

    // Written as raw JSON so the "__proto__" key is preserved (an object
    // literal would treat it as a prototype setter).
    await writeFile(join(root, ".dsh", "run.json"),
      '{"runs":[{"name":"pollute","command":"pwd","env":{"__proto__":"x"}}]}\n', "utf8");
    await assert.rejects(loadRuns(root), (error) => error instanceof ConfigError && error.code === "config-entry-env");

    await writeFile(join(root, ".dsh", "run.json"), JSON.stringify({
      runs: [{ name: "cache", command: "pwd", writableRoots: ["~/.m2"] }]
    }), "utf8");
    const allowed = await loadRuns(root);
    assert.equal(allowed.runs.length, 1);
    assert.equal(allowed.runs[0].writableRoots[0], join(homedir(), ".m2"));
    assert.equal(allowed.runs[0].cwd, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery drops package and module names that would break a shell command", async () => {
  const root = await workspace();
  try {
    await put(root, "package.json", JSON.stringify({
      name: "mono",
      workspaces: ["apps/*"],
      packageManager: "pnpm@10.10.0",
      scripts: { "dev:ok": "pnpm -F ok-web run dev" }
    }));
    await put(root, "apps/ok-web/package.json", JSON.stringify({
      name: "ok-web",
      scripts: { dev: "vite" }
    }));
    await put(root, "apps/evil/package.json", JSON.stringify({
      name: "evil;rm -rf /",
      scripts: { dev: "vite" }
    }));
    await put(root, "pom.xml", "<project><modules><module>good-mod</module><module>bad;id</module></modules></project>");
    await put(root, "good-mod/pom.xml", "<project/>");
    await put(root, "good-mod/src/main/java/com/example/GoodApp.java",
      "package com.example;\n@SpringBootApplication\npublic class GoodApp {}\n");
    await put(root, "bad;id/pom.xml", "<project/>");
    await put(root, "bad;id/src/main/java/com/example/BadApp.java",
      "package com.example;\n@SpringBootApplication\npublic class BadApp {}\n");

    const document = await resolveRuns(root, true);
    const commands = document.runs.map((run) => run.command);
    assert.equal(document.runs.some((run) => run.id === "script:dev:ok" || run.command === "pnpm run dev:ok"), true);
    assert.equal(commands.some((command) => command.includes("evil") || command.includes(";") || command.includes("rm -rf")), false);
    assert.equal(commands.some((command) => command.includes("-pl good-mod") || command === "mvn spring-boot:run"), true);
    assert.equal(commands.some((command) => command.includes("bad;id") || command.includes(";id")), false);
    assert.equal(document.runs.some((run) => run.name === "BadApp"), false);
    assert.equal(document.runs.some((run) => run.name === "GoodApp"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
