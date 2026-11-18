import { snapshot } from "../lib/page.mjs";

export const name = "smoke";
export const description = "Connect, list existing sessions, record build / historyPump / highlight rules";

export async function run({ page, loadInfo }) {
  const ui = await snapshot(page);
  const okHighlight = ui.highlightRules && ui.highlightRules.bare === 0 && ui.highlightRules.scoped > 0;
  return {
    ok: true,
    loadInfo,
    ui: {
      build: ui.build,
      historyPump: ui.historyPump,
      historyPumpStorage: ui.historyPumpStorage,
      viewport: ui.viewport,
      sessionRows: ui.sessionRows,
      nodes: ui.nodes,
      rightOpen: ui.rightOpen,
      highlightRules: ui.highlightRules,
      panel: ui.panel
    },
    notes: {
      highlightOk: okHighlight,
      historyPump: ui.historyPump,
      build: ui.build
    }
  };
}

export function summarize(result) {
  const ui = result.ui || {};
  const hl = ui.highlightRules || {};
  return [
    `sessions=${ui.sessionRows}  nodes=${ui.nodes}  viewport=${ui.viewport ? ui.viewport.w + "x" + ui.viewport.h : "?"}`,
    `build=${ui.build || "?"}  historyPump=${ui.historyPump || "?"}  highlight scoped=${hl.scoped ?? "?"} bare=${hl.bare ?? "?"}`
  ];
}
