import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { schemaNamesOf } from "./sql.js";
import { startIdleReaper, dropLive, closeAllLive, safeMessage } from "./live.js";
import {
  listSchemas,
  childrenOf,
  describeTable,
  previewTable,
  updateRows,
  readCell,
  runQuery,
  inspectKey,
  deleteKey,
  testConn,
  exportSql,
  importSql,
} from "./db.js";

const name = "dsh-database";
// Legacy prefix kept so an already-installed dsh-database client, bookmark,
// or fetch to `/plugins/dsh-database` still reaches this code after the merge
// into dsh-idea. The idea-owned prefix is registered alongside it.
const PREFIX = "/plugins/dsh-database";
const PREFIX_NEW = "/plugins/dsh-idea/database";
const PREFIXES = [PREFIX_NEW, PREFIX];
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "vendor");
const VENDOR_ROUTE = "/vendor/codemirror.js";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TYPES = new Set(["postgres", "mysql", "redis", "oracle"]);
const MAX_BODY = 16 * 1024 * 1024;
// The three media types a browser can send cross-site without a CORS preflight.
// A JSON body is the only thing these routes are meant to read.
const SIMPLE_MEDIA_TYPES = new Set(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]);
// The credential scope every connection password is recorded under. It is this
// plugin's registered name, which is what tells a later reader of
// `~/.dsh/.credentials.yaml` whose format a record payload is written in.
const CRED_SCOPE = "dsh-database";
// Console view bounds: the SQL in a console is user-typed text, so a save that
// carries a huge script is capped rather than trusted. Counts and per-field
// caps together bound one view to a few megabytes, well under MAX_BODY.
const CONSOLE_MAX = 50;
const CONSOLE_CLOSED_MAX = 30;
const CONSOLE_TEXT_MAX = 200;
const CONSOLE_SQL_MAX = 100 * 1024;

function hostnameOfHost(host) {
  const raw = String(host || "").trim().toLowerCase();
  if (raw === "") return "";
  // A `Host` header is a bare authority: `name`, `name:port`, `[v6]` or
  // `[v6]:port`. Anything carrying userinfo or a path is not one, and is
  // rejected rather than parsed leniently.
  if (raw.includes("@") || raw.includes("/") || raw.includes("?") || raw.includes("#")) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return "";
    const rest = raw.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return "";
    return raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return raw;
  if (!/^\d+$/.test(raw.slice(colon + 1))) return "";
  return raw.slice(0, colon);
}

// The port half of the same strict authority parse. `""` means "no port"
// (the caller has already rejected malformed hosts via hostnameOfHost).
function portOfHost(host) {
  const raw = String(host || "").trim().toLowerCase();
  if (raw === "" || raw.includes("@") || raw.includes("/") || raw.includes("?") || raw.includes("#")) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return "";
    const rest = raw.slice(end + 1);
    return /^:\d+$/.test(rest) ? rest.slice(1) : "";
  }
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return "";
  return /^\d+$/.test(raw.slice(colon + 1)) ? raw.slice(colon + 1) : "";
}

function hostIsLoopback(host) {
  const name = hostnameOfHost(host);
  return name !== "" && LOOPBACK_HOSTS.has(name);
}

// What a browser puts in `Origin`, and nothing else. `null` is the opaque
// origin a sandboxed iframe or `data:` URL sends — it is a *value*, not a
// missing header, and a page that can produce it is not this page.
//
// The host must also equal the `Host` header's host, not merely be *some*
// loopback spelling. Without that, an Origin naming `[::1]` satisfied a
// `127.0.0.1` Host purely because both are loopback.
//
// This does not (and cannot) reject non-canonical IPv4 spellings such as
// `http://127.1` or `http://2130706433`: `new URL` canonicalizes them to
// `127.0.0.1` before this code sees them. That is not a bypass, because a
// browser serializes `Origin` from the already-parsed origin — a page served
// from `http://2130706433/` transmits `Origin: http://127.0.0.1` and can never
// emit the non-canonical string. `Host` keeps the strict literal compare.
function originIsLoopback(origin, hostHeader) {
  const raw = typeof origin === "string" ? origin.trim() : "";
  if (raw === "") return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  // `file://` and other non-http schemes parse with an empty hostname and would
  // otherwise be treated as a loopback origin.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const name = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(name)) return false;
  const hostName = hostnameOfHost(hostHeader);
  if (hostName === "") return false;
  // `parsed.hostname` for IPv6 carries brackets (`[::1]`), matching the form
  // `hostnameOfHost` keeps.
  if (hostName !== name) return false;
  // The port must match too: loopback ports are *not* same-origin, and a page
  // served from 127.0.0.1:9999 reaches this server with an Origin naming its
  // own port while `Sec-Fetch-Site` says `same-site` (loopback is one site).
  // An explicit port equal to the scheme default is treated as absent, which
  // is how `new URL` already normalizes the Origin side.
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  const originPort = parsed.port || defaultPort;
  const hostPort = portOfHost(hostHeader) || defaultPort;
  return originPort === hostPort;
}

