import { delay } from "../lib/cdp.mjs";
import { openRightColumn, openEditor, callPanel, snapshot, summarizeReqs } from "../lib/page.mjs";

export const name = "git-run";
export const description = "Open then close Git and Run; assert 15s / 700ms polling stops";

export async function run({ page, net }) {
  const openedRight = await openRightColumn(page);
  await openEditor(page);
  await delay(400);

  const git = await measurePanel(page, net, {
    name: "git",
    api: "__dshGitPanel",
    openWaitMs: 3000,
    graceMs: 800,
    pollWaitMs: 16000,
    watch: ["git/state", "git/log"]
  });

  const run = await measurePanel(page, net, {
    name: "run",
    api: "__dshRunPanel",
    openWaitMs: 2500,
    graceMs: 800,
    pollWaitMs: 4500,
    watch: ["run/list", "run/tail"]
  });

  const ok = git.pollStopped && run.pollStopped;
  return { ok, openedRight, git, run };
}

async function measurePanel(page, net, spec) {
  const openT = Date.now();
  const open = await callPanel(page, spec.api, "open");
  await delay(spec.openWaitMs);
  const afterOpen = pick(await snapshot(page));
  const reqsOpen = net.watched(openT).filter((r) => spec.watch.includes(r.watched));

  const close = await callPanel(page, spec.api, "close");
  await delay(spec.graceMs);
  const afterClose = pick(await snapshot(page));
  const pollT = Date.now();
  await delay(spec.pollWaitMs);
  const afterWait = pick(await snapshot(page));
  const reqsAfter = net.watched(pollT).filter((r) => spec.watch.includes(r.watched));
  const pollStopped = reqsAfter.length === 0;

  return {
    open,
    close,
    afterOpen,
    afterClose,
    afterWait,
    reqsWhileOpen: summarizeReqs(reqsOpen),
    reqsAfterClose: summarizeReqs(reqsAfter),
    pollWaitMs: spec.pollWaitMs,
    pollStopped
  };
}

function pick(ui) {
  return {
    rightOpen: ui.rightOpen,
    gitDock: ui.gitDock,
    runDock: ui.runDock,
    gitPane: ui.gitPane,
    runPane: ui.runPane,
    editorRoots: ui.editorRoots,
    build: ui.build,
    historyPump: ui.historyPump
  };
}

export function summarize(result) {
  const git = result.git || {};
  const run = result.run || {};
  return [
    `Git open then close + ${git.pollWaitMs}ms: after-close watched=${JSON.stringify((git.reqsAfterClose && git.reqsAfterClose.watched) || {})}  stopped=${git.pollStopped}`,
    `Run open then close + ${run.pollWaitMs}ms: after-close watched=${JSON.stringify((run.reqsAfterClose && run.reqsAfterClose.watched) || {})}  stopped=${run.pollStopped}`,
    result.ok
      ? "Git 15s and Run 700ms/list polling both stopped after close."
      : "Polling appeared after close — this is a regression against the current client behaviour."
  ];
}
