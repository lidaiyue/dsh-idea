/**
 * CLI / env defaults for the dsh-idea performance harness.
 *
 * Non-obvious rules (do not "simplify" these away):
 * - Default viewport is 1440×900. Runs without an explicit viewport under-count
 *   the conversation DOM; session-switch conclusions from those runs are invalid.
 * - This harness never starts or restarts `dsh web`.
 * - Tokens are read from the log at runtime and must never be printed or written.
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUITES = [
  "smoke",
  "session-switch",
  "chat-scroll",
  "editor-lifecycle",
  "git-run",
  "large-file"
];

export const ALL_SUITES = [...SUITES];

export const DEFAULTS = {
  url: "http://127.0.0.1:3080",
  viewport: { width: 1440, height: 900 },
  outdir: "/tmp/dsh-idea-perf",
  tokenLog: join(homedir(), ".dsh", "dsh-web.log"),
  switches: 7,
  switchGapMs: 280,
  settleMs: 400,
  profilerIntervalUs: 100,
  longTaskMs: 50,
  paintTextMax: 200000
};

const BROWSER_CANDIDATES = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

export function parseViewport(text) {
  const raw = String(text || "").trim().toLowerCase().replace("×", "x");
  const m = raw.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) throw new Error(`Invalid viewport "${text}". Use WIDTHxHEIGHT, e.g. 1440x900.`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function formatViewport(vp) {
  return `${vp.width}x${vp.height}`;
}

function splitSuites(raw) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === "all") {
      for (const name of ALL_SUITES) if (!out.includes(name)) out.push(name);
      continue;
    }
    if (!SUITES.includes(part)) {
      throw new Error(`Unknown suite "${part}". Choose from: ${SUITES.join(", ")}, all`);
    }
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

export function parseConfig(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      suite: { type: "string", short: "s" },
      url: { type: "string" },
      viewport: { type: "string" },
      outdir: { type: "string" },
      browser: { type: "string" },
      "token-log": { type: "string" },
      switches: { type: "string" }
    }
  });

  const suiteRaw = values.suite || positionals[0] || "";
  const suites = suiteRaw ? splitSuites(suiteRaw) : [];
  if (positionals.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
  }

  const url = values.url || process.env.DSH_IDEA_PERF_URL || DEFAULTS.url;
  const viewport = parseViewport(
    values.viewport || process.env.DSH_IDEA_PERF_VIEWPORT || formatViewport(DEFAULTS.viewport)
  );
  const outdir = values.outdir || process.env.DSH_IDEA_PERF_OUTDIR || DEFAULTS.outdir;
  const browser = values.browser || process.env.DSH_IDEA_PERF_BROWSER || "";
  const tokenLog = values["token-log"] || process.env.DSH_IDEA_PERF_TOKEN_LOG || DEFAULTS.tokenLog;
  const switches = values.switches ? Number(values.switches) : DEFAULTS.switches;
  if (!Number.isInteger(switches) || switches < 2) {
    throw new Error("--switches must be an integer >= 2");
  }

  return {
    help: values.help === true,
    suites,
    url: url.replace(/\/+$/, ""),
    viewport,
    outdir,
    browser,
    browserCandidates: browser ? [browser, ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES,
    tokenLog,
    switches,
    switchGapMs: DEFAULTS.switchGapMs,
    settleMs: DEFAULTS.settleMs,
    profilerIntervalUs: DEFAULTS.profilerIntervalUs,
    longTaskMs: DEFAULTS.longTaskMs,
    paintTextMax: DEFAULTS.paintTextMax
  };
}

export const HELP = `dsh-idea performance harness

Usage (from plugins/dsh-idea):
  node scripts/perf/measure.mjs <suite[,suite...]> [options]
  node scripts/perf/measure.mjs --suite all

Suites:
  smoke              Connect to a running dsh web, list existing sessions, record markers
  session-switch     Right column closed; rapid session switches; warmup + steady long tasks
  chat-scroll        Scroll an existing transcript (not streaming output)
  editor-lifecycle   Open editor, collapse the right column, switch away and back
  git-run            Open then close Git and Run; assert polling stops
  large-file         Disposable mid / near / over-PAINT_TEXT_MAX files: open, scroll, find, type+undo
  all                Run every suite above, in that order

Options:
  --url <url>            Default http://127.0.0.1:3080     env DSH_IDEA_PERF_URL
  --viewport <WxH>       Default 1440x900                  env DSH_IDEA_PERF_VIEWPORT
  --outdir <dir>         Default /tmp/dsh-idea-perf        env DSH_IDEA_PERF_OUTDIR
  --browser <path>       Edge (preferred) or Chrome binary env DSH_IDEA_PERF_BROWSER
  --token-log <path>     Default ~/.dsh/dsh-web.log        env DSH_IDEA_PERF_TOKEN_LOG
  --switches <n>         Session clicks per round (default 7)
  -h, --help

Safety:
  Does not start or restart dsh web.
  Does not create sessions, send messages, open business repos, or save files.
  Tokens are read at runtime and never printed or written to results.
  Only the headless browser and temp profile created by this run are cleaned up.

Viewport:
  1440×900 is the validated size for session-switch conclusions. A run without
  an explicit viewport under-counts the conversation DOM and is invalid.
`;
