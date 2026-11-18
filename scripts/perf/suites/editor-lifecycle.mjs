import { delay } from "../lib/cdp.mjs";
import { openRightColumn, ensureRightClosed, openEditor, switchOnce, snapshot, summarizeReqs } from "../lib/page.mjs";

export const name = "editor-lifecycle";
export const description = "Open editor, collapse the right column, switch away and back while collapsed";

export async function run({ page, net }) {
  const openedRight = await openRightColumn(page);
  const afterRight = await snapshot(page);
  const editor = await openEditor(page);
  const afterOpen = await snapshot(page);

  const collapse = await ensureRightClosed(page);
  const afterCollapse = await snapshot(page);

  const t0 = Date.now();
  const away = await switchOnce(page, 2);
  const afterAway = await snapshot(page);
  const back = await switchOnce(page, 1);
  const afterBack = await snapshot(page);
  const reqs = net.plugin(t0);
  const watched = net.watched(t0);

  const treeKept = !!(afterCollapse.rootHasTree && afterBack.rootHasTree);
  const remounted = afterBack.idleRoots > 0 && afterCollapse.editorRoots > 0 && afterBack.editorRoots === 0;
  const unexpected = watched.filter((r) => r.watched === "git/state" || r.watched === "git/log");

  return {
    ok: treeKept && unexpected.length === 0,
    openedRight,
    afterRight: pick(afterRight),
    editor: { api: editor.api, waited: editor.waited, timeout: !!editor.timeout },
    afterOpen: pick(afterOpen),
    collapse,
    afterCollapse: pick(afterCollapse),
    away,
    afterAway: pick(afterAway),
    back,
    afterBack: pick(afterBack),
    treeKeptOnCollapse: !!afterCollapse.rootHasTree,
    treeKeptAfterSwitch: !!afterBack.rootHasTree,
    remounted,
    reqsWhileCollapsed: summarizeReqs(reqs),
    watchedWhileCollapsed: summarizeReqs(watched),
    unexpectedGitOrDir: unexpected.map((r) => r.path)
  };
}

function pick(ui) {
  return {
    rightOpen: ui.rightOpen,
    editorRoots: ui.editorRoots,
    idleRoots: ui.idleRoots,
    rootHasTree: ui.rootHasTree,
    paint: ui.paint,
    gitDock: ui.gitDock,
    runDock: ui.runDock,
    cwd: ui.cwd,
    build: ui.build,
    historyPump: ui.historyPump
  };
}

export function summarize(result) {
  return [
    `open right: ${result.openedRight && (result.openedRight.alreadyOpen || result.openedRight.open) ? "ok" : "failed"}  editor: ${result.afterOpen && result.afterOpen.editorRoots} root(s), tree=${result.afterOpen && result.afterOpen.rootHasTree}`,
    `after collapse: tree=${result.afterCollapse && result.afterCollapse.rootHasTree}  rightOpen=${result.afterCollapse && result.afterCollapse.rightOpen}`,
    `after switch away/back (still collapsed): tree=${result.afterBack && result.afterBack.rootHasTree}  remounted=${result.remounted}`,
    `plugin requests while collapsed: ${result.reqsWhileCollapsed && result.reqsWhileCollapsed.total}  watched git/run: ${JSON.stringify((result.watchedWhileCollapsed && result.watchedWhileCollapsed.watched) || {})}`,
    result.ok
      ? "Collapsed tree kept; no git/state or git/log while switching with the column collapsed."
      : "Check treeKept / unexpectedGitOrDir; a remount or extra git request is a regression."
  ];
}
