import { createEntry, deleteEntry, FsError, listDir, readImage, readText, renameEntry, resolveInWorkspace, writeText } from "./files.js";
import { apply as applyGit } from "./git/index.js";
import { json, parseJson } from "./http.js";
import { LspService } from "./lsp/index.js";
import { apply as applyNav } from "./nav/index.js";
import { locationsInside } from "./symbol.js";

const name = "dsh-idea";
const PREFIX = "/plugins/dsh-idea";

const OPS = new Set(["goToDefinition", "findReferences", "goToImplementation", "warmup"]);

function apply(ctx) {
  applyNav(ctx);
  applyGit(ctx);

  // Create LSP service (internal use only, not exposed to context)
  const lspService = new LspService();
  ctx.effect(() => {
    return () => {
      lspService.stop();
    };
  }, "dsh-idea: lsp service");

  const connectionOf = () => {
    try { return ctx.get("connection"); } catch { return undefined; }
  };
  ctx.inject(["webServer"], (webCtx) => {
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
    const fail = (res, err) => {
      if (err instanceof FsError) {
        const status = err.code === "cwd-required" || err.code === "bad-path" || err.code === "bad-text" || err.code === "bad-eol" ? 400 : err.code === "conflict" ? 409 : 422;
        json(res, status, { error: err.code });
        return;
      }
      json(res, 500, { error: err && err.message ? String(err.message) : "failed" });
    };
    const listHandler = async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      try {
        json(res, 200, await listDir(body.cwd, typeof body.rel === "string" ? body.rel : ""));
      } catch (err) { fail(res, err); }
    };
    const readHandler = async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      try {
        json(res, 200, await readText(body.cwd, body.rel));
      } catch (err) { fail(res, err); }
    };
    const symbolHandler = async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      if (!OPS.has(body.operation)) {
        json(res, 400, { error: "bad-operation" });
        return;
      }
      if (!Number.isInteger(body.line) || body.line < 0 || !Number.isInteger(body.character) || body.character < 0) {
        json(res, 400, { error: "bad-position" });
        return;
      }
      let located;
      try {
        located = await resolveInWorkspace(body.cwd, body.rel);
      } catch (err) {
        fail(res, err);
        return;
      }
      try {
        if (body.operation === "warmup") {
          // Fire-and-forget: start the language server so the first real
          // jump does not pay the cold-start cost. Missing servers are fine.
          const ok = await lspService.warm(located.abs, located.root);
          json(res, 200, ok ? { ok: true } : { ok: false, error: "lsp-unavailable" });
          return;
        }
        const result = await lspService.query({
          operation: body.operation,
          filePath: located.abs,
          workspaceRoot: located.root,
          position: { line: body.line, character: body.character },
          text: typeof body.text === "string" ? body.text : undefined
        });
        json(res, 200, { locations: locationsInside(located.root, result) });
      } catch (err) {
        if (err && err.code === "LSP_UNAVAILABLE") {
          json(res, 200, { locations: [], error: "lsp-unavailable", message: err.message });
          return;
        }
        const message = err && err.message ? String(err.message).slice(0, 300) : "";
        json(res, 502, { error: "lsp-failed", message });
      }
    };
    const mutate = (fn) => async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      try {
        await fn(body);
        json(res, 200, { ok: true });
      } catch (err) { fail(res, err); }
    };
    const writeHandler = async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      try {
        await writeText(body.cwd, body.rel, body.text, body.eol, body.bom === true, typeof body.base === "string" ? body.base : undefined);
        json(res, 200, { ok: true });
      } catch (err) { fail(res, err); }
    };
    webCtx.effect(() => {
      const dispose = [
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/list", handler: listHandler }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/read", handler: readHandler }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/image", handler: async (req, res) => {
          if (!fence(req, res)) return;
          const body = await parseJson(req, res);
          if (body === null) return;
          try {
            json(res, 200, await readImage(body.cwd, body.rel));
          } catch (err) { fail(res, err); }
        } }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/write", handler: writeHandler }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/symbol", handler: symbolHandler }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/create", handler: mutate((body) => createEntry(body.cwd, body.rel, body.dir === true)) }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/rename", handler: mutate((body) => renameEntry(body.cwd, body.rel, body.to)) }),
        webCtx.webServer.register({ kind: "exact", path: PREFIX + "/delete", handler: mutate((body) => deleteEntry(body.cwd, body.rel)) })
      ];
      return () => {
        for (let i = 0; i < dispose.length; i++) {
          try { dispose[i](); } catch {}
        }
      };
    }, "dsh-idea: file routes");
  });
}

export { apply, name };
