#!/usr/bin/env node
/**
 * Reusable dsh-idea performance harness.
 *
 * From plugins/dsh-idea:
 *   node scripts/perf/measure.mjs smoke
 *   node scripts/perf/measure.mjs session-switch
 *   node scripts/perf/measure.mjs all
 *
 * Requires an already-running dsh web. Never creates sessions, never sends
 * messages, never saves files, never restarts the server, never prints tokens.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, HELP, formatViewport } from "./lib/config.mjs";
import { checkServer, readToken, launchSession, openApp, dshListenerPid, redactDeep, delay } from "./lib/cdp.mjs";
import { installHelpers, attachNetwork, snapshot } from "./lib/page.mjs";
import * as smoke from "./suites/smoke.mjs";
import * as sessionSwitch from "./suites/session-switch.mjs";
import * as chatScroll from "./suites/chat-scroll.mjs";
import * as editorLifecycle from "./suites/editor-lifecycle.mjs";
import * as gitRun from "./suites/git-run.mjs";
import * as largeFile from "./suites/large-file.mjs";

const SUITE_MODULES = {
  smoke,
  "session-switch": sessionSwitch,
  "chat-scroll": chatScroll,
  "editor-lifecycle": editorLifecycle,
  "git-run": gitRun,
  "large-file": largeFile
};

const TZ = "Asia/Shanghai";

function localStamp(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const file = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}`;
  return { iso: date.toISOString(), local, tz: TZ, file };
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(redactDeep(value), null, 2) + "\n");
}

function printSummary(report) {
  const lines = [];
  lines.push(`dsh-idea perf`);
  lines.push(`time       ${report.started.local} (${report.started.tz})`);
  lines.push(`url        ${report.url}`);
  lines.push(`viewport   ${formatViewport(report.viewport)}  (required; session-switch is invalid without it)`);
  lines.push(`build      ${report.build || "?"}  historyPump=${report.historyPump || "?"}`);
  const hl = report.highlightRules || {};
  lines.push(`highlight  scoped=${hl.scoped ?? "?"}  bare=${hl.bare ?? "?"}  (expect scoped>0, bare=0)`);
  lines.push(`dsh pid    start=${report.dshPidStart || "?"}  end=${report.dshPidEnd || "?"}${report.dshPidStart && report.dshPidEnd && report.dshPidStart !== report.dshPidEnd ? "  WARNING: listener pid changed; this harness did not restart dsh web" : ""}`);
  lines.push(`results    ${report.runDir}`);
  lines.push("");
  for (const suite of report.suites) {
    const status = suite.error ? "FAIL" : suite.result && suite.result.skipped ? "SKIP" : suite.result && suite.result.ok === false ? "FAIL" : "ok";
    lines.push(`── ${suite.name}  ${status}  ${suite.ms}ms`);
    const mod = SUITE_MODULES[suite.name];
    if (suite.error) {
      lines.push("  " + suite.error.split("\n")[0]);
    } else if (mod && typeof mod.summarize === "function") {
      for (const line of mod.summarize(suite.result) || []) lines.push("  " + line);
    }
    lines.push("");
  }
  lines.push("Long tasks are PerformanceObserver longtask ≥50ms. Use warmup only to settle; conclusions come from later rounds.");
  lines.push("Plugin SELF is CPU-profile SELF at 100µs, and only non-combo /plugins/dsh-idea/ URLs. Combo /plugins/??...&rev=... frames are host time.");
  lines.push("This run did not start or restart dsh web, create a session, send a message, or save a file.");
  console.log(lines.join("\n"));
}

async function main() {
  if (typeof WebSocket === "undefined") {
    throw new Error("This harness needs a built-in WebSocket (Node 22+). Current: " + process.version);
  }
  let config;
  try {
    config = parseConfig();
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    console.error("");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (config.help || config.suites.length === 0) {
    console.log(HELP);
    process.exitCode = config.help || config.suites.length === 0 ? 0 : 1;
    return;
  }

  const started = localStamp();
  const runDir = join(config.outdir, started.file);
  config.runDir = runDir;
  await mkdir(runDir, { recursive: true });

  const probe = await checkServer(config.url);
  const token = readToken(config.tokenLog);
  const dshPidStart = dshListenerPid(config.url);

  const report = {
    started,
    url: config.url,
    viewport: config.viewport,
    outdir: config.outdir,
    runDir,
    serverProbe: probe,
    dshPidStart,
    suites: []
  };

  let page;
  const net = { stop() {} };
  let failed = false;
  try {
    page = await launchSession(config);
    const liveNet = attachNetwork(page);
    Object.assign(net, liveNet);
    const loadInfo = await openApp(page, config, token);
    const helpers = await installHelpers(page);
    const ui0 = await snapshot(page);
    report.loadInfo = loadInfo;
    report.helpers = helpers;
    report.build = ui0.build;
    report.historyPump = ui0.historyPump;
    report.highlightRules = ui0.highlightRules;
    report.browserPath = page.browserPath;

    for (const name of config.suites) {
      const mod = SUITE_MODULES[name];
      const t0 = Date.now();
      const entry = { name, description: mod.description, startedAt: localStamp().local };
      try {
        const result = await mod.run({ page, config, net: liveNet, loadInfo });
        entry.result = result;
        entry.ms = Date.now() - t0;
        if (result && result.ok === false) failed = true;
        await writeJson(join(runDir, `${name}.json`), entry);
      } catch (err) {
        failed = true;
        entry.error = String(err && err.stack ? err.stack : err);
        entry.ms = Date.now() - t0;
        await writeJson(join(runDir, `${name}.json`), entry);
      }
      report.suites.push(entry);
    }

    try {
      const uiN = await snapshot(page);
      report.build = uiN.build || report.build;
      report.historyPump = uiN.historyPump || report.historyPump;
      report.highlightRules = uiN.highlightRules || report.highlightRules;
    } catch {}
  } catch (err) {
    failed = true;
    report.error = String(err && err.stack ? err.stack : err);
  } finally {
    try { net.stop(); } catch {}
    if (page) {
      try { await page.close(); } catch {}
    } else {
      await delay(50);
    }
  }

  report.dshPidEnd = dshListenerPid(config.url);
  report.finished = localStamp();
  report.ok = !failed && !report.error;
  await writeJson(join(runDir, "results.json"), report);
  printSummary(report);
  if (report.error) console.error("\n" + report.error.split("\n")[0]);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((err) => {
  console.error("MEASURE_FAILED", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
