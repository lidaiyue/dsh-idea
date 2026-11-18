import { delay } from "../lib/cdp.mjs";
import { ensureRightClosed, mark, slice, snapshot, profileAction, scrollExistingTranscript, formatLt, listChatScrollersExpr } from "../lib/page.mjs";

export const name = "chat-scroll";
export const description = "Scroll an existing transcript (not streaming)";

export async function run({ page, config }) {
  await ensureRightClosed(page);
  await delay(200);
  const scrollers = await page.evaluate(listChatScrollersExpr());
  if (!scrollers || scrollers.length === 0) {
    return { ok: true, skipped: true, reason: "No scrollable transcript container found on this page." };
  }

  const runOnce = async (kind, withProfile) => {
    const from = await mark(page);
    let info;
    let profile;
    if (withProfile) {
      const wrap = await profileAction(page, () => scrollExistingTranscript(page), config.profilerIntervalUs);
      info = wrap.result;
      profile = wrap.profile;
    } else {
      info = await scrollExistingTranscript(page);
    }
    await delay(400);
    return { kind, info, longTasks: await slice(page, from), profile: profile && { pluginSelfSum: profile.pluginSelfSum, pluginSelf: profile.pluginSelf } };
  };

  const warmup = await runOnce("warmup", false);
  const steady = [await runOnce("steady-1", true), await runOnce("steady-2", false)];
  const ui = await snapshot(page);
  return {
    ok: true,
    note: "Existing transcript only; no message was sent, so this is not a streaming-output test.",
    scrollers: scrollers.slice(0, 6),
    ui: { build: ui.build, historyPump: ui.historyPump, nodes: ui.nodes, viewport: ui.viewport },
    warmup,
    steady
  };
}

export function summarize(result) {
  if (result.skipped) return [`skipped: ${result.reason}`];
  const lines = [
    result.note,
    `scroller sh=${result.warmup && result.warmup.info && result.warmup.info.sh} ch=${result.warmup && result.warmup.info && result.warmup.info.ch}`,
    `warmup     ${formatLt(result.warmup && result.warmup.longTasks)}  (ignored for conclusions)`
  ];
  for (const row of result.steady || []) {
    const self = row.profile ? `  plugin SELF=${row.profile.pluginSelfSum}ms` : "";
    lines.push(`${row.kind.padEnd(10)} ${formatLt(row.longTasks)}${self}`);
  }
  return lines;
}