// The plugin executes SQL with the user's stored production credentials, so
// "the socket is local" is not sufficient: any page the user visits can reach
// 127.0.0.1, and a DNS-rebinding hostname reaches it *as* loopback while
// carrying the attacker's name in `Host`. A request is trusted only when it was
// issued by the DSH page itself — which means a loopback Host, a loopback
// Origin naming that same host, and no cross-site label. All three are
// required; the `Origin` presence check is what closes the `Origin: null`
// bypass, and the `Host` compare is what closes DNS rebinding.
function loopbackRequest(req) {
  const headers = req.headers || {};
  if (!hostIsLoopback(headers.host)) return false;
  if (!originIsLoopback(headers.origin, headers.host)) return false;
  // Browsers label cross-site requests; a same-origin fetch says `same-origin`.
  // A page cannot set `Sec-Fetch-*` (they are forbidden header names), so an
  // explicit cross-site verdict is authoritative. The value is a structured
  // token list, so it is split rather than compared whole: `"cross-site "` and
  // `"cross-site, cross-site"` must not slip past a naive equality test.
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  if (site.split(",").map((part) => part.trim()).includes("cross-site")) return false;
  return true;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (chunk) => {
      n += chunk.length;
      if (n > limit) {
        reject(new Error("too-large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJson(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return null;
  }
  if (!loopbackRequest(req)) {
    json(res, 403, { error: "request-not-trusted" });
    return null;
  }
  // A cross-site `fetch` with a string body needs no preflight and arrives as one
  // of the three CORS "simple" media types — `text/plain` being the usual one.
  // Refusing exactly those keeps such a request out of the body parser without
  // breaking a non-browser caller (curl, a test) that sends no header at all.
  const mediaType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (SIMPLE_MEDIA_TYPES.has(mediaType)) {
    json(res, 415, { error: "unsupported-media-type" });
    return null;
  }
  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    json(res, 413, { error: "too-large" });
    return null;
  }
  try {
    const data = JSON.parse(raw || "{}");
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("bad");
    return data;
  } catch {
    json(res, 400, { error: "invalid-json" });
    return null;
  }
}

// The credential service the base composition mounts. It is optional on
// purpose: a composition without one still serves connections, so a missing
// service degrades to "no stored passwords" instead of failing every route.
function credentialsOf(ctx) {
  try {
    return ctx.get("credentials");
  } catch {
    return undefined;
  }
}

// Address one connection's password inside the credential store. The plugin's
// own uuid is safe as the id segment (lowercase hex plus dashes always matches
// the record grammar), so connections can be addressed without a mapping table.
function passwordKey(id) {
  return credentialKey(CRED_SCOPE, "conn-" + id);
}

// Look up one connection's password. A record whose `key` names the connection
// id is the current layout; the whole-payload string shape it replaced is still
// read so an unmigrated store keeps connecting.
async function readPassword(credentials, id) {
  if (!credentials || !id) return "";
  const record = await credentials.readRecord(passwordKey(id));
  if (!record) return "";
  if (record.kind === "api-key") {
    if (typeof record.key === "string" && record.key !== "") return record.key;
    const legacy = record.env && record.env[CRED_SCOPE];
    return typeof legacy === "string" ? legacy : "";
  }
  return typeof record.payload === "string" ? record.payload : "";
}

// Whether a value can actually be parked in the credential store. A
// composition that mounts no provider must not lose a password to a rewrite
// that has nowhere to put it.
function canStorePassword(credentials) {
  return !!credentials && typeof credentials.modifyRecord === "function" && typeof credentials.readRecord === "function";
}

async function writePassword(credentials, id, password) {
  if (!canStorePassword(credentials)) return;
  const key = passwordKey(id);
  if (password === "") {
    await credentials.deleteRecord(key);
    return;
  }
  await credentials.modifyRecord(key, async () => ({ kind: "api-key", key: password }));
}

// Strip every plaintext password from a store document, so `password` never
// survives to disk — but only when there is a credential store to hold it.
// Without one the field stays, because dropping it would destroy the secret.
function stripPasswords(list, credentials) {
  if (!canStorePassword(credentials)) return list;
  return list.map((row) => {
    if (typeof row.password !== "string") return row;
    const { password, ...rest } = row;
    return rest;
  });
}

function storePath() {
  return join(homedir(), ".dsh", "database-connections.json");
}

function consolesPath() {
  return join(homedir(), ".dsh", "database-consoles.json");
}

function publicConn(row, credentials) {
  const hasPassword = typeof row.password === "string" && row.password !== "";
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host || "",
    port: row.port || 0,
    user: row.type === "redis" ? "" : (row.user || ""),
    database: row.type === "redis" ? "" : (row.database || ""),
    ssl: row.type === "redis" ? false : row.ssl === true,
    // Whether a TLS connection may skip certificate verification. Off by
    // default: `ssl: true` verifies the chain, and only an explicit opt-in
    // accepts a self-signed or otherwise untrusted certificate. Stored rows
    // predating this field keep verifying, which is the safe reading of "SSL".
    sslAllowUntrusted: row.type === "redis" ? false : row.sslAllowUntrusted === true,
    instantClient: row.type === "oracle" ? (row.instantClient || "") : "",
    // Schema / database names the tree is limited to. An empty list means "no
    // restriction", which is what every pre-existing stored row means. This
    // shapes the sidebar only — see `schemaFilterOf` in sql.js for why it is
    // not an access control.
    schemas: row.type === "redis" ? [] : schemaNamesOf(row),
    // Whether the tree hides the PG internal databases (`postgres`,
    // `template1`, `rdsadmin`). Defaults to true for stored rows that never
    // set the field; a deliberate `false` opt-out is preserved.
    hideBuiltinDatabases: row.type === "postgres" && row.hideBuiltinDatabases !== false,
    hasPassword,
    // Only set when the composition mounts no credential store, which is the
    // only case where the password is still sitting in the row in plaintext.
    // A marker (not the secret) so the UI can label the connection later.
    ...(!canStorePassword(credentials) && hasPassword ? { plaintextPassword: true } : {}),
  };
}

// The parsed connection store.
//
// Read and parsed on each call rather than cached. Measured at ~0.07 ms for a
// twenty-connection file (5 kB), which is far below the noise of the routes
// built on it, and every cache design here has to answer "what if the file
// changed underneath?" — the tests, a hand edit, or another process all write
// it directly. A short-TTL cache was tried and reverted: it made a
// read-modify-write cycle able to read contents older than the previous
// cycle's write, which is the exact corruption `serializeWrite` exists to
// prevent. The per-request win that *did* matter is `loadOne`, which stops a
// request for one connection from decrypting every other connection's password.
async function readStore() {
  try {
    const raw = JSON.parse(await readFile(storePath(), "utf8"));
    const list = Array.isArray(raw && raw.connections) ? raw.connections : [];
    return list.filter((row) => row && typeof row === "object" && typeof row.id === "string" && TYPES.has(row.type));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

// Read the connection store and attach each row's password from the credential
// store. Every caller that talks to a database goes through this, so an engine
// never sees a handle-less connection.
//
// This is the whole-list read: it costs one credential lookup per stored
// connection, so it belongs to `/list` and to the read-modify-write cycle that
// genuinely needs every row. The per-request database routes use `loadOne`
// instead — a query naming one connection has no business reading the other
// nineteen secrets.
async function loadStore(ctx) {
  const list = await readStore();
  const credentials = credentialsOf(ctx);
  return Promise.all(list.map(async (row) => {
    const password = await readPassword(credentials, row.id);
    return password === "" ? row : { ...row, password };
  }));
}

// One connection, with its password. The store file is still parsed whole (it
// is a single JSON document), but only the row that was asked for costs a
// credential-store read.
async function loadOne(ctx, id) {
  if (typeof id !== "string" || id === "") return undefined;
  const row = findConn(await readStore(), id);
  if (!row) return undefined;
  const password = await readPassword(credentialsOf(ctx), row.id);
  return password === "" ? row : { ...row, password };
}

// Serialize the writes to one store file. Two requests can overlap — the
// browser's debounced console save and the `pagehide` beacon both land on
// `/consoles/save` — and two concurrent `writeFile` calls to one path can
// interleave into a corrupt document. A per-path promise chain is enough: only
// the host process writes these files.
const writeChains = new Map();

function serializeWrite(path, work) {
  const previous = writeChains.get(path) || Promise.resolve();
  const next = previous.then(work, work);
  // Keep the chain alive across a rejected write; the caller still sees the
  // rejection through its own `next`.
  writeChains.set(path, next.then(() => undefined, () => undefined));
  return next;
}

// The bare write, without the chain. Only call it from a cycle that already
// holds the chain for this path.
async function writeConnections(list) {
  const dir = join(homedir(), ".dsh");
  await mkdir(dir, { recursive: true });
  await writeFile(storePath(), JSON.stringify({ connections: list }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function saveStore(list) {
  await serializeWrite(storePath(), () => writeConnections(list));
}

// Read the store, mutate it, write it back — all under the file's
// serialization, so two overlapping requests cannot each read the old list and
// lose the other's edit.
//
// The read goes through `loadStore`, so the rows the mutation sees carry their
// passwords — a mutation that inspects a connection needs them. The write is
// always stripped, because the store file must never hold a password; a
// mutation that returns rows it read unchanged would otherwise put every
// remaining secret back on disk (which is what a plain delete used to do).
async function updateStore(ctx, mutate) {
  const credentials = credentialsOf(ctx);
  return serializeWrite(storePath(), async () => {
    const list = await loadStore(ctx);
    const next = await mutate(list);
    await writeConnections(stripPasswords(next, credentials));
    return next;
  });
}

// One-time startup migration: move every plaintext password in the store file
// into the credential store and rewrite the file without them. It rewrites
// whenever any row still carries the key at all, empty strings included, so a
// half-migrated or hand-edited file converges in one pass; once no row has the
// key it costs a single read per boot. A failure is reported and left for the
// next boot rather than taking the plugin down.
async function migratePasswords(ctx) {
  const credentials = credentialsOf(ctx);
  if (!canStorePassword(credentials)) return 0;
  const list = await readStore();
  const plain = list.filter((row) => typeof row.password === "string" && row.password !== "");
  if (plain.length === 0 && !list.some((row) => "password" in row)) return 0;
  for (const row of plain) await writePassword(credentials, row.id, row.password);
  await saveStore(stripPasswords(list, credentials));
  return plain.length;
}

function findConn(list, id) {
  return list.find((row) => row.id === id);
}

// The console view the browser half persists: which tab is showing, the SQL in
// each console, and the closed-console history. It lives here rather than in
// the browser's localStorage because the SQL is as sensitive as the schema it
// queries; `~/.dsh` is 0700 + 0600, a browser profile directory is not.
//
// The browser is free to send anything, so every field is re-derived here
// before it can reach the next page load.
function cleanText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function normalizeConsole(item) {
  if (!item || typeof item !== "object") return null;
  const id = cleanText(item.id, CONSOLE_TEXT_MAX);
  if (id === "") return null;
  return {
    id,
    title: cleanText(item.title, CONSOLE_TEXT_MAX),
    connId: cleanText(item.connId, CONSOLE_TEXT_MAX),
    database: cleanText(item.database, CONSOLE_TEXT_MAX),
    sql: cleanText(item.sql, CONSOLE_SQL_MAX),
  };
}

function normalizeClosed(item) {
  const row = normalizeConsole(item);
  return row === null ? null : { ...row, at: Number(item.at) || 0 };
}

function normalizeConsoleView(body) {
  const seen = new Set();
  const consoles = [];
  for (const raw of Array.isArray(body.consoles) ? body.consoles : []) {
    const item = normalizeConsole(raw);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    consoles.push(item);
    if (consoles.length >= CONSOLE_MAX) break;
  }
  const closed = [];
  for (const raw of Array.isArray(body.closed) ? body.closed : []) {
    const item = normalizeClosed(raw);
    if (item !== null) closed.push(item);
    if (closed.length >= CONSOLE_CLOSED_MAX) break;
  }
  // `page` is stored verbatim: the browser half already validates it against the
  // restored consoles (an unknown id falls back to the explorer).
  return { page: cleanText(body.page, CONSOLE_TEXT_MAX), consoles, closed };
}

// `null` (not an empty view) while nothing has been saved yet — the browser
// needs to tell "this user has no consoles" from "this build just started
// storing them here", because only the latter should adopt localStorage state.
async function readConsoleView() {
  try {
    const raw = JSON.parse(await readFile(consolesPath(), "utf8"));
    return normalizeConsoleView(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveConsoleView(view) {
  const text = JSON.stringify(view, null, 2) + "\n";
  await serializeWrite(consolesPath(), async () => {
    const dir = join(homedir(), ".dsh");
    await mkdir(dir, { recursive: true });
    await writeFile(consolesPath(), text, { encoding: "utf8", mode: 0o600 });
  });
}

function sanitizeDraft(body, previous) {
  const type = String(body.type || (previous && previous.type) || "").trim();
  if (!TYPES.has(type)) throw new Error("unsupported-type");
  const nameValue = String(body.name || "").trim();
  if (nameValue === "") throw new Error("name-required");
  const keepPassword = previous && (body.password === undefined || body.password === null || body.password === "");
  const redis = type === "redis";
  const keepClient = previous && (body.instantClient === undefined || body.instantClient === null);
  return {
    id: previous && previous.id ? previous.id : randomUUID(),
    name: nameValue,
    type,
    host: String(body.host || "").trim(),
    port: Number(body.port) || 0,
    user: redis ? "" : String(body.user || "").trim(),
    password: keepPassword ? previous.password : String(body.password || ""),
    database: redis ? "" : String(body.database || "").trim(),
    ssl: redis ? false : body.ssl === true,
    // Verification is the default, so an ABSENT field must keep whatever the row
    // already had rather than fall back to false: a client that does not know
    // this field (or a re-save that omits it) would otherwise silently re-enable
    // verification and break a working self-signed connection with a TLS error.
    // Turning it ON stays explicit; turning it OFF does not.
    sslAllowUntrusted: redis || body.ssl !== true
      ? false
      : (body.sslAllowUntrusted === undefined && previous
        ? previous.sslAllowUntrusted === true
        : body.sslAllowUntrusted === true),
    instantClient: type === "oracle"
      ? String(keepClient ? (previous.instantClient || "") : (body.instantClient || "")).trim()
      : "",
    // A save that does not carry `schemas` at all keeps whatever the row had, so a
    // client that predates this field (or any other caller) cannot silently wipe a
    // configured filter. Sending an explicit [] is how the dialog clears it.
    schemas: redis
      ? []
      : schemaNamesOf({ schemas: body.schemas === undefined && previous ? previous.schemas : body.schemas }),
    // Default for a fresh PG connection is `true`: hide `postgres`,
    // `template1`, `rdsadmin` from the tree. A stored `false` is the user's
    // deliberate opt-out and is preserved across a re-save that omits the field.
    hideBuiltinDatabases: type === "postgres"
      ? (body.hideBuiltinDatabases === undefined && previous
          ? previous.hideBuiltinDatabases !== false
          : body.hideBuiltinDatabases !== false)
      : false,
  };
}

function prefixOf(pathname) {
  const path = String(pathname || "");
  for (const prefix of PREFIXES) {
    if (path === prefix || path.startsWith(prefix + "/")) return prefix;
  }
  return null;
}

function routeOf(req) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const prefix = prefixOf(url.pathname) || PREFIX;
  return url.pathname.slice(prefix.length).replace(/\/+$/, "") || "/";
}

async function withConn(ctx, body) {
  // Only the named connection is read. Every database route goes through here,
  // so this is what keeps a single query from decrypting the whole connection
  // inventory's passwords on each request.
  const stored = await loadOne(ctx, body.id);
  // "Test connection" sends both the stored id and the current draft. The draft
  // is what the user is looking at, so it wins; the stored row only supplies
  // what the draft legitimately cannot carry (a password the form left blank).
  if (body.draft && typeof body.draft === "object") {
    return sanitizeDraft(body.draft, stored);
  }
  return stored;
}

// Serve the bundled CodeMirror artifact to the browser half.
//
// This is the one GET on the plugin's prefix; everything else is POST-only JSON.
// The file is read once and kept in memory: it is immutable for the life of the
// process (a rebuild restarts the host), and the ETag lets a reload of the page
// revalidate instead of re-downloading ~380 kB.
let vendorCache = null;

function sendVendor(req, res) {
  const etag = vendorCache.etag;
  // `no-cache` (not `no-store`): the browser may keep the bytes, but must
  // revalidate, so a rebuilt artifact is picked up on the next page load.
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": vendorCache.body.length,
    "Cache-Control": "no-cache",
    ETag: etag,
  });
  res.end(vendorCache.body);
}

async function loadVendor() {
  try {
    const body = await readFile(join(VENDOR_DIR, "codemirror.js"));
    vendorCache = { body, etag: '"' + createHash("sha1").update(body).digest("hex").slice(0, 16) + '"' };
    return true;
  } catch {
    // A missing artifact must not break the rest of the plugin: the client half
    // falls back to its plain textarea when this route 404s.
    vendorCache = null;
    return false;
  }
}

// Trust check for the vendor artifact, which the page loads with a classic
// `<script src>`.
//
// That request is `no-cors`, and browsers omit `Origin` on it — verified against
// Safari, which sends only `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode:
// no-cors` and `Sec-Fetch-Dest: script`. So the stateful `loopbackRequest`
// check is the wrong test here: requiring `Origin` 403s the plugin's own page
// and silently drops the console back to a plain textarea.
//
// A page cannot set `Sec-Fetch-*` itself (they are forbidden header names), so
// they are a trustworthy signal for this route: `same-origin` means the loader
// is the DSH page, `none` means a direct navigation. `Origin`, when the browser
// does send it, is still checked.
function vendorRequestTrusted(req) {
  const headers = req.headers || {};
  if (!hostIsLoopback(headers.host)) return false;
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  if (site.split(",").map((part) => part.trim()).includes("cross-site")) return false;
  const origin = headers.origin;
  if (origin !== undefined && String(origin).trim() !== "" && !originIsLoopback(origin, headers.host)) return false;
  // No Sec-Fetch-* at all: a non-browser client (curl, a test harness). Fall
  // back to the full check, which requires a loopback Origin naming this host.
  if (site === "" && headers["sec-fetch-mode"] === undefined && headers["sec-fetch-dest"] === undefined) {
    return originIsLoopback(origin, headers.host);
  }
  return true;
}

async function dispatch(ctx, req, res) {
  const route = routeOf(req);
  if (route === VENDOR_ROUTE) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    // The artifact is public, immutable JavaScript with no secrets in it, so
    // this is not a data leak — but an <script src> from any page the user
    // visits can otherwise load it and probe which plugins are installed.
    if (!vendorRequestTrusted(req)) {
      json(res, 403, { error: "request-not-trusted" });
      return;
    }
    if (!vendorCache) await loadVendor();
    if (vendorCache) { sendVendor(req, res); return; }
    json(res, 404, { error: "not-found" });
    return;
  }
  const body = await parseJson(req, res);
  if (body === null) return;
  try {
    if (route === "/list") {
      json(res, 200, { connections: (await loadStore(ctx)).map((row) => publicConn(row, credentialsOf(ctx))) });
      return;
    }
    if (route === "/consoles") {
      json(res, 200, { view: await readConsoleView() });
      return;
    }
    if (route === "/consoles/save") {
      const view = normalizeConsoleView(body);
      await saveConsoleView(view);
      json(res, 200, { view });
      return;
    }
    if (route === "/save") {
      // The draft carries the plaintext password; the stored row never does.
      // `loadStore` supplies the current password for a blank field, so a save
      // that leaves the field alone does not rewrite the credential record.
      const credentials = credentialsOf(ctx);
      let saved = null;
      await updateStore(ctx, async (list) => {
        const previous = typeof body.id === "string" ? findConn(list, body.id) : undefined;
        const row = sanitizeDraft(body, previous);
        if (!previous || previous.password !== row.password) {
          await writePassword(credentials, row.id, row.password);
        }
        saved = row;
        return previous ? list.map((item) => (item.id === row.id ? row : item)) : list.concat([row]);
      });
      await dropLive(saved.id);
      json(res, 200, { connection: publicConn(saved, credentials) });
      return;
    }
    if (route === "/delete") {
      const id = String(body.id || "");
      const credentials = credentialsOf(ctx);
      await updateStore(ctx, async (list) => {
        await credentials?.deleteRecord(passwordKey(id));
        return list.filter((item) => item.id !== id);
      });
      await dropLive(id);
      json(res, 200, { ok: true });
      return;
    }
    const conn = await withConn(ctx, body);
    if (!conn) {
      json(res, 404, { error: "connection-not-found" });
      return;
    }
    if (route === "/test") {
      json(res, 200, await testConn(conn));
      return;
    }
    if (route === "/schemas") {
      json(res, 200, await listSchemas(conn));
      return;
    }
    if (route === "/children") {
      json(res, 200, { items: await childrenOf(conn, body.path || { kind: "root" }) });
      return;
    }
    if (route === "/preview") {
      json(res, 200, await previewTable(conn, body));
      return;
    }
    if (route === "/columns") {
      json(res, 200, await describeTable(conn, body));
      return;
    }
    if (route === "/update") {
      json(res, 200, await updateRows(conn, body));
      return;
    }
    if (route === "/cell") {
      json(res, 200, await readCell(conn, body));
      return;
    }
    if (route === "/query") {
      json(res, 200, await runQuery(conn, body));
      return;
    }
    if (route === "/key") {
      json(res, 200, await inspectKey(conn, body));
      return;
    }
    if (route === "/key/delete") {
      json(res, 200, await deleteKey(conn, body));
      return;
    }
    if (route === "/export") {
      json(res, 200, await exportSql(conn, body));
      return;
    }
    if (route === "/import") {
      json(res, 200, await importSql(conn, body));
      return;
    }
    json(res, 404, { error: "not-found" });
  } catch (error) {
    json(res, 500, { error: safeMessage(error) });
  }
}

function apply(ctx) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const handler = (req, res) => dispatch(ctx, req, res);
      const dispose = PREFIXES.map((path) => webCtx.webServer.register({
        kind: "prefix",
        path,
        handler,
      }));
      // Unref'd, so an idle host is never kept awake just to sweep.
      const reaper = startIdleReaper();
      return () => {
        for (const drop of dispose) {
          try { drop(); } catch {}
        }
        try { clearInterval(reaper); } catch {}
        closeAllLive();
      };
    }, "dsh-idea: database routes");
  });

  // Move any pre-encryption plaintext password out of the connection file into
  // the credential store. `inject` defers this until the service is actually
  // mounted, which is what keeps a composition without one from having the
  // plaintext deleted before there is anywhere to put it. A request that
  // arrives first still gets the plaintext row, because `readStore` keeps the
  // legacy field until the rewrite lands. Idempotent, so a reload of the
  // credential service re-running it is harmless.
  //
  // The promise is returned so a loader that awaits `apply` also awaits the
  // migration; it is `undefined` when the service is not mounted yet, which is
  // fine — the callback runs later and reports its own failures.
  let migrated;
  ctx.inject(["credentials"], (credCtx) => {
    migrated = migratePasswords(credCtx)
      .then((count) => {
        if (count > 0) credCtx.logger?.info(`dsh-idea: moved ${count} dsh-database connection password(s) into the credential store`);
      })
      .catch((error) => {
        credCtx.logger?.warn(`dsh-idea: dsh-database password migration failed; plaintext passwords remain in ${storePath()}`);
        credCtx.logger?.warn(error);
      });
  });
  return migrated;
}

// Test surface: the migration and the console-view normalizer are the two
// pieces worth driving without a live host, so they are exported alongside the
// plugin entry point. Nothing else in this module is public.
export {
  apply,
  name,
  PREFIX,
  PREFIX_NEW,
  PREFIXES,
  CRED_SCOPE,
  prefixOf,
  routeOf,
  storePath,
  consolesPath,
  migratePasswords,
  readStore,
  loadStore,
  stripPasswords,
  readPassword,
  writePassword,
  normalizeConsoleView,
  readConsoleView,
  publicConn,
};
