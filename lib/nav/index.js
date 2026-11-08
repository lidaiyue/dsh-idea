import { resolve as resolvePath } from "node:path";
import { json, parseJson, isAbs } from "../http.js";
import { walk, MAX_FILES } from "./walk.js";
import {
  SEARCH_MAX_MATCHES, MAX_SEARCH_QUERY, SEARCH_TIMEOUT_MS,
  rgBinaryPath, runRipgrep, parseRgJson, searchWithoutRipgrep
} from "./search.js";

const name = "dsh-files-navigator";
const INDEX_PATH = "/plugins/dsh-idea/nav/index";
const SEARCH_PATH = "/plugins/dsh-idea/nav/search";
const WALK_TTL_MS = 2000;

// Collapses the walk behind concurrent index requests for one root. The browser
// debounces keystrokes but cannot dedupe requests already in flight, and each
// index request used to walk the whole tree on its own.
const walkCache = { key: "", at: 0, files: null, inflight: null, generation: 0 };

/** Walk `root`, reusing a walk another request started within `WALK_TTL_MS`. */
async function filesUnder(root) {
  const now = Date.now();
  if (walkCache.key === root && walkCache.files !== null && now - walkCache.at < WALK_TTL_MS) {
    return walkCache.files;
  }
  if (walkCache.inflight !== null && walkCache.key === root) return walkCache.inflight;
  // Each walk owns a generation marker. A walk for another root that is still
  // in flight when this one starts must not, on finishing, overwrite the cache
  // key or clear this walk's inflight entry — so a write is only honoured
  // while this walk is still the newest (same trick as indexCache in the
  // browser half).
  const generation = ++walkCache.generation;
  const superseded = () => walkCache.generation !== generation;
  const files = [];
  const work = walk(root, "", files).then(() => {
    if (!superseded()) {
      walkCache.key = root;
      walkCache.at = Date.now();
      walkCache.files = files;
      walkCache.inflight = null;
    }
    return files;
  }, (error) => {
    if (!superseded()) walkCache.inflight = null;
    throw error;
  });
  walkCache.key = root;
  walkCache.inflight = work;
  return work;
}

function apply(ctx) {
  // The composition's `connection` service owns the Host/Origin fence,
  // `Sec-Fetch-Site` check, and browser-session authentication. Read it lazily;
  // a missing service rejects the request rather than trusting it.
  const connectionOf = () => {
    try {
      return ctx.get("connection");
    } catch {
      return undefined;
    }
  };
  ctx.inject(["webServer"], (webCtx) => {
    // The composition's connection fence is the only trust check. Without it
    // the route refuses the request instead of inventing a second policy.
    const fence = (req, res) => {
      const connection = connectionOf();
      if (connection === undefined || typeof connection.requestRejection !== "function") {
        json(res, 403, { error: "request-not-trusted" });
        return false;
      }
      const rejection = connection.requestRejection(req);
      if (rejection === undefined) return true;
      res.writeHead(rejection);
      res.end(rejection === 401 ? "unauthorized" : "forbidden");
      return false;
    };
    const indexHandler = async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      const cwd = body.cwd;
      if (!isAbs(cwd)) {
        json(res, 400, { error: "cwd-required" });
        return;
      }
      try {
        const files = await filesUnder(resolvePath(cwd));
        json(res, 200, { files, truncated: files.length >= MAX_FILES, limit: MAX_FILES });
      } catch (error) {
        json(res, 500, { error: error && error.message ? String(error.message) : "index-failed" });
      }
    };
    const searchHandler = async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      const cwd = body.cwd;
      if (!isAbs(cwd)) {
        json(res, 400, { error: "cwd-required" });
        return;
      }
      const query = typeof body.query === "string" ? body.query : "";
      if (query.trim() === "") {
        json(res, 400, { error: "query-required" });
        return;
      }
      if (query.length > MAX_SEARCH_QUERY) {
        json(res, 400, { error: "query-too-long" });
        return;
      }
      const regex = body.regex === true;
      const ignoreCase = body.caseSensitive !== true;
      const root = resolvePath(cwd);
      const binary = await rgBinaryPath();
      if (binary !== null) {
        const run = await runRipgrep(binary, root, query, ignoreCase, regex);
        if (run.failed === true && run.exitCode === 2) {
          // Structured flag so the browser never has to compare translated
          // strings to detect a bad pattern.
          json(res, 200, { engine: "rg", regex, matches: [], truncated: false, invalidPattern: true, error: "invalid-pattern" });
          return;
        }
        if (run.failed !== true) {
          const parsed = parseRgJson(run.stdout, root, SEARCH_MAX_MATCHES);
          json(res, 200, {
            engine: "rg",
            regex,
            matches: parsed.matches,
            truncated: parsed.truncated || run.timedOut
          });
          return;
        }
      }
      // The JS fallback only does literal matching; silently ignoring the
      // regex flag would answer a different question than the one asked.
      if (regex) {
        json(res, 400, { error: "regex-unavailable", regex: true });
        return;
      }
      // The fallback reads files on the event loop, so the rg timeout has to
      // be applied here too via an abort signal instead of a killed child.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      let parsed;
      try {
        parsed = await searchWithoutRipgrep(root, query, ignoreCase, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      // A timeout mid-walk leaves whatever matches were already found.
      if (controller.signal.aborted) parsed = { matches: parsed.matches, truncated: true };
      json(res, 200, { engine: "js", regex: false, matches: parsed.matches, truncated: parsed.truncated });
    };
    webCtx.effect(() => {
      const dispose = [
        webCtx.webServer.register({ kind: "exact", path: INDEX_PATH, handler: indexHandler }),
        webCtx.webServer.register({ kind: "exact", path: SEARCH_PATH, handler: searchHandler })
      ];
      return () => {
        for (let i = 0; i < dispose.length; i++) {
          try { dispose[i](); } catch {}
        }
      };
    }, "dsh-files-navigator: file routes");
  });
}

export { apply, name };
