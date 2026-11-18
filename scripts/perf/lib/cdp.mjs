/**
 * Headless Edge/Chrome + CDP, no npm dependencies (Node built-in WebSocket).
 *
 * Connects to an already-running dsh web. Never starts or restarts that server.
 * Uses a fresh --user-data-dir under /tmp and kills only processes that include
 * that profile path. Does not touch the user's everyday browser.
 */

import { existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";

const PROFILE_PREFIX = "dsh-idea-perf-edge-";
const SEND_TIMEOUT_MS = 60000;

export { delay };

export function redactUrl(text) {
  return String(text ?? "").replace(/([?&]token=)[^&]+/gi, "$1<redacted>");
}

export function redactDeep(value, keyHint = "") {
  if (typeof value === "string") {
    if (/token/i.test(keyHint) && value.length > 8 && !/redacted/i.test(value) && !value.includes(" ")) {
      return "<redacted>";
    }
    return redactUrl(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, key);
    return out;
  }
  return value;
}

export function readToken(tokenLog) {
  if (!existsSync(tokenLog)) {
    throw new Error(
      `Token log not found: ${tokenLog}. Is dsh web running? This harness will not start or restart it.`
    );
  }
  const text = readFileSync(tokenLog, "utf8");
  const matches = [...text.matchAll(/[?&]token=([^\s"'&]+)/g)];
  if (matches.length === 0) {
    throw new Error(
      `No token found in ${tokenLog}. Is dsh web running and has it written a login URL to the log? This harness will not start or restart dsh web.`
    );
  }
  return matches[matches.length - 1][1];
}

export async function checkServer(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    return { ok: true, status: res.status };
  } catch (err) {
    throw new Error(
      `dsh web is not reachable at ${url} (${err && err.message ? err.message : err}). Start it first; this harness will not start or restart dsh web.`
    );
  }
}

export function resolveBrowser(candidates) {
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  throw new Error(
    "No browser binary found. Install Microsoft Edge or Google Chrome, or pass --browser <path>."
  );
}

export function dshListenerPid(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return String(execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" })).trim();
  } catch {
    return "";
  }
}

export async function sweepEdge(profile) {
  // Only processes whose command line contains this run's temp profile.
  // Never kill unrelated browsers or another audit's Edge instance.
  if (!profile) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      const out = execSync("ps axo pid=,command=", { encoding: "utf8" });
      for (const line of out.split("\n")) {
        if (!line.includes(profile)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (!Number.isInteger(pid) || pid <= 1) continue;
        try { process.kill(pid, sig); } catch {}
      }
    } catch {}
    await delay(sig === "SIGTERM" ? 300 : 100);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await delay(100);
  }
  throw new Error("DevTools endpoint not ready. Headless Edge/Chrome may have failed to start.");
}

function attachSocket(ws) {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      resolve(ws);
    };
    const onError = (event) => {
      ws.removeEventListener("open", onOpen);
      reject(new Error(event && event.message ? event.message : "WebSocket error"));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this._onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners) {
          try { fn(msg); } catch {}
        }
      }
    };
    ws.addEventListener("message", this._onMessage);
  }

  send(method, params = {}, sessionId, timeoutMs = SEND_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try { this.ws.removeEventListener("message", this._onMessage); } catch {}
    try { this.ws.close(); } catch {}
  }
}

export class PageSession {
  constructor(conn, sessionId, proc, profile) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.proc = proc;
    this.profile = profile;
  }

  send(method, params = {}) {
    return this.conn.send(method, params, this.sessionId);
  }

  onEvent(fn) {
    const wrapped = (msg) => {
      if (msg.sessionId && msg.sessionId !== this.sessionId) return;
      fn(msg);
    };
    return this.conn.onEvent(wrapped);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.exception && details.exception.description
        ? details.exception.description
        : details.text;
      throw new Error("evaluate failed: " + text);
    }
    return result.result ? result.result.value : undefined;
  }

  async clickCss(selector, index = 0) {
    const box = await this.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      const el = els[${index}];
      if (!el) return { ok: false, n: els.length };
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { ok: true, n: els.length, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box || box.ok !== true) {
      throw new Error("click miss " + selector + " #" + index + " n=" + (box && box.n));
    }
    const common = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
    return box;
  }

  async close() {
    try { this.conn.close(); } catch {}
    if (this.proc && this.proc.pid) {
      try { process.kill(-this.proc.pid, "SIGTERM"); } catch {}
      await delay(300);
      try { process.kill(-this.proc.pid, "SIGKILL"); } catch {}
    }
    await sweepEdge(this.profile);
  }
}

export async function launchSession(config) {
  const browser = resolveBrowser(config.browserCandidates);
  const profile = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const port = await freePort();
  await mkdir(config.runDir, { recursive: true });
  const logPath = join(config.runDir, "edge.log");
  const logFd = openSync(logPath, "w");
  const proc = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-background-networking",
    "--disable-features=Translate,BackForwardCache",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { detached: true, stdio: ["ignore", logFd, logFd] });
  proc.unref();
  try {
    const version = await waitJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await attachSocket(ws);
    const conn = new CdpConnection(ws);
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new PageSession(conn, sessionId, proc, profile);
    page.devtoolsPort = port;
    page.browserPath = browser;
    page.profile = profile;
    return page;
  } catch (error) {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {}
    await sweepEdge(profile);
    throw error;
  }
}

export async function openApp(page, config, token) {
  // Viewport must be set before navigation. Session-switch numbers are only
  // valid at the configured size (default 1440×900).
  const { width, height } = config.viewport;
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("DOM.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
  let loaded = false;
  const off = page.onEvent((msg) => {
    if (msg.method === "Page.loadEventFired") loaded = true;
  });
  await page.send("Page.navigate", {
    url: `${config.url}/?token=${encodeURIComponent(token)}`
  });
  const start = Date.now();
  while (!loaded && Date.now() - start < 20000) await delay(100);
  off();
  if (!loaded) throw new Error("Timed out waiting for the dsh web page to load.");

  for (let i = 0; i < 50; i++) {
    const n = await page.evaluate(`document.querySelectorAll(".YDXeBa_sessionRow").length`);
    if (n >= 1) break;
    await delay(200);
  }

  const info = await page.evaluate(`({
    sessions: document.querySelectorAll(".YDXeBa_sessionRow").length,
    hrefPath: location.pathname,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight }
  })`);
  if (info.viewport.w !== width || info.viewport.h !== height) {
    throw new Error(
      `Viewport mismatch: requested ${width}x${height}, got ${info.viewport.w}x${info.viewport.h}. Session-switch conclusions would be invalid.`
    );
  }
  if (info.sessions < 1) {
    throw new Error(
      "No existing sessions found after login. This harness never creates sessions; open or keep at least one session in dsh web first."
    );
  }
  return info;
}
