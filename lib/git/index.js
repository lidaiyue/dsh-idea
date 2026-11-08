import { Buffer } from "node:buffer";
import { discoverRepos, failText, loadDiff, loadLog, loadShow, loadState, loadTags } from "./git.js";
import { generateCommitMessage } from "./message.js";
import {
  doCheckout,
  doCherryPick,
  doCommit,
  doCreateBranch,
  doDeleteBranch,
  doInit,
  doMerge,
  doOperation,
  doPull,
  doPush,
  doRenameBranch,
  doRollback
} from "./ops.js";

const name = "dsh-git-manager";

const STATE_PATH = "/plugins/dsh-idea/git/state";
const REPOS_PATH = "/plugins/dsh-idea/git/repos";
const TAGS_PATH = "/plugins/dsh-idea/git/tags";
const LOG_PATH = "/plugins/dsh-idea/git/log";
const SHOW_PATH = "/plugins/dsh-idea/git/show";
const DIFF_PATH = "/plugins/dsh-idea/git/diff";
const CHECKOUT_PATH = "/plugins/dsh-idea/git/checkout";
const PULL_PATH = "/plugins/dsh-idea/git/pull";
const MERGE_PATH = "/plugins/dsh-idea/git/merge";
const CHERRY_PATH = "/plugins/dsh-idea/git/cherry-pick";
const DELETE_PATH = "/plugins/dsh-idea/git/branch-delete";
const CREATE_PATH = "/plugins/dsh-idea/git/branch-create";
const RENAME_PATH = "/plugins/dsh-idea/git/branch-rename";
const OPERATION_PATH = "/plugins/dsh-idea/git/operation";
const COMMIT_PATH = "/plugins/dsh-idea/git/commit";
const ROLLBACK_PATH = "/plugins/dsh-idea/git/rollback";
const PUSH_PATH = "/plugins/dsh-idea/git/push";
const INIT_PATH = "/plugins/dsh-idea/git/init";
const MESSAGE_PATH = "/plugins/dsh-idea/git/generate-message";

const MAX_BODY = 256 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
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

/**
 * Read a JSON POST body.
 *
 * Trust is `fence`, the same `connection.requestRejection` check the file and
 * navigator routes of this plugin use, supplied by the caller. Keeping one
 * trust model across the plugin matters: a deployment composed with
 * `webserver.host: 0.0.0.0` plus `connection.trustedHosts` serves legitimate
 * LAN browsers, and a route that additionally demanded a loopback Host header
 * would refuse exactly those clients while the editor half kept working.
 *
 * `application/json` is not a CORS-simple media type, so a cross-site caller
 * cannot send it without a preflight -- which the browser will not pass,
 * because no route here answers CORS headers. `text/plain` is simple and
 * skips the preflight entirely, so requiring JSON closes that path rather than
 * relying on the Origin check alone.
 *
 * @returns the parsed object, or `null` when the response was already sent.
 */
async function parseJson(req, res, fence) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return null;
  }
  if (typeof fence === "function" && !fence(req, res)) return null;
  const mediaType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    json(res, 415, { error: "content-type-required" });
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

function isAbs(path) {
  return typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
}

/**
 * The provider/model an auxiliary commit-message call uses when the client
 * names none.
 *
 * Nothing is hard-coded. The session's own model is preferred, because that is
 * the one the user is already talking to and the one whose credentials are
 * certainly present; the deployment default is the fallback. Both are read
 * live, so a model switch in the picker takes effect without a restart.
 */
function defaultRoute(ctx, sessionId) {
  try {
    if (typeof sessionId === "string" && sessionId !== "") {
      const agents = ctx.get("agents");
      const agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined;
      const config = agent && agent.session && typeof agent.session.requestHeader === "function"
        ? agent.session.requestHeader()?.config
        : undefined;
      if (config && typeof config.provider === "string" && typeof config.model === "string") {
        return { provider: config.provider, model: config.model };
      }
    }
  } catch {}
  try {
    const selection = ctx.get("agentDefaultModel");
    const current = selection && typeof selection.currentSelection === "function" ? selection.currentSelection() : null;
    if (current && typeof current.provider === "string" && typeof current.model === "string") {
      return { provider: current.provider, model: current.model };
    }
  } catch {}
  return null;
}

