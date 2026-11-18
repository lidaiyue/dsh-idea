import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { classifyFailure } from "./reason.js";
import { DEFAULT_RESTART, delayOf, shouldScheduleRestart } from "./restart.js";

/** Byte budget for one run's retained output; a chatty application keeps its newest bytes. */
const OUTPUT_BYTES = 512 * 1024;
/** How often a started application is checked for its port announcement and readiness. */
const PROBE_MS = 400;
/** Give up sniffing for a port after this long; a silent application is still a running one. */
const PROBE_MS_LIMIT = 180_000;
/** A stop must not block a restart forever on a process that ignores its term. */
const STOP_WAIT_MS = 8000;

/** A directory is a usable JAVA_HOME when it contains a java executable. */
function isJavaHome(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  const home = dir.trim();
  return existsSync(join(home, "bin", "java")) || existsSync(join(home, "bin", "java.exe"));
}

/** macOS ships a toolchain picker; other platforms leave discovery to JAVA_HOME. */
function defaultJavaHomeLookup() {
  if (process.platform !== "darwin") return undefined;
  try {
    const result = spawnSync("/usr/libexec/java_home", [], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0) return undefined;
    const home = String(result.stdout ?? "").trim();
    return isJavaHome(home) ? home : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Environment overlay for one spawn: fill JAVA_HOME when the Host process
 * (and the entry) did not already name a usable JDK.
 *
 * Homebrew's `mvn` wrapper hardcodes OpenJDK when JAVA_HOME is unset, which
 * is the usual case for a `dsh web` process started outside a login shell.
 * The entry's own `JAVA_HOME` still wins; a Host that already has one is
 * left alone so inherited env is enough.
 *
 * @param entryEnv - extra variables from the configuration, if any.
 * @param processEnv - the Host process environment; defaults to `process.env`.
 * @param lookup - returns a JDK home when the environment has none.
 * @returns the overlay to pass as `env`, or undefined when nothing is added.
 */
export function spawnEnvOf(entryEnv, processEnv = process.env, lookup = defaultJavaHomeLookup) {
  const extra = entryEnv === undefined ? {} : { ...entryEnv };
  const named = extra.JAVA_HOME;
  if (!isJavaHome(named) && !isJavaHome(processEnv.JAVA_HOME)) {
    const home = lookup();
    if (isJavaHome(home)) extra.JAVA_HOME = home;
  }
  if (isJavaHome(extra.JAVA_HOME)) {
    const bin = join(extra.JAVA_HOME, "bin");
    const pathKey = extra.Path !== undefined || (processEnv.PATH === undefined && processEnv.Path !== undefined) ? "Path" : "PATH";
    const current = extra[pathKey] ?? processEnv[pathKey] ?? processEnv.PATH ?? processEnv.Path ?? "";
    const parts = current === "" ? [] : current.split(delimiter);
    if (!parts.includes(bin)) extra[pathKey] = current === "" ? bin : `${bin}${delimiter}${current}`;
  }
  return Object.keys(extra).length === 0 ? undefined : extra;
}

/** A run that was started and has not settled. */
export const RUNNING = "running";
/** A run whose process exited on its own. */
export const EXITED = "exited";
/** A run a caller stopped. */
export const STOPPED = "stopped";
/** A run whose process could not be started or was killed by the provider. */
export const FAILED = "failed";
/** A configuration this process never started. */
export const IDLE = "idle";

/**
 * The announced listening port of a web application, or undefined.
 *
 * The first group of patterns covers what Spring Boot, Vite, Next, and plain
 * Express say; the last one is the general "this URL is what I serve" shape.
 */
const PORT_PATTERNS = [
  /started on port(?:\(s\))?:?\s*(\d{2,5})/i,
  /Local:\s+https?:\/\/[^\s/:]+:(\d{2,5})/,
  /listening on (?:port\s+|https?:\/\/[^\s/:]+:)?(\d{2,5})/i,
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/
];

function portIn(text) {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

/** A port named on the command line or in the environment, before anything runs. */
function portOf(entry) {
  if (entry.port !== undefined) return entry.port;
  const fromCommand = /--server\.port[= ](\d{2,5})/.exec(entry.command);
  if (fromCommand !== null) return Number(fromCommand[1]);
  const fromEnv = entry.env === undefined ? undefined : entry.env.PORT;
  return /^\d{2,5}$/.test(String(fromEnv ?? "")) ? Number(fromEnv) : undefined;
}

/** Whether something is accepting connections on this loopback port right now. */
function probe(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** `ready` once the announced port answers; `starting` while a port is known but silent. */
function phaseOf(instance) {
  if (instance.ready === true) return "ready";
  return instance.port === undefined ? "running" : "starting";
}

/** Recent retained output, used only to classify a failure. */
function outputOf(instance) {
  try {
    const stdout = instance.exec.observed.stdout.readFrom(0);
    const stderr = instance.exec.observed.stderr.readFrom(0);
    const text = (stdout && stdout.text ? stdout.text : "")
      + (stderr && stderr.text ? "\n" + stderr.text : "");
    return text.length > 32 * 1024 ? text.slice(text.length - 32 * 1024) : text;
  } catch {
    return "";
  }
}

function reasonOf(instance) {
  return classifyFailure({
    error: instance.error,
    exitCode: instance.exitCode,
    output: outputOf(instance)
  });
}

function policyOf(options) {
  const restart = options !== undefined && options !== null && options.restart !== undefined ? options.restart : {};
  const delaysMs = Array.isArray(restart.delaysMs) && restart.delaysMs.length > 0
    ? restart.delaysMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
    : DEFAULT_RESTART.delaysMs;
  return {
    delaysMs: delaysMs.length > 0 ? delaysMs : DEFAULT_RESTART.delaysMs,
    limit: Number.isInteger(restart.limit) && restart.limit > 0 ? restart.limit : DEFAULT_RESTART.limit,
    healthyMs: Number.isInteger(restart.healthyMs) && restart.healthyMs >= 0 ? restart.healthyMs : DEFAULT_RESTART.healthyMs
  };
}

/** Unref a timer so a pending restart or probe cannot keep a test (or the Host) alive. */
function unref(timer) {
  if (timer !== undefined && typeof timer.unref === "function") timer.unref();
  return timer;
}

/** The `autoRestart` flag as the page and the file-facing save path should see it. */
function flagOf(entry) {
  return entry !== undefined && entry.autoRestart === true;
}

/**
 * The model- and page-facing projection of one instance.
 *
 * Absent facts are absent keys, never `undefined` values: a tool result is
 * validated as lossless JSON, and an `undefined` property is not.
 */
function view(instance, policy) {
  const out = {
    id: instance.entry.id,
    name: instance.entry.name,
    command: instance.entry.command,
    cwd: instance.entry.cwd,
    sandbox: instance.entry.sandbox,
    state: instance.state,
    exitCode: instance.exitCode,
    startedAt: instance.startedAt,
    autoRestart: flagOf(instance.entry)
  };
  if (instance.entry.source !== undefined) out.source = instance.entry.source;
  if (instance.entry.env !== undefined) out.env = instance.entry.env;
  if (instance.entry.writableRoots !== undefined) out.writableRoots = instance.entry.writableRoots;
  if (instance.state === RUNNING) out.phase = phaseOf(instance);
  if (instance.port !== undefined) out.port = instance.port;
  if (instance.endedAt !== undefined) out.endedAt = instance.endedAt;
  if (instance.error !== undefined) out.error = instance.error;
  if (instance.state === FAILED || instance.state === EXITED) {
    const reason = reasonOf(instance);
    if (reason !== undefined) out.reason = reason;
  }
  if (instance.restartStatus !== undefined) {
    out.restartStatus = instance.restartStatus;
    if (instance.restartAttempt > 0) out.restartAttempt = instance.restartAttempt;
    if (policy !== undefined) out.restartLimit = policy.limit;
  }
  return out;
}

/** The declared-but-not-started face of one configuration. */
function idle(entry) {
  const out = {
    id: entry.id,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    sandbox: entry.sandbox,
    state: IDLE,
    exitCode: null,
    autoRestart: flagOf(entry)
  };
  if (entry.source !== undefined) out.source = entry.source;
  if (entry.env !== undefined) out.env = entry.env;
  if (entry.writableRoots !== undefined) out.writableRoots = entry.writableRoots;
  if (entry.port !== undefined) out.port = entry.port;
  return out;
}

/** The text one retained stream still owes a reader at `from`. */
function readOf(reader, from) {
  const read = reader.readFrom(from);
  return { text: read.text, next: read.nextOffset, lossy: read.lossy === true };
}

/**
 * The processes this plugin started, keyed by workspace root and configuration
 * id.
 *
 * Membership is per plugin process, not per session: one application is one
 * process no matter how many sessions or tabs look at it. Output is read by
 * absolute byte offset, so two viewers never consume each other's bytes, and a
 * reader that fell behind only learns that it lost bytes rather than getting an
 * error.
 */
export class Runner {
  /**
   * @param ctx - plugin context carrying the `shell` execution service.
   * @param options.restart - optional backoff, retry limit, and healthy window;
   *   tests pass short values so they stay deterministic.
   */
  constructor(ctx, options) {
    this.ctx = ctx;
    this.live = new Map();
    this.starting = new Map();
    this.orphans = new Set();
    this.policy = policyOf(options);
    const wait = options !== undefined && options !== null ? options.stopWaitMs : undefined;
    this.stopWaitMs = Number.isInteger(wait) && wait >= 0 ? wait : STOP_WAIT_MS;
  }

  /** The shell service, or a refusal naming what the profile is missing. */
  shell() {
    const shell = this.ctx.get("shell");
    if (shell === undefined || shell === null || typeof shell.execute !== "function" || typeof shell.resolve !== "function") {
      throw new Error("shell-unavailable: this profile mounts no shell execution service");
    }
    return shell;
  }

  key(root, id) {
    return `${root}\u0000${id}`;
  }

  project(instance) {
    return view(instance, this.policy);
  }

  /** Drop one instance's probe timer, if it still has one. */
  clearTimer(instance) {
    if (instance.timer === undefined) return;
    clearInterval(instance.timer);
    instance.timer = undefined;
  }

  /** Drop the timer that would have cleared the retry budget after a healthy stretch. */
  clearHealthy(instance) {
    if (instance === undefined || instance.healthyTimer === undefined) return;
    clearTimeout(instance.healthyTimer);
    instance.healthyTimer = undefined;
  }

  /** Drop a pending delayed auto-restart without changing the retry count. */
  cancelRestart(instance) {
    if (instance === undefined) return;
    instance.restartToken = (instance.restartToken ?? 0) + 1;
    if (instance.restartTimer !== undefined) {
      clearTimeout(instance.restartTimer);
      instance.restartTimer = undefined;
    }
    if (instance.restartStatus === "scheduled" || instance.restartStatus === "restarting") {
      instance.restartStatus = undefined;
    }
  }

  /** The retry budget starts over once this process has been up long enough, or is ready. */
  markHealthy(instance) {
    if (instance.state !== RUNNING) return;
    instance.restartAttempt = 0;
    instance.failedRetries = 0;
    instance.restartStatus = undefined;
    this.clearHealthy(instance);
  }

  /** After a successful start, forget earlier crashes once the process stays up. */
  armHealthy(instance) {
    this.clearHealthy(instance);
    const ms = this.policy.healthyMs;
    if (ms <= 0 || instance.state !== RUNNING) {
      if (instance.state === RUNNING) this.markHealthy(instance);
      return;
    }
    instance.healthyTimer = unref(setTimeout(() => {
      instance.healthyTimer = undefined;
      this.markHealthy(instance);
    }, ms));
  }

  /**
   * Watch one running application until it settles.
   *
   * Two jobs in one timer: learn the port it announces on stdout, and notice
   * once that port accepts a connection. Both are best-effort — an application
   * that never prints a port stays `running`, not `starting`, because guessing
   * readiness would be worse than admitting it is unknown.
   *
   * The reader has its own cursor, so sniffing never consumes a viewer's bytes.
   * Reaching `ready` also clears the auto-restart budget, so a later crash can
   * be retried again.
   */
  watch(instance) {
    const started = Date.now();
    let cursor = 0;
    let probing = false;
    const tick = async () => {
      if (instance.state !== RUNNING || Date.now() - started > PROBE_MS_LIMIT) {
        this.clearTimer(instance);
        return;
      }
      if (instance.port === undefined) {
        const read = instance.exec.observed.stdout.readFrom(cursor);
        cursor = read.nextOffset;
        const found = portIn(read.text);
        if (found !== undefined) instance.port = found;
      }
      if (instance.port === undefined || instance.ready === true || probing) return;
      probing = true;
      try {
        if (await probe(instance.port)) {
          instance.ready = true;
          this.markHealthy(instance);
        }
      } finally {
        probing = false;
      }
    };
    instance.timer = unref(setInterval(() => { void tick(); }, PROBE_MS));
    void tick();
  }

  /**
   * Adopt the latest configuration for a live instance.
   *
   * The next start uses these fields. Turning `autoRestart` off cancels a
   * pending delayed start; a process that is already running is left alone.
   */
  adoptEntry(instance, entry) {
    const was = flagOf(instance.entry);
    instance.entry = entry;
    if (was && !flagOf(entry)) {
      this.cancelRestart(instance);
      if (instance.restartStatus === "stopped") instance.restartStatus = undefined;
    }
  }

  /**
   * Schedule another start for a run that settled while auto-restart is on.
   *
   * The decision lives in `shouldScheduleRestart`: a user stop, an
   * unrecoverable classified failure, or a spent retry budget all refuse.
   * When a crash streak has already retried and will not retry again, the
   * instance is marked `restartStatus: "stopped"` so the panel can say so.
   */
  maybeSchedule(instance) {
    if (instance.userStopped === true) return;
    const attempt = instance.restartAttempt ?? 0;
    const ok = shouldScheduleRestart({
      autoRestart: flagOf(instance.entry),
      state: instance.state,
      reason: reasonOf(instance),
      attempt,
      limit: this.policy.limit,
      failedRetries: instance.failedRetries ?? 0
    });
    if (!ok) {
      if (flagOf(instance.entry) && attempt > 0 && (instance.state === EXITED || instance.state === FAILED)) {
        instance.restartStatus = "stopped";
      }
      return;
    }
    instance.restartAttempt = attempt + 1;
    if (instance.state === FAILED) instance.failedRetries = (instance.failedRetries ?? 0) + 1;
    const token = (instance.restartToken ?? 0) + 1;
    instance.restartToken = token;
    instance.restartStatus = "scheduled";
    instance.restartTimer = unref(setTimeout(() => {
      instance.restartTimer = undefined;
      if (instance.restartToken !== token) return;
      void this.performAutoRestart(instance, token);
    }, delayOf(this.policy, instance.restartAttempt)));
  }

  /**
   * Start the same configuration again after a crash.
   *
   * Goes through `start` so the mutex, sandbox policy, and process key stay
   * identical to a manual start. A late timer whose token was cancelled is a
   * no-op; a start that throws is treated as a failed attempt and may be
   * rescheduled under the same policy.
   */
  async performAutoRestart(instance, token) {
    if (instance.restartToken !== token || instance.userStopped === true) return;
    if (!flagOf(instance.entry) || instance.state === RUNNING || instance.state === STOPPED) return;
    instance.restartStatus = "restarting";
    try {
      await this.start(instance.root, instance.entry, { auto: true, token });
    } catch (error) {
      const current = this.live.get(this.key(instance.root, instance.entry.id));
      if (current === undefined || current.restartToken !== token || current.state === RUNNING) return;
      current.state = FAILED;
      current.error = error && error.message ? String(error.message) : "failed";
      current.endedAt = Date.now();
      current.ready = false;
      this.clearTimer(current);
      this.clearHealthy(current);
      this.maybeSchedule(current);
    }
  }

  /**
   * Start one configuration, or hand back the instance that is already running.
   *
   * `onExpiry: 'none'` is deliberate: this is a long-running application, and
   * the default deadline would kill it as a timeout. The sandbox policy is
   * scoped to the project root so the application may write its own build and
   * log directories; an entry that needs more (a Maven or Gradle cache under
   * `$HOME`) says so in its own `sandbox` or `writableRoots`.
   *
   * Auto-restart and a manual start share this method and a per-id mutex, so
   * the same root+id never has two processes. A manual start cancels a pending
   * delayed restart and resets the retry budget; an auto start keeps it.
   *
   * @param root - absolute workspace root.
   * @param entry - one resolved configuration.
   * @returns the new instance's projection.
   */
  async start(root, entry, opts) {
    const key = this.key(root, entry.id);
    const existing = this.live.get(key);
    if (existing !== undefined && existing.state === RUNNING) return this.project(existing);
    const inFlight = this.starting.get(key);
    if (inFlight !== undefined) {
      await inFlight;
      const after = this.live.get(key);
      if (after !== undefined && after.state === RUNNING) return this.project(after);
    }
    const pending = this.startNow(root, entry, opts);
    this.starting.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.starting.get(key) === pending) this.starting.delete(key);
    }
  }

  async startNow(root, entry, opts) {
    const key = this.key(root, entry.id);
    const existing = this.live.get(key);
    if (existing !== undefined && existing.state === RUNNING) return this.project(existing);
    const auto = opts !== undefined && opts.auto === true;
    if (existing !== undefined) {
      if (!auto) this.cancelRestart(existing);
      else if (opts.token !== undefined && existing.restartToken !== opts.token) {
        return this.project(existing);
      }
    }
    const shell = this.shell();
    const env = spawnEnvOf(entry.env);
    const spec = shell.resolve({
      command: entry.command,
      workdir: entry.cwd,
      onExpiry: "none",
      stdoutMaxBytes: OUTPUT_BYTES,
      ...(env === undefined ? {} : { env }),
      sandboxPolicy: {
        mode: entry.sandbox,
        workspaceRoot: root,
        ...(entry.writableRoots === undefined ? {} : { additionalWritableRoots: entry.writableRoots })
      }
    });
    const exec = await shell.execute(spec);
    const previous = this.live.get(key);
    if (previous !== undefined && previous.state === RUNNING) {
      // A second start raced through execute; keep the process already recorded
      // and drop this one rather than run two for the same id.
      try { exec.kill(); } catch {}
      return this.project(previous);
    }
    const instance = {
      root,
      entry,
      exec,
      state: RUNNING,
      ready: false,
      port: portOf(entry),
      startedAt: Date.now(),
      exitCode: null,
      endedAt: undefined,
      error: undefined,
      timer: undefined,
      userStopped: false,
      restartAttempt: auto && previous !== undefined ? (previous.restartAttempt ?? 0) : 0,
      failedRetries: auto && previous !== undefined ? (previous.failedRetries ?? 0) : 0,
      restartStatus: auto ? "restarting" : undefined,
      restartToken: previous !== undefined ? previous.restartToken : 0,
      restartTimer: undefined,
      healthyTimer: undefined
    };
    if (previous !== undefined) {
      this.clearTimer(previous);
      this.clearHealthy(previous);
      if (previous.restartTimer !== undefined) {
        clearTimeout(previous.restartTimer);
        previous.restartTimer = undefined;
      }
    }
    this.live.set(key, instance);
    this.watch(instance);
    this.armHealthy(instance);
    // `done` settles at process close and never rejects; the rejection branch
    // covers a provider that reports a spawn failure through the read path.
    exec.done.then(
      () => {
        if (this.live.get(key) !== instance) return;
        instance.state = instance.userStopped === true || exec.status === "killed" ? STOPPED : EXITED;
        instance.exitCode = exec.exitCode;
        instance.endedAt = Date.now();
        instance.ready = false;
        this.clearTimer(instance);
        this.clearHealthy(instance);
        this.maybeSchedule(instance);
      },
      (error) => {
        if (this.live.get(key) !== instance) return;
        instance.state = FAILED;
        instance.error = error && error.message ? String(error.message) : "failed";
        instance.endedAt = Date.now();
        instance.ready = false;
        this.clearTimer(instance);
        this.clearHealthy(instance);
        this.maybeSchedule(instance);
      }
    );
    if (auto) instance.restartStatus = undefined;
    return this.project(instance);
  }

  /** Ask one running instance to stop; the poll observes the settled state. */
  stop(root, id) {
    const instance = this.live.get(this.key(root, id));
    if (instance === undefined) throw new Error("not-started");
    instance.userStopped = true;
    this.cancelRestart(instance);
    if (instance.restartStatus === "stopped") instance.restartStatus = undefined;
    if (instance.state === RUNNING) instance.exec.kill();
    else if (instance.state === EXITED || instance.state === FAILED) instance.state = STOPPED;
    return this.project(instance);
  }

  /**
   * Stop one instance and start it again.
   *
   * The wait for the old process is bounded: a restart the user asked for must
   * not hang on an application that ignores its termination signal, and a port
   * still held by the old process produces a visible bind error in the log
   * rather than a silent no-op. A manual restart cancels a pending auto-restart
   * and resets the retry budget.
   */
  async restart(root, entry) {
    const key = this.key(root, entry.id);
    const instance = this.live.get(key);
    if (instance !== undefined) {
      instance.userStopped = true;
      this.cancelRestart(instance);
      if (instance.state === RUNNING) {
        instance.exec.kill();
        await Promise.race([
          instance.exec.done,
          new Promise((resolve) => { unref(setTimeout(resolve, this.stopWaitMs)); })
        ]);
      }
      // The wait is bounded on purpose. A process that ignored the signal is
      // no longer in `live`, so without this handle `dispose` would never see
      // it again and the port would stay taken by something the plugin lost.
      if (instance.state === RUNNING && instance.exec !== undefined) {
        this.orphans.add(instance.exec);
        const drop = () => this.orphans.delete(instance.exec);
        instance.exec.done.then(drop, drop);
        try { instance.exec.kill(); } catch {}
      }
      this.live.delete(key);
    }
    return this.start(root, entry);
  }

  /**
   * The output a viewer still owes at its own offsets, plus the settled state.
   *
   * Returns `null` for a configuration this process never started, so a page
   * can tell "no process" from "a process with no output yet". `startedAt` is
   * included so a viewer can tell a new process from the one it was already
   * reading, and reset its offsets when an auto-restart replaces the stream.
   */
  tail(root, id, from) {
    const instance = this.live.get(this.key(root, id));
    if (instance === undefined) return null;
    const out = {
      state: instance.state,
      exitCode: instance.exitCode,
      startedAt: instance.startedAt,
      stdout: readOf(instance.exec.observed.stdout, from.stdout),
      stderr: readOf(instance.exec.observed.stderr, from.stderr),
      autoRestart: flagOf(instance.entry)
    };
    if (instance.state === RUNNING) out.phase = phaseOf(instance);
    if (instance.port !== undefined) out.port = instance.port;
    if (instance.restartStatus !== undefined) {
      out.restartStatus = instance.restartStatus;
      if (instance.restartAttempt > 0) out.restartAttempt = instance.restartAttempt;
      out.restartLimit = this.policy.limit;
    }
    if (instance.state === FAILED || instance.state === EXITED) {
      const reason = reasonOf(instance);
      if (reason !== undefined) out.reason = reason;
    }
    if (instance.error !== undefined) out.error = instance.error;
    return out;
  }

  /** Every configuration merged with its live instance, in declaration order. */
  list(root, entries) {
    return entries.map((entry) => {
      const instance = this.live.get(this.key(root, entry.id));
      if (instance === undefined) return idle(entry);
      this.adoptEntry(instance, entry);
      return this.project(instance);
    });
  }

  /** Terminate everything this plugin started; called when the plugin unloads. */
  dispose() {
    for (const instance of this.live.values()) {
      this.cancelRestart(instance);
      this.clearTimer(instance);
      this.clearHealthy(instance);
      if (instance.state !== RUNNING) continue;
      try { instance.exec.kill(); } catch {}
    }
    for (const exec of this.orphans) {
      try { exec.kill(); } catch {}
    }
    this.orphans.clear();
    this.live.clear();
    this.starting.clear();
  }
}
