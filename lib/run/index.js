import { join } from "node:path";
import { CONFIG_REL, ConfigError } from "./config.js";
import { resolveRuns } from "./discover.js";
import { isAbs, json, parseJson } from "../http.js";
import { Runner } from "./runner.js";

const PREFIX = "/plugins/dsh-idea/run";
const LEGACY_PREFIX = "/plugins/dsh-run";
/** The model reads the tail of one application's output, not its whole lifetime. */
const TOOL_TEXT_BYTES = 16 * 1024;

/** The first token of an error message, which the routes and the tool report as the reason. */
function codeOf(error) {
  if (error instanceof ConfigError) return error.code;
  const message = error && error.message ? String(error.message) : "";
  const colon = message.indexOf(":");
  return colon > 0 ? message.slice(0, colon) : message === "" ? "failed" : message;
}

function messageOf(error) {
  return error && error.message ? String(error.message) : "failed";
}

/** The HTTP status a failure earns; the body carries the same reason for the page. */
function statusOf(error) {
  if (error instanceof ConfigError) return 422;
  switch (codeOf(error)) {
    case "shell-unavailable": return 503;
    case "not-started": return 409;
    case "unknown-configuration": return 404;
    case "id-required": return 400;
    default: return 500;
  }
}

/** A required configuration id, or the refusal that names the missing field. */
function idOf(value) {
  if (typeof value !== "string" || value === "") throw new Error("id-required");
  return value;
}

/** Merge one configuration's two retained streams for a reader that keeps no cursor. */
function toolText(tail) {
  const body = tail.stdout.text + (tail.stderr.text === "" ? "" : `[stderr]\n${tail.stderr.text}`);
  if (body.length <= TOOL_TEXT_BYTES) return body;
  return `[output clipped to the last ${TOOL_TEXT_BYTES} characters]\n${body.slice(body.length - TOOL_TEXT_BYTES)}`;
}

/** `running/starting :8080`, `exited, exit 3`, and so on: one bracketed status per row. */
function statusText(row) {
  const phase = row.phase !== undefined && row.phase !== "running" ? `/${row.phase}` : "";
  const exit = row.exitCode === null || row.exitCode === undefined || row.state === "running" ? "" : `, exit ${row.exitCode}`;
  const port = row.port === undefined ? "" : ` :${row.port}`;
  const reason = typeof row.reason === "string" && row.reason !== "" ? `, ${row.reason}` : "";
  let restart = "";
  if (row.restartStatus === "scheduled" || row.restartStatus === "restarting") {
    const n = row.restartAttempt !== undefined ? ` ${row.restartAttempt}` : "";
    const limit = row.restartLimit !== undefined ? `/${row.restartLimit}` : "";
    restart = `, auto-restarting${n}${limit}`;
  } else if (row.restartStatus === "stopped") {
    restart = ", auto-restart stopped";
  }
  return `${row.state}${phase}${exit}${port}${reason}${restart}`;
}

/** How one `run_config` result reads to the model. */
function renderToolResult(value) {
  if (value === null || typeof value !== "object") return "(no result)";
  if (Array.isArray(value.runs)) {
    const header = value.file === undefined ? "" : `configurations from ${value.file}\n`;
    const note = value.message === undefined ? "" : `${value.message}\n`;
    const rows = value.runs.length === 0
      ? "(no run configurations found: no .dsh/run.json, no package.json scripts, no Spring Boot module)"
      : value.runs.map((row) => `${row.id} [${statusText(row)}] ${row.name} — ${row.command}`).join("\n");
    return header + note + rows;
  }
  if (typeof value.text === "string") {
    return `[${value.id}: ${statusText(value)}]\n${value.text === "" ? "(no output yet)" : value.text}`;
  }
  if (typeof value.command === "string") {
    return `${value.id} [${statusText(value)}] ${value.name} — ${value.command}`;
  }
  return JSON.stringify(value);
}

/** The workspace a tool call acts on: its explicit `cwd`, else the calling agent's working directory. */
function workingRootOf(args, exec, ctx) {
  if (typeof args.cwd === "string" && isAbs(args.cwd)) return args.cwd;
  const agent = exec.agent;
  const session = agent === undefined ? undefined : agent.session;
  if (session === undefined) return undefined;
  try {
    const workingDirectory = ctx.get("workingDirectory");
    if (workingDirectory !== undefined && typeof workingDirectory.get === "function") {
      const value = workingDirectory.get(session);
      if (isAbs(value)) return value;
    }
  } catch {}
  return typeof session.cwd === "string" && isAbs(session.cwd) ? session.cwd : undefined;
}

/**
 * The single `run_config` tool: both the page and the agent drive the same
 * `Runner` methods, so a start from the panel and a start from a tool call
 * cannot diverge.
 */
