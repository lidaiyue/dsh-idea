import assert from "node:assert/strict";
import test from "node:test";
import { bindRedisLifetime, commandBlocked } from "../lib/database/engines/redis.js";
import { forgetLive, peekLive, rememberLive } from "../lib/database/live.js";

test("redis console blocks scripting and admin verbs", () => {
  const blocked = [
    "EVAL return 1 0",
    "eval_ro \"return 1\" 0",
    "EVALSHA abc 0",
    "FCALL fn 0",
    "FUNCTION LOAD lua",
    "MODULE LOAD /tmp/exp.so",
    "CONFIG GET requirepass",
    "FLUSHALL",
    "REPLICAOF 127.0.0.1 6380",
    "SHUTDOWN NOSAVE",
  ];
  for (const command of blocked) assert.equal(commandBlocked(command), true, command);
  assert.equal(commandBlocked("GET key"), false);
  assert.equal(commandBlocked("HGETALL user:1"), false);
  assert.equal(commandBlocked(""), false);
});

function fakeClient() {
  const listeners = { end: [], error: [] };
  return {
    once(name, fn) { listeners[name].push(fn); },
    on(name, fn) { listeners[name].push(fn); },
    emit(name) {
      const list = listeners[name].slice();
      for (const fn of list) fn();
    },
    disconnect() { this.emit("end"); },
  };
}

test("a losing redis connect does not evict the live handle", async () => {
  const key = "review-redis-race";
  const winnerClient = fakeClient();
  const winner = { close: async () => { winnerClient.disconnect(); } };
  const loserClient = fakeClient();
  const loser = { close: async () => { loserClient.disconnect(); } };
  try {
    const first = await rememberLive(key, winner, false);
    assert.equal(first, winner);
    bindRedisLifetime(key, winnerClient, winner);
    const second = await rememberLive(key, loser, false);
    assert.equal(second, winner);
    assert.equal(peekLive(key), winner);
    loserClient.emit("end");
    loserClient.emit("error");
    assert.equal(peekLive(key), winner);
    winnerClient.emit("error");
    assert.equal(peekLive(key), undefined);
  } finally {
    forgetLive(key, winner);
    forgetLive(key, loser);
  }
});
