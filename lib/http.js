import { Buffer } from "node:buffer";

export const MAX_BODY = 4 * 1024 * 1024;

/** Whether `path` looks like an absolute POSIX or Windows path. */
export function isAbs(path) {
  return typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
}

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
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

/** JSON POST body. Trust is the caller's job. Returns null when a response was sent. */
export async function parseJson(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return null;
  }
  const mediaType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    json(res, 415, { error: "unsupported-media-type" });
    return null;
  }
  let raw;
  try { raw = await readBody(req, MAX_BODY); } catch {
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
