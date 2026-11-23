import { Buffer } from "node:buffer";

const HEADER_CONTENT_LENGTH = "Content-Length";
const HEADER_CONTENT_TYPE = "Content-Type";
// Hard cap for one message body. A corrupted stream (binary garbage parsed as
// a huge length) must not make the decoder buffer until the process OOMs.
const MAX_CONTENT_LENGTH = 32 * 1024 * 1024;
// A stream that never yields a complete header (binary garbage, LF-only banners)
// must not grow the buffer without bound. Past this, resynchronize at the next
// plausible header instead of accumulating forever.
const MAX_BUFFER_BYTES = MAX_CONTENT_LENGTH * 2;

/**
 * Encode a JSON-RPC message with LSP-style headers.
 * @param {object} message
 * @returns {Buffer}
 */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(
    `${HEADER_CONTENT_LENGTH}: ${body.length}\r\n\r\n`,
    "ascii"
  );
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder for LSP messages over stdio.
 * Buffers incoming data and yields complete messages.
 */
export class MessageDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Feed data and return any complete messages.
   * @param {Buffer} chunk
   * @returns {object[]}
   */
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        // No complete header. If the buffer has grown past the cap, discard
        // everything before the last possible header start so a valid message
        // can still be recovered instead of staying permanently out of sync.
        if (this.buffer.length > MAX_BUFFER_BYTES) {
          const keep = this.buffer.lastIndexOf("Content-Length:", this.buffer.length - 1);
          this.buffer = keep > 0 ? this.buffer.subarray(keep) : Buffer.alloc(0);
        }
        break;
      }

      const headerText = this.buffer.toString("ascii", 0, headerEnd);
      const headers = parseHeaders(headerText);
      const contentLength = headers[HEADER_CONTENT_LENGTH.toLowerCase()];
      if (contentLength === undefined) {
        // No length: skipping only the CRLF pair left the following bytes to
        // be parsed as the next header and permanently desynced the stream.
        this.resync(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(contentLength, 10);
      if (!Number.isFinite(length) || length < 0 || length > MAX_CONTENT_LENGTH) {
        // Invalid or oversized header: drop it and resynchronize at the next
        // header start. Leaving the corrupt body in the buffer made the next
        // header parse pick a colon inside the JSON, so every later message
        // was skipped forever.
        this.resync(headerEnd + 4);
        continue;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) break; // Need more data

      const body = this.buffer.toString("utf8", bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        messages.push(JSON.parse(body));
      } catch {
        // Skip malformed JSON
      }
    }

    return messages;
  }

  resync(from) {
    const marker = HEADER_CONTENT_LENGTH + ":";
    const next = this.buffer.indexOf(marker, from);
    this.buffer = next >= from ? this.buffer.subarray(next) : Buffer.alloc(0);
  }
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}