function toolDefinition(ctx, runner) {
  return {
    name: "run_config",
    description:
      "Manage the workspace's run configurations, declared in `.dsh/run.json`: list them, start one, stop one, or read one's output. "
      + "Use it to start the application the user is working on and to check what it printed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["list", "start", "stop", "restart", "logs"],
          description: "list every configuration with its state; start a stopped one; stop a running one; restart stops and starts it again; logs reads its retained output."
        },
        id: {
          type: "string",
          description: "Configuration id, required for start, stop, and logs."
        },
        cwd: {
          type: "string",
          description: "Absolute workspace root. Omit to use the calling agent's working directory."
        }
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: renderToolResult(value) }]
    },
    async execute(args, exec) {
      const root = workingRootOf(args, exec, ctx);
      if (root === undefined) throw new Error("cwd-required: pass the workspace root");
      switch (args.action) {
        case "list": {
          try {
            const document = await resolveRuns(root);
            return { file: document.file, runs: runner.list(root, document.runs) };
          } catch (error) {
            return { file: join(root, CONFIG_REL), error: codeOf(error), message: messageOf(error), runs: [] };
          }
        }
        case "start":
        case "restart": {
          const id = idOf(args.id);
          const document = await resolveRuns(root);
          const entry = document.runs.find((candidate) => candidate.id === id);
          if (entry === undefined) throw new Error(`unknown-configuration: ${id}`);
          return args.action === "start" ? runner.start(root, entry) : runner.restart(root, entry);
        }
        case "stop":
          return runner.stop(root, idOf(args.id));
        case "logs": {
          const id = idOf(args.id);
          const tail = runner.tail(root, id, { stdout: 0, stderr: 0 });
          if (tail === null) return { id, state: "idle", exitCode: null, text: "" };
          const out = { id, state: tail.state, exitCode: tail.exitCode, text: toolText(tail) };
          if (tail.phase !== undefined) out.phase = tail.phase;
          if (tail.port !== undefined) out.port = tail.port;
          return out;
        }
        default:
          throw new Error(`unknown-action: ${String(args.action)}`);
      }
    }
  };
}

function apply(ctx) {
  const runner = new Runner(ctx);
  ctx.effect(() => () => runner.dispose(), "dsh-idea: run processes");

  ctx.inject(["tools"], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(toolDefinition(ctx, runner)), "dsh-idea: run_config tool");
  });

  ctx.inject(["webServer"], (webCtx) => {
    // The composition's `connection` service owns the Host/Origin fence and
    // browser-session authentication. Read it lazily: a missing service rejects
    // the request rather than trusting it.
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
    const fail = (res, error) => {
      json(res, statusOf(error), { error: codeOf(error), message: messageOf(error) });
    };
    const route = (run) => async (req, res) => {
      if (!fence(req, res)) return;
      const body = await parseJson(req, res);
      if (body === null) return;
      if (!isAbs(body.cwd)) {
        json(res, 400, { error: "cwd-required" });
        return;
      }
      try {
        json(res, 200, await run(body));
      } catch (error) { fail(res, error); }
    };

    const listRoute = route(async (body) => {
      try {
        const document = await resolveRuns(body.cwd, body.fresh === true);
        return {
          file: document.file,
          runs: runner.list(body.cwd, document.runs),
          sources: document.sources,
          declared: document.declared
        };
      } catch (error) {
        // A broken configuration file is a page-level state, not a failed read:
        // the panel shows the reason and keeps its head.
        return { file: join(body.cwd, CONFIG_REL), runs: [], error: codeOf(error), message: messageOf(error) };
      }
    });
    const startRoute = route(async (body) => {
      const id = idOf(body.id);
      const document = await resolveRuns(body.cwd);
      const entry = document.runs.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`unknown-configuration: ${id}`);
      return runner.start(body.cwd, entry);
    });
    const restartRoute = route(async (body) => {
      const id = idOf(body.id);
      const document = await resolveRuns(body.cwd);
      const entry = document.runs.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`unknown-configuration: ${id}`);
      return runner.restart(body.cwd, entry);
    });
    const stopRoute = route((body) => runner.stop(body.cwd, idOf(body.id)));
    const tailRoute = route((body) => {
      const tail = runner.tail(body.cwd, idOf(body.id), {
        stdout: Number.isInteger(body.stdout) && body.stdout >= 0 ? body.stdout : 0,
        stderr: Number.isInteger(body.stderr) && body.stderr >= 0 ? body.stderr : 0
      });
      return tail === null ? { state: "idle", exitCode: null } : tail;
    });
    const registerRoutes = (prefix) => [
      webCtx.webServer.register({ kind: "exact", path: prefix + "/list", handler: listRoute }),
      webCtx.webServer.register({ kind: "exact", path: prefix + "/start", handler: startRoute }),
      webCtx.webServer.register({ kind: "exact", path: prefix + "/stop", handler: stopRoute }),
      webCtx.webServer.register({ kind: "exact", path: prefix + "/restart", handler: restartRoute }),
      webCtx.webServer.register({ kind: "exact", path: prefix + "/tail", handler: tailRoute })
    ];
    webCtx.effect(() => {
      const dispose = [...registerRoutes(PREFIX), ...registerRoutes(LEGACY_PREFIX)];
      return () => {
        for (const entry of dispose) {
          try { entry(); } catch {}
        }
      };
    }, "dsh-idea: run routes");
  });
}

export { apply };
