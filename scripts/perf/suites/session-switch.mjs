import { delay } from "../lib/cdp.mjs";
import { ensureRightClosed, switchRound, snapshot, profileAction, formatLt } from "../lib/page.mjs";

export const name = "session-switch";
export const description = "Right column closed; rapid switches of existing sessions; warmup + steady long tasks";

export async function run({ page, config }) {
  const closed = await ensureRightClosed(page);
  await delay(300);
  const before = await snapshot(page);

  const warmup = await switchRound(page, config);
  await delay(500);

  const steady = [];
  const first = await profileAction(page, () => switchRound(page, config), config.profilerIntervalUs);
  steady.push({ ...first.result, profile: first.profile, kind: "steady-1" });
  await delay(400);
  const second = await switchRound(page, config);
  steady.push({ ...second, kind: "steady-2" });

  const after = await snapshot(page);
  const closedNetwork = after.rightOpen === true ? "right-column-still-open" : "ok";

  return {
    ok: !after.rightOpen,
    warning: after.rightOpen ? "Right column was still open; session-switch numbers may not match the closed-column baseline." : undefined,
    closed,
    closedNetwork,
    before: pickUi(before),
    after: pickUi(after),
    warmup: packRound(warmup, "warmup"),
    steady: steady.map((r) => packRound(r, r.kind))
  };
}

function pickUi(ui) {
  return {
    build: ui.build,
    historyPump: ui.historyPump,
    highlightRules: ui.highlightRules,
    viewport: ui.viewport,
    nodes: ui.nodes,
    sessionRows: ui.sessionRows,
    rightOpen: ui.rightOpen,
    editorRoots: ui.editorRoots
  };
}

function packRound(round, kind) {
  return {
    kind,
    count: round.count,
    clicksOk: (round.clicks || []).filter((c) => c.ok).length,
    longTasks: round.longTasks,
    profile: round.profile
      ? { pluginSelfSum: round.profile.pluginSelfSum, pluginSelf: round.profile.pluginSelf, hostTop: round.profile.hostTop }
      : undefined
  };
}

export function summarize(result) {
  const lines = [];
  const ui = result.after || result.before || {};
  lines.push(`historyPump=${ui.historyPump || "?"}  highlight scoped=${ui.highlightRules && ui.highlightRules.scoped} bare=${ui.highlightRules && ui.highlightRules.bare}  rightOpen=${ui.rightOpen}`);
  if (result.warning) lines.push("warning: " + result.warning);
  lines.push(`warmup     ${formatLt(result.warmup && result.warmup.longTasks)}  (ignored for conclusions)`);
  for (const row of result.steady || []) {
    const self = row.profile ? `  plugin SELF=${row.profile.pluginSelfSum}ms` : "";
    lines.push(`${row.kind.padEnd(10)} ${formatLt(row.longTasks)}${self}`);
  }
  lines.push("Use the steady rounds, not warmup. Plugin SELF excludes combo /plugins/??...&rev=... host frames.");
  return lines;
}
