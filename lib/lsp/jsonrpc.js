import { Buffer } from "node:buffer";

const HEADER_CONTENT_LENGTH = "Content-Length";
const HEADER_CONTENT_TYPE = "Content-Type";
// Hard cap for one message body. A corrupted stream (binary garbage parsed as
// a huge length) must not make the decoder buffer until the process OOMs.
const MAX_CONTENT_LENGTH = 32 * 1024 * 1024;

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
      if (headerEnd === -1) break;

      const headerText = this.buffer.toString("ascii", 0, headerEnd);
      const headers = parseHeaders(headerText);
      const contentLength = headers[HEADER_CONTENT_LENGTH.toLowerCase()];
      if (contentLength === undefined) {
        // Invalid header, skip past it
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(contentLength, 10);
      if (!Number.isFinite(length) || length < 0 || length > MAX_CONTENT_LENGTH) {
        // Invalid or oversized header: protocol error, skip past it
        this.buffer = this.buffer.subarray(headerEnd + 4);
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