function apply(ctx) {
  // `llm` is captured through its own injection rather than the module-level
  // `inject` list: cordis refuses to read an undeclared service (the error is
  // "cannot get property ... without inject"), but declaring it globally would
  // make the whole Git panel wait on a model provider that a git-only
  // deployment never mounts. Grabbing it here keeps commit-message generation
  // optional — the panel simply reports `llm-unavailable` without one.
  let llmService = null;
  ctx.inject(["llm"], (llmCtx) => {
    llmService = llmCtx.llm;
  });

  ctx.inject(["webServer"], (webCtx) => {
    // The composition's `connection` service owns the Host/Origin fence,
    // `Sec-Fetch-Site` check, and browser-session authentication — including
    // the trustedHosts a LAN deployment registers. Read it lazily; a missing
    // service rejects the request rather than trusting it.
    const connectionOf = () => {
      try { return ctx.get("connection"); } catch { return undefined; }
    };
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
    const route = (run) => async (req, res) => {
      const body = await parseJson(req, res, fence);
      if (body === null) return;
      if (!isAbs(body.cwd)) {
        json(res, 400, { error: "cwd-required" });
        return;
      }
      try {
        json(res, 200, await run(body));
      } catch (error) {
        json(res, 500, { error: failText(error) });
      }
    };

    /**
     * The commit-message route answers NDJSON rather than one JSON body: each
     * model text fragment arrives as `{"delta":"…"}` while it is being written,
     * followed by exactly one terminal `{"ok":…}` row. The browser appends
     * deltas to the message box, so generation reads as typing instead of a
     * multi-second freeze.
     *
     * Failures are reported as a terminal row rather than a non-2xx status,
     * because the status line is already sent by the time a model can fail:
     * honest progress requires committing to 200 before the first delta.
     *
     * Declared before `ROUTES` because the table below calls it while the
     * array is being built; a `const` referenced in its own temporal dead
     * zone throws and aborts the whole registration.
     */
    const messageRoute = () => async (req, res) => {
      const body = await parseJson(req, res, fence);
      if (body === null) return;
      if (!isAbs(body.cwd)) {
        json(res, 400, { error: "cwd-required" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive"
      });
      const send = (row) => {
        try { res.write(JSON.stringify(row) + "\n"); } catch {}
      };
      if (llmService === null) {
        send({ ok: false, error: "llm-unavailable" });
        res.end();
        return;
      }
      // A browser that navigates away must not leave the model call running.
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on("close", onClose);
      let result;
      try {
        result = await generateCommitMessage(
          llmService,
          body.cwd,
          { ...body, signal: controller.signal },
          defaultRoute(ctx, body.sessionId),
          (text) => send({ delta: text })
        );
      } catch (error) {
        result = { ok: false, error: failText(error) };
      } finally {
        res.off("close", onClose);
      }
      if (controller.signal.aborted) {
        try { res.end(); } catch {}
        return;
      }
      send(result && result.ok === true
        ? { ok: true, message: result.message }
        : { ok: false, error: result && result.error ? String(result.error) : "generation-failed" });
      try { res.end(); } catch {}
    };

    const ROUTES = [
      [STATE_PATH, route((b) => loadState(b.cwd))],
      [REPOS_PATH, route((b) => discoverRepos(b.cwd))],
      [TAGS_PATH, route((b) => loadTags(b.cwd))],
      [LOG_PATH, route((b) => loadLog(b.cwd, b))],
      [SHOW_PATH, route((b) => loadShow(b.cwd, b.hash))],
      [CHECKOUT_PATH, route((b) => doCheckout(b.cwd, b.ref))],
      [PULL_PATH, route((b) => doPull(b.cwd))],
      [MERGE_PATH, route((b) => doMerge(b.cwd, b.ref))],
      [CHERRY_PATH, route((b) => doCherryPick(b.cwd, b.hash))],
      [DELETE_PATH, route((b) => doDeleteBranch(b.cwd, b.ref, b.kind))],
      [CREATE_PATH, route((b) => doCreateBranch(b.cwd, b.ref, b.from))],
      [RENAME_PATH, route((b) => doRenameBranch(b.cwd, b.ref, b.to))],
      [OPERATION_PATH, route((b) => doOperation(b.cwd, b.action))],
      [INIT_PATH, route((b) => doInit(b.cwd))],
      [DIFF_PATH, route((b) => loadDiff(b.cwd, b.hash, b.path))],
      [COMMIT_PATH, route((b) => doCommit(b.cwd, b.message, b.paths, b.amend === true))],
      [ROLLBACK_PATH, route((b) => doRollback(b.cwd, b.paths))],
      [PUSH_PATH, route((b) => doPush(b.cwd))],
      [MESSAGE_PATH, messageRoute()]
    ];

    webCtx.effect(() => {
      const disposers = ROUTES.map(([path, handler]) => {
        try {
          return webCtx.webServer.register({ kind: "exact", path, handler });
        } catch (error) {
          webCtx.logger?.warn?.(`dsh-git-manager: failed to register ${path}`, error);
          return null;
        }
      });
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose !== "function") continue;
          try { dispose(); } catch {}
        }
      };
    }, "dsh-git-manager: git routes");
  });
}

export { apply, name };
