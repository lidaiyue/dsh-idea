export const CONNECT_MS = 15000;
export const QUERY_MS = 30000;

// How long a *handle* (the pool wrapper) is kept after its last use.
//
// Not a socket lifetime, and deliberately longer than one: each engine's pool
// evicts its own idle TCP connections on its shorter `idleTimeoutMillis`
// (60 s for pg), and reopens transparently on the next query. So a handle that
// outlives its sockets costs one small JS object, not a parked connection —
// and keeping it avoids tearing down and rebuilding the pool (and, for Oracle,
// re-running the Thick-mode init and ALTER SESSION) between two queries a user
// makes a minute apart.
const IDLE_TTL_MS = 5 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;

const live = new Map();
const liveUsage = new Map();

export function touchLive(key) {
  liveUsage.set(key, Date.now());
}

export function markLive(key, handle) {
  for (const method of ["query", "exec", "transact"]) {
    const original = handle[method];
    if (typeof original !== "function") continue;
    handle[method] = function (...args) {
      touchLive(key);
      return original.apply(handle, args);
    };
  }
  touchLive(key);
  return handle;
}

export function liveKey(conn, extra) {
  return conn.id + "::" + conn.type + "::" + String(extra || "");
}

export function peekLive(key) {
  return live.get(key);
}

// Register a freshly built handle under `key`. Two concurrent first connects
// can both miss the `peekLive` in their engine's `handle()` — the pool build is
// async — and would otherwise silently park two pools behind one key, the loser
// never closed. The loser is closed here and the winner (whoever registered
// first) is handed to both callers, the same resolution Oracle applies locally
// after its connect-time schema round trip.
export async function rememberLive(key, handle, wrap = true) {
  const existing = live.get(key);
  if (existing) {
    try { await handle.close(); } catch {}
    touchLive(key);
    return existing;
  }
  if (wrap) {
    live.set(key, markLive(key, handle));
    return live.get(key);
  }
  touchLive(key);
  live.set(key, handle);
  return handle;
}

async function reapIdleLive() {
  const now = Date.now();
  let closed = 0;
  for (const [key, handle] of [...live]) {
    const last = liveUsage.get(key);
    if (typeof last !== "number") {
      liveUsage.set(key, now);
      continue;
    }
    if (now - last < IDLE_TTL_MS) continue;
    live.delete(key);
    liveUsage.delete(key);
    closed += 1;
    try { await handle.close(); } catch {}
  }
  return closed;
}

export function startIdleReaper() {
  const timer = setInterval(() => { reapIdleLive().catch(() => {}); }, IDLE_SWEEP_MS);
  timer.unref?.();
  return timer;
}

export async function dropLive(connId) {
  for (const [key, handle] of live) {
    if (!key.startsWith(connId + "::")) continue;
    live.delete(key);
    liveUsage.delete(key);
    try { await handle.close(); } catch {}
  }
}

export async function closeAllLive() {
  for (const key of [...live.keys()]) {
    const handle = live.get(key);
    live.delete(key);
    liveUsage.delete(key);
    try { Promise.resolve(handle.close()).catch(() => {}); } catch {}
  }
}

// Driver errors carry the connection string more often than not: pg prints the
// DSN on a refused connection, Oracle prints the descriptor, and every driver
// echoes `password=` in an auth failure. All three land in the browser as-is, so
// the userinfo of any URL and any `password: value` pair is stripped here.
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const SECRET_PAIR_RE = /\b(password|passwd|pwd|auth\s*token|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi;

export function safeMessage(error) {
  const text = error && error.message ? String(error.message) : String(error);
  return text
    .replace(USERINFO_RE, "$1[redacted]@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(SECRET_PAIR_RE, "$1=[redacted]")
    .slice(0, 300);
}

// TLS options for a connection whose "SSL" box is ticked.
//
// Verification is ON by default: the certificate chain is checked against the
// system trust store, so an active attacker on the network path cannot present
// its own certificate and read or alter production traffic. The plugin used to
// pass `rejectUnauthorized: false` unconditionally, which kept the bytes
// encrypted but accepted *any* certificate — including an expired, mismatched or
// attacker-issued one — while the UI called that "SSL".
//
// A self-signed certificate is a legitimate setup for an internal server, so it
// is still reachable, but only through an explicit per-connection opt-in that
// the connection dialog names for what it is.
export function tlsOptions(conn) {
  return conn && conn.sslAllowUntrusted === true
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };
}

export async function loadModule(spec, label) {
  try {
    const mod = await import(spec);
    return mod.default || mod;
  } catch (error) {
    throw new Error("缺少 " + label + " 驱动（" + spec + "）：" + safeMessage(error));
  }
}
