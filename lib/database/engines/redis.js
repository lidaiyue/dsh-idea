import { MAX_KEYS, resultOf } from "../sql.js";
import { CONNECT_MS, QUERY_MS, forgetLive, loadModule, liveKey, peekLive, rememberLive, touchLive } from "../live.js";

export const type = "redis";

export async function scanKeys(client, limit) {
  const keys = [];
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, "COUNT", 200);
    cursor = String(reply[0]);
    for (const key of reply[1] || []) {
      keys.push(String(key));
      if (keys.length >= limit) break;
    }
  } while (cursor !== "0" && keys.length < limit);
  return keys;
}

export async function handle(conn, dbIndex) {
  const index = dbIndex === undefined || dbIndex === null || dbIndex === "" ? 0 : Number(dbIndex);
  const key = liveKey(conn, String(index));
  const existing = peekLive(key);
  if (existing) {
    touchLive(key);
    return existing;
  }
  const Redis = await loadModule("ioredis", "Redis");
  const client = new Redis({
    host: conn.host || "127.0.0.1",
    port: Number(conn.port) || 6379,
    password: conn.password || undefined,
    db: Number.isFinite(index) ? index : 0,
    connectTimeout: CONNECT_MS,
    maxRetriesPerRequest: 1,
    // A blocking command (`BLPOP`, `WAIT`) or a huge `KEYS *` on a busy server
    // otherwise never settles, and this handle is shared by every later request
    // on the same db index. `maxRetriesPerRequest` bounds retries, not the
    // command itself, so an explicit cap is needed.
    commandTimeout: QUERY_MS,
    lazyConnect: true,
    enableOfflineQueue: false,
    // Retrying is the driver's default, and here it is harmful: a connection
    // that cannot be reached would otherwise be retried in the background for as
    // long as the host runs, one client per failed attempt, none of them
    // reachable by `closeAllLive` (they were never registered). The caller sees
    // the failure immediately and can retry deliberately.
    retryStrategy: () => null,
  });
  try {
    await client.connect();
  } catch (error) {
    // `rememberLive` is never reached on a failed connect, so this client is not
    // in the registry — nothing else will ever close it. Without this the driver
    // keeps it (and its retry timer) alive for the life of the process.
    try { client.disconnect(); } catch {}
    throw error;
  }
  const next = {
    type: "redis",
    client,
    db: index,
    async close() {
      client.disconnect();
    },
  };
  const registered = await rememberLive(key, next, false);
  // retryStrategy is disabled, so any disconnect is terminal. Evict the handle
  // on end/error instead of relying on the idle reaper: touchLive() on each
  // peek would keep refreshing its TTL and the dead client would stay cached
  // indefinitely.
  const evict = () => { forgetLive(key, registered); };
  client.once("end", evict);
  client.on("error", evict);
  return registered;
}

export async function schemas() {
  return { items: [] };
}

export async function children(conn, path) {
  const kind = path && path.kind ? path.kind : "root";
  if (kind === "root") {
    const db = await handle(conn, 0);
    let count = 16;
    try {
      const cfg = await db.client.config("GET", "databases");
      if (Array.isArray(cfg) && cfg[1]) count = Math.max(1, Number(cfg[1]) || 16);
    } catch {}
    count = Math.min(count, 64);
    const info = await db.client.info("keyspace");
    const used = {};
    String(info || "").split("\n").forEach((line) => {
      const match = /^db(\d+):keys=(\d+)/.exec(line.trim());
      if (match) used[Number(match[1])] = Number(match[2]);
    });
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push({ kind: "redis-db", name: "db" + i, index: i, keys: used[i] || 0 });
    }
    return items;
  }
  if (kind === "redis-db") {
    const db = await handle(conn, path.index);
    const keys = await scanKeys(db.client, MAX_KEYS);
    keys.sort();
    return keys.map((keyName) => ({
      kind: "key",
      name: keyName,
      database: String(path.index),
      truncated: keys.length >= MAX_KEYS,
    }));
  }
  return [];
}

// Longest string value shown in the key preview.
//
// Deliberately below `CELL_CHARS_MAX` (8000): `resultOf` runs every value
// through `cell()`, which cuts at that limit, so a cap at or above it would lose
// the trailing "… (N bytes total)" note — exactly the part that tells the user
// the value is bigger than what they can see. Redis allows a 512 MB value, so
// the point is that the server sends a bounded slice rather than all of it.
const MAX_STRING_BYTES = 6 * 1024;
// Fields / members / entries shown for the collection types.
const MAX_ENTRIES = 200;

export async function inspect(conn, path) {
  const db = await handle(conn, path.database);
  const key = String(path.key || "");
  const keyType = await db.client.type(key);
  const ttl = await db.client.ttl(key);
  let value = "";
  // Every branch bounds the read at the SERVER. `get`, `hgetall` and `smembers`
  // were fetched whole and only then truncated: a 512 MB string, or a set with
  // millions of members, was pulled into the host process and reduced to 200
  // lines. `lrange`/`zrange` already took a range; these now do the same.
  if (keyType === "string") {
    const raw = await db.client.getrange(key, 0, MAX_STRING_BYTES - 1);
    const bytes = await db.client.strlen(key);
    value = String(raw) + (bytes > MAX_STRING_BYTES ? "\n… (" + bytes + " bytes total)" : "");
  } else if (keyType === "hash") {
    // HSCAN rather than HGETALL: it returns a bounded page instead of the whole
    // hash, and the cursor tells us whether more exists.
    const [cursor, flat] = await db.client.hscan(key, "0", "COUNT", MAX_ENTRIES * 2);
    const fields = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    value = JSON.stringify(fields, null, 2);
    if (String(cursor) !== "0") value += "\n… (more fields not shown)";
  } else if (keyType === "list") {
    value = (await db.client.lrange(key, 0, MAX_ENTRIES - 1)).join("\n");
  } else if (keyType === "set") {
    // SSCAN instead of SMEMBERS, for the same reason as HSCAN.
    const [cursor, members] = await db.client.sscan(key, "0", "COUNT", MAX_ENTRIES * 2);
    value = members.slice(0, MAX_ENTRIES).join("\n");
    if (String(cursor) !== "0") value += "\n… (more members not shown)";
  } else if (keyType === "zset") {
    const z = await db.client.zrange(key, 0, MAX_ENTRIES - 1, "WITHSCORES");
    const lines = [];
    for (let i = 0; i < z.length; i += 2) lines.push(z[i] + "\t" + z[i + 1]);
    value = lines.join("\n");
  } else value = "(" + keyType + ")";
  return resultOf(["key", "type", "ttl", "value"], [[key, keyType, ttl, value]], false);
}

// DEL one key by name. The console's command path splits on whitespace, so a
// key such as "a b" cannot go through it — the name has to arrive as one field.
// A missing name is refused: DEL "" is a real command and must not be the
// result of a request that forgot the field.
export async function removeKey(conn, path) {
  const key = path && path.key != null ? String(path.key) : "";
  if (key === "") throw new Error("empty-key");
  const index = Number(path && path.database);
  if (!Number.isFinite(index) || index < 0) throw new Error("bad-db");
  const db = await handle(conn, index);
  const deleted = await db.client.del(key);
  return { ok: true, deleted: Number(deleted) || 0 };
}

export async function test(conn) {
  const db = await handle(conn, 0);
  const pong = await db.client.ping();
  return { ok: true, message: String(pong || "PONG") };
}
