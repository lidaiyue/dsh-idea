import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { MessageDecoder, encodeMessage } from "../lib/lsp/jsonrpc.js";

test("decoder resyncs when a header has no content-length", () => {
  const decoder = new MessageDecoder();
  const good = encodeMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { message: "ok" } });
  const noise = Buffer.from("banner\r\n\r\n");
  const messages = decoder.feed(Buffer.concat([noise, good]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, "window/logMessage");
});

test("decoder resyncs after an oversized content-length", () => {
  const decoder = new MessageDecoder();
  const good = encodeMessage({ jsonrpc: "2.0", id: 1, result: null });
  const bad = Buffer.from("Content-Length: 999999999\r\n\r\n");
  const messages = decoder.feed(Buffer.concat([bad, good]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
});
