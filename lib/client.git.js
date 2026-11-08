// dsh-git-manager — browser half (module-loader bundle)

window.__ModuleLoader__.load({
  id: "dsh-idea",
  chunk: "client.git.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let React = require("react");
    if (React === null || typeof React !== "object") throw new Error("dsh-git-manager: react is unavailable");
    if (React.useState === undefined && React.default !== undefined && typeof React.default === "object") React = React.default;

    let createRoot;
    let createPortal;
    try {
      const rdc = require("react-dom/client");
      if (rdc !== null && typeof rdc === "object") createRoot = rdc.createRoot;
    } catch {}
    try {
      const rd = require("react-dom");
      if (rd !== null && typeof rd === "object") {
        if (typeof rd.createPortal === "function") createPortal = rd.createPortal;
        if (typeof createRoot !== "function") {
          createRoot = (el) => ({
            render: (node) => rd.render(node, el),
            unmount: () => { try { rd.unmountComponentAtNode(el); } catch {} }
          });
        }
      }
    } catch {}

    const PLUGIN = "dsh-git-manager";
    const STATE_PATH = "/plugins/dsh-idea/git/state";
    const REPOS_PATH = "/plugins/dsh-idea/git/repos";
    const REPO_STORE = "dsh.git-manager.repo.";
    const PIN_STORE = "dsh.git-manager.repoPin.";
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
    const INIT_PATH = "/plugins/dsh-idea/git/init";
    const DIFF_TAB_ID = "dsh-git-manager/diff";
    const DIFF_KIND = "git-diff";
    const DIFF_PREFIX = "dsh-resource://git-diff/session/";
    const COMMIT_PATH = "/plugins/dsh-idea/git/commit";
    const ROLLBACK_PATH = "/plugins/dsh-idea/git/rollback";
    const PUSH_PATH = "/plugins/dsh-idea/git/push";
    const MESSAGE_PATH = "/plugins/dsh-idea/git/generate-message";
    const BRANCH_W_KEY = "dsh.git-manager.branchw";
    const FILE_PREFIX = "dsh-resource://file/";
    const ROW_H = 26;
    const DEFAULT_BRANCH_W = 220;
    const COMMIT_TREE_W_KEY = "dsh.git-manager.commitTreeW";
    const DEFAULT_COMMIT_TREE_W = 360;
    // The commit detail pane sits to the RIGHT of the log now, so it is sized in
    // pixels of width rather than a fraction of the height. New key: the old
    // `detailh.v2` value was a fraction and must not be read as a width.
    const DETAIL_W_KEY = "dsh.git-manager.detailw";
    const DEFAULT_DETAIL_W = 320;
    const DETAIL_MIN_W = 200;
    const DETAIL_MAX_W = 720;
    // The panel is a dock under the editor now, not a workspace of its own.
    // Its open state rides on a document attribute the editor reads in CSS, so
    // the editor chunk never has to import this one's store.
    const DOCK_KEY = "dsh.git-manager.dock";
    const DOCK_ATTR = "dshGitDock";
    // The commit window needs the height the log list does not: the dock grows
    // while it is open and falls back to the user's own height afterwards.
    const TALL_ATTR = "dshGitTall";

/* @diffjump-start */
const DIFF_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Where every row of a unified diff sits in the file, so a diff view can answer
 * "which line is the reader looking at".
 *
 * `rows[i]` describes the i-th line of the diff, file headers included: `kind`
 * is the diff marker the row is painted with, `newLine` the 1-based line of the
 * new file the row stands for (0 outside a hunk). A removed row carries the
 * position the following line takes once the change lands, so a jump never
 * overshoots by the length of the deletion.
 *
 * `hunks[j]` names the two edges of one `@@` block: `headerRow` is the `@@`
 * row, `firstRow` / `lastRow` the block it introduces, so a viewport can pick
 * the block it is showing. `changeRow` is the first added row of the block (or
 * the first removed one when the block only deletes) and `changeLine` its
 * new-side line.
 */
function diffGeometry(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (raw.trim() === "") return { rows: [], hunks: [] };
  const lines = raw.replace(/\n$/, "").split("\n");
  const rows = [];
  const hunks = [];
  let oldLine = 0;
  let newLine = 0;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = DIFF_HUNK_HEADER.exec(line);
    if (head !== null) {
      oldLine = Number(head[1]);
      newLine = Number(head[3]);
      at = hunks.length;
      hunks.push({
        headerRow: i,
        firstRow: i + 1,
        lastRow: i,
        newStart: newLine,
        addRow: -1,
        addLine: 0,
        delRow: -1,
        delLine: 0,
        changeRow: i,
        changeLine: newLine
      });
      rows.push({ kind: "@", oldLine: 0, newLine: 0 });
      continue;
    }
    if (at < 0) {
      rows.push({ kind: "h", oldLine: 0, newLine: 0 });
      continue;
    }
    const hunk = hunks[at];
    const mark = line.charAt(0);
    if (mark === "\\") {
      // "\ No newline at end of file" belongs to the line before it.
      rows.push({ kind: "\\", oldLine: 0, newLine: 0 });
      continue;
    }
    if (mark === "+") {
      rows.push({ kind: "+", oldLine: 0, newLine });
      if (hunk.addRow < 0) {
        hunk.addRow = i;
        hunk.addLine = newLine;
      }
      newLine += 1;
    } else if (mark === "-") {
      rows.push({ kind: "-", oldLine, newLine });
      if (hunk.delRow < 0) {
        hunk.delRow = i;
        hunk.delLine = newLine;
      }
      oldLine += 1;
    } else {
      rows.push({ kind: " ", oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
    hunk.lastRow = i;
  }
  for (let j = 0; j < hunks.length; j++) {
    const hunk = hunks[j];
    if (hunk.addRow >= 0) {
      hunk.changeRow = hunk.addRow;
      hunk.changeLine = hunk.addLine;
    } else if (hunk.delRow >= 0) {
      hunk.changeRow = hunk.delRow;
      hunk.changeLine = hunk.delLine;
    }
    if (hunk.changeLine < 1) hunk.changeLine = 1;
  }
  return { rows, hunks };
}

/**
 * New-side line of the hunk nearest `row` — a 0-based row of the diff, usually
 * the row at the viewport centre. 0 when the diff carries no hunk at all.
 */
function diffLineAt(hunks, row) {
  const list = Array.isArray(hunks) ? hunks : [];
  if (list.length === 0) return 0;
  const want = Number.isFinite(Number(row)) ? Number(row) : 0;
  let best = list[0];
  let bestGap = Infinity;
  for (let i = 0; i < list.length; i++) {
    const hunk = list[i];
    let gap = 0;
    if (want < hunk.headerRow) gap = hunk.headerRow - want;
    else if (want > hunk.lastRow) gap = want - hunk.lastRow;
    if (gap < bestGap) {
      bestGap = gap;
      best = hunk;
      if (gap === 0) break;
    }
  }
  return best.changeLine;
}
/* @diffjump-end */

    const I18N = {
      zh: {
        title: "Git",
        filesWorkspace: "文件",
        editorWorkspace: "编辑器",
        showPanel: "显示 Git 面板 ({key})",
        repoSwitch: "切换仓库",
        search: "文本或哈希",
        branch: "分支",
        user: "用户",
        date: "日期",
        all: "全部",
        today: "今天",
        week: "最近 7 天",
        month: "最近 30 天",
        local: "Local",
        remote: "Remote",
        tags: "Tags",
        head: "HEAD (Current Branch)",
        empty: "没有提交",
        noRepo: "当前工作区不是 Git 仓库",
        noWorkspace: "当前会话没有工作区",
        noSession: "没有打开的会话",
        loading: "正在读取 Git…",
        checkout: "正在切换分支…",
        checkoutFail: "切换失败",
        checkoutStashed: "已暂存本地更改并切换",
        checkoutDirty: "本地更改会被覆盖，请先提交或暂存后再切换",
        pullDirty: "本地更改会被拉取覆盖，请先提交或暂存",
        stashConflict: "操作已完成，但恢复本地更改时发生冲突，改动仍保存在 stash",
        dirty: "未提交更改",
        refresh: "刷新",
        collapse: "折叠",
        expand: "展开",
        files: "变更文件",
        parents: "父提交",
        doubleCheckout: "双击检出",
        copied: "已复制哈希",
        pull: "拉取",
        pulling: "正在 git pull…",
        pullOk: "已拉取",
        pullFail: "拉取失败",
        merge: "合并到当前分支",
        merging: "正在合并…",
        mergeOk: "已合并",
        mergeFail: "合并失败",
        checkoutMenu: "检出",
        deleteBranch: "删除分支",
        deleteRemote: "删除远程分支",
        deleteConfirm: "确定删除分支 {name}？未合并的提交可能丢失。",
        deleteOk: "已删除",
        deleteFail: "删除失败",
        deleteCurrent: "不能删除当前分支",
        noDiff: "没有内容变更",
        diffTitle: "变更",
        jumpSource: "在编辑器中打开变更行 ({key})",
        jumpFail: "无法打开该文件",
        jumpMissing: "该文件已不在工作区（已删除或重命名）",
        commitTitle: "提交",
        changes: "更改",
        unversioned: "未跟踪",
        fileUnit: "",
        commitMsg: "提交说明",
        commitBtn: "Commit",
        commitPush: "Commit and Push",
        committing: "正在提交…",
        genMessage: "生成提交信息",
        genWorking: "正在生成…",
        genOk: "已生成提交信息",
        genFail: "生成失败",
        genNoChanges: "没有可提交的变更",
        amend: "修补上次提交",
        amendTitle: "修补上一次提交并编辑其说明",
        push: "推送",
        pushing: "正在推送…",
        commitOk: "已提交",
        pushOk: "已推送",
        commitFail: "提交失败",
        pushFail: "推送失败",
        noFiles: "请选择要提交的文件",
        noMessage: "请填写提交说明",
        rollbackTitle: "回滚更改",
        rollbackFiles: "{n} 个文件",
        rollbackUntracked: "删除未跟踪文件",
        rollbackConfirm: "确定回滚 {name}？更改将无法恢复。",
        rollbackConfirmMany: "确定回滚选中的 {n} 个文件？更改将无法恢复。",
        rollbackUntrackedConfirm: "确定删除未跟踪文件 {name}？",
        rollingBack: "正在回滚…",
        rollbackOk: "已回滚 {n} 个文件",
        rollbackOkOne: "已回滚 {name}",
        rollbackFail: "回滚失败",
        rollbackDirBlocked: "回滚 {name} 会删除同名目录中的未跟踪文件，已取消",
        back: "返回历史",
        resizeTree: "拖动调整目录宽度",
        prevFile: "上一个文件",
        nextFile: "下一个文件",
        cherry: "Cherry-pick 到当前分支",
        cherrying: "正在 cherry-pick…",
        cherryOk: "已 cherry-pick",
        cherryFail: "Cherry-pick 失败",
        cherryNeed: "请先选择一条历史提交",
        cherryWorking: "不能 cherry-pick 未提交更改",
        cherrySame: "这条就是当前 HEAD",
        tabFiles: "文件变更",
        tabMessage: "提交说明",
        newBranch: "新建分支",
        newBranchTitle: "新建分支",
        newBranchFrom: "基于",
        newBranchName: "分支名",
        newBranchPlaceholder: "例如 feature/login",
        newBranchHint: "从 {from} 创建并检出",
        createBranchBtn: "创建",
        creating: "正在创建分支…",
        createOk: "已创建分支",
        createFail: "创建分支失败",
        branchRequired: "请填写分支名",
        branchInvalid: "分支名不合法",
        branchTooLong: "分支名过长",
        branchExists: "分支已存在",
        initRepo: "初始化 Git 仓库",
        initRepoDesc: "当前工作区还不是 Git 仓库，可以在这里执行 git init。",
        initRepoHint: "将在当前工作区创建 .git 目录",
        initBtn: "git init",
        initing: "正在初始化…",
        initOk: "已初始化 Git 仓库",
        initFail: "初始化失败",
        cancel: "取消",
        renameBranch: "重命名分支",
        renameTitle: "重命名分支",
        renameBtn: "重命名",
        renaming: "正在重命名…",
        renameOk: "已重命名分支",
        renameFail: "重命名失败",
        branchSame: "名称没有变化",
        branchMissing: "分支不存在",
        conflictMerge: "合并冲突",
        conflictCherry: "Cherry-pick 冲突",
        conflictRevert: "Revert 冲突",
        conflictRebase: "变基冲突",
        conflictHint: "请解决冲突文件后继续，或中止本次操作。",
        opContinue: "继续",
        opAbort: "中止",
        opWorking: "正在处理…",
        opOk: "已完成",
        opAbortOk: "已中止",
        opFail: "操作失败",
        noOperation: "当前没有进行中的操作"
      },
      en: {
        title: "Git",
        filesWorkspace: "Files",
        editorWorkspace: "Editor",
        showPanel: "Show the Git panel ({key})",
        repoSwitch: "Switch repository",
        search: "Text or hash",
        branch: "Branch",
        user: "User",
        date: "Date",
        all: "All",
        today: "Today",
        week: "Last 7 days",
        month: "Last 30 days",
        local: "Local",
        remote: "Remote",
        tags: "Tags",
        head: "HEAD (Current Branch)",
        empty: "No commits",
        noRepo: "This workspace is not a Git repository",
        noWorkspace: "This session has no workspace",
        noSession: "No session is open",
        loading: "Reading Git…",
        checkout: "Checking out…",
        checkoutFail: "Checkout failed",
        checkoutStashed: "Stashed local changes and switched",
        checkoutDirty: "Local changes would be overwritten. Commit or stash them before switching.",
        pullDirty: "Local changes would be overwritten by pull. Commit or stash them first.",
        stashConflict: "Finished, but restoring local changes conflicted. They are still in the stash.",
        dirty: "Uncommitted changes",
        refresh: "Refresh",
        collapse: "Collapse",
        expand: "Expand",
        files: "Changed files",
        parents: "Parents",
        doubleCheckout: "Double-click to check out",
        copied: "Copied hash",
        pull: "Pull",
        pulling: "git pull…",
        pullOk: "Pulled",
        pullFail: "Pull failed",
        merge: "Merge into current branch",
        merging: "Merging…",
        mergeOk: "Merged",
        mergeFail: "Merge failed",
        checkoutMenu: "Check out",
        deleteBranch: "Delete branch",
        deleteRemote: "Delete remote branch",
        deleteConfirm: "Delete branch {name}? Unmerged commits may be lost.",
        deleteOk: "Deleted",
        deleteFail: "Delete failed",
        deleteCurrent: "Cannot delete the current branch",
        noDiff: "No content changes",
        diffTitle: "Diff",
        jumpSource: "Open the change in the editor ({key})",
        jumpFail: "Could not open that file",
        jumpMissing: "That file is no longer in the working tree (deleted or renamed)",
        commitTitle: "Commit",
        changes: "Changes",
        unversioned: "Unversioned Files",
        fileUnit: "files",
        commitMsg: "Commit Message",
        commitBtn: "Commit",
        commitPush: "Commit and Push",
        committing: "Committing…",
        genMessage: "Generate commit message",
        genWorking: "Generating…",
        genOk: "Commit message generated",
        genFail: "Generation failed",
        genNoChanges: "No changes to commit",
        amend: "Amend last commit",
        amendTitle: "Amend the last commit and edit its message",
        push: "Push",
        pushing: "Pushing…",
        commitOk: "Committed",
        pushOk: "Pushed",
        commitFail: "Commit failed",
        pushFail: "Push failed",
        noFiles: "Select files to commit",
        noMessage: "Enter a commit message",
        rollbackTitle: "Rollback changes",
        rollbackFiles: "{n} files",
        rollbackUntracked: "Delete untracked file",
        rollbackConfirm: "Roll back {name}? These changes cannot be recovered.",
        rollbackConfirmMany: "Roll back the {n} selected files? These changes cannot be recovered.",
        rollbackUntrackedConfirm: "Delete the untracked file {name}?",
        rollingBack: "Rolling back…",
        rollbackOk: "Rolled back {n} files",
        rollbackOkOne: "Rolled back {name}",
        rollbackFail: "Rollback failed",
        rollbackDirBlocked: "Rolling back {name} would delete untracked files in a same-named directory; cancelled",
        back: "Back to log",
        resizeTree: "Drag to resize the file tree",
        prevFile: "Previous file",
        nextFile: "Next file",
        cherry: "Cherry-pick onto current branch",
        cherrying: "Cherry-picking…",
        cherryOk: "Cherry-picked",
        cherryFail: "Cherry-pick failed",
        cherryNeed: "Select a commit first",
        cherryWorking: "Cannot cherry-pick uncommitted changes",
        cherrySame: "That commit is already HEAD",
        tabFiles: "Changed files",
        tabMessage: "Commit message",
        newBranch: "New branch",
        newBranchTitle: "New Branch",
        newBranchFrom: "From",
        newBranchName: "Branch name",
        newBranchPlaceholder: "e.g. feature/login",
        newBranchHint: "Create and check out from {from}",
        createBranchBtn: "Create",
        creating: "Creating branch…",
        createOk: "Branch created",
        createFail: "Create branch failed",
        branchRequired: "Enter a branch name",
        branchInvalid: "Invalid branch name",
        branchTooLong: "Branch name is too long",
        branchExists: "Branch already exists",
        initRepo: "Initialize Git repository",
        initRepoDesc: "This workspace is not a Git repository yet. You can run git init here.",
        initRepoHint: "Creates a .git directory in the current workspace",
        initBtn: "git init",
        initing: "Initializing…",
        initOk: "Git repository initialized",
        initFail: "Init failed",
        cancel: "Cancel",
        renameBranch: "Rename branch",
        renameTitle: "Rename Branch",
        renameBtn: "Rename",
        renaming: "Renaming…",
        renameOk: "Branch renamed",
        renameFail: "Rename failed",
        branchSame: "The name is unchanged",
        branchMissing: "Branch does not exist",
        conflictMerge: "Merge conflict",
        conflictCherry: "Cherry-pick conflict",
        conflictRevert: "Revert conflict",
        conflictRebase: "Rebase conflict",
        conflictHint: "Resolve the conflicted files and continue, or abort this operation.",
        opContinue: "Continue",
        opAbort: "Abort",
        opWorking: "Working…",
        opOk: "Done",
        opAbortOk: "Aborted",
        opFail: "Operation failed",
        noOperation: "No operation in progress"
      }
    };

    const STYLE = [
      // The Git panel is a dock inside the editor page now: it has no host on the
      // panel, no strip of its own, and no standalone workspace. The editor body
      // reserves the pane it fills, so the only rule it needs is its own box.
      ".dgit-host{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary)}",
      ".dgit-host .dgit-detail{min-width:220px}",
      ".dgit-shell{flex:auto;min-height:0;height:100%;display:flex;flex-direction:column;min-width:0;position:relative}",
      ".dgit-bar{flex:none;height:32px;display:flex;align-items:center;gap:8px;padding:0 8px 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.06))}",
      ".dgit-title{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}",
      ".dgit-branchchip{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-repo{height:22px;max-width:148px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4,transparent);background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));color:inherit;font:inherit;font-size:12px;padding:0 4px}",
      ".dgit-dirty{width:7px;height:7px;border-radius:99px;background:#e0b040;flex:none}",
      ".dgit-spacer{flex:auto}",
      ".dgit-iconbtn{appearance:none;background:transparent;border:0;width:26px;height:26px;border-radius:7px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
      ".dgit-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      // Icon-only toolbar actions. Native `title` waits ~1s and is easy to miss,
      // so the label floats under the button on hover. The tools row sits above
      // the commit list; without that z-index the tip is painted underneath it.
      // Anchored to the button's right edge so a long label stays inside the column.
      ".dgit-tools{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.06));min-height:34px;position:relative;z-index:4}",
      ".dgit-tip{position:relative}",
      ".dgit-tip[data-tip]::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);right:0;z-index:5;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#2c2f33);color:var(--dsw-alias-label-primary,#fff);border:1px solid var(--dsw-alias-border-l4,rgba(255,255,255,.14));box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:12px;font-weight:400;line-height:1.35;letter-spacing:0;white-space:nowrap;pointer-events:none;opacity:0;transform:translateY(-2px);transition:opacity .12s ease,transform .12s ease}",
      ".dgit-tip[data-tip]:hover::after,.dgit-tip[data-tip]:focus-visible::after{opacity:1;transform:translateY(0);transition-delay:.12s}",
      ".dgit-search{flex:1;min-width:120px;height:26px;display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));border:1px solid var(--dsw-alias-border-l4,transparent)}",
      ".dgit-search input{flex:1;min-width:0;height:24px;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:12px}",
      ".dgit-search input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".dgit-sel{height:26px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));border:1px solid var(--dsw-alias-border-l4,transparent);color:inherit;font:inherit;font-size:12px;padding:0 8px;max-width:160px}",
      ".dgit-body{flex:auto;min-height:0;display:flex}",
      ".dgit-left{flex:none;width:var(--dgit-bw,220px);min-width:140px;max-width:46%;border-right:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.06));display:flex;flex-direction:column;min-height:0}",
      ".dgit-bsplit{flex:none;width:5px;cursor:ew-resize;margin-right:-2px;z-index:2}",
      ".dgit-bsplit:hover{background:var(--dsw-alias-link,#3d6fd9)}",
      ".dgit-bsearch{flex:none;margin:6px 8px;height:26px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.04));border:1px solid var(--dsw-alias-border-l4,transparent);padding:0 8px;color:inherit;font:inherit;font-size:12px}",
      ".dgit-btree{flex:auto;min-height:0;overflow:auto;padding:4px 0 8px}",
      ".dgit-sec{padding:8px 10px 3px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}",
      ".dgit-brow{width:100%;display:flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;padding:3px 10px 3px 18px;cursor:pointer;border-radius:0}",
      ".dgit-brow:hover,.dgit-brow[data-on=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dgit-brow[data-current=true]{color:#e0b040}",
      ".dgit-dot{width:8px;height:8px;border-radius:99px;flex:none;background:#59b35a}",
      ".dgit-bname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-right{flex:auto;min-width:0;min-height:0;display:flex;flex-direction:row}",
      ".dgit-table{flex:auto;min-width:0;min-height:80px;overflow:auto}",
      ".dgit-row{display:grid;grid-template-columns:minmax(0,1fr) 120px 148px;align-items:stretch;height:" + ROW_H + "px;cursor:pointer}",
      ".dgit-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04))}",
      ".dgit-row[data-on=true]{background:rgba(61,111,217,.22)}",
      ".dgit-msg{min-width:0;display:flex;align-items:center;gap:8px;padding:0 10px;font-size:12.5px}",
      ".dgit-subj{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-author,.dgit-date{display:flex;align-items:center;padding:0 10px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dgit-pill{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:3px;font-size:11px;background:rgba(89,179,90,.18);color:#8fd48f}",
      ".dgit-pill[data-k=remote]{background:rgba(181,126,220,.18);color:#d2b3ee}",
      ".dgit-pill[data-k=tag]{background:rgba(224,176,64,.18);color:#e8c56a}",
      ".dgit-pill[data-k=head]{background:rgba(91,155,213,.2);color:#9cc4ea}",
      ".dgit-status,.dgit-empty{flex:auto;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:16px}",
      ".dgit-detail{flex:none;align-self:stretch;width:var(--dgit-detail-w,320px);min-width:200px;min-height:0;max-width:60%;border-left:.5px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;position:relative;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}",
      ".dgit-detail-handle{position:absolute;top:0;bottom:0;left:-4px;width:8px;cursor:col-resize;z-index:4;background:transparent}",
      ".dgit-dtabs{flex:none;display:flex;align-items:center;gap:2px;padding:4px 8px 0;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06))}",
      ".dgit-dtab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;height:24px;padding:0 10px;border-radius:6px 6px 0 0;cursor:pointer}",
      ".dgit-dtab:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}",
      ".dgit-dtab[data-on=true]{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.04))}",
      ".dgit-dbody{flex:auto;min-height:0;overflow:hidden;display:flex;flex-direction:column}",
      ".dgit-dmeta{min-height:0;padding:8px 12px;font-size:12px;white-space:pre-wrap;line-height:1.5;overflow:auto}",
      ".dgit-dfiles{flex:auto;min-height:72px;overflow:auto;padding:4px 0;outline:none}",
      ".dgit-detail[data-diff=\"1\"] .dgit-dfiles{flex:none;max-height:34%}",
      ".dgit-detail[data-diff=\"1\"] .dgit-diff{flex:auto;min-height:120px}",
      ".dgit-frow{width:100%;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;padding:3px 12px;cursor:pointer;outline:none}",
      ".dgit-frow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dgit-frow[data-on=true],.dgit-frow[data-on=true]:hover{background:rgba(61,111,217,.22)}",
      ".dgit-fst{width:16px;flex:none;font-weight:600;font-size:11px}",
      ".dgit-fst[data-s=A],.dgit-fst[data-s=C]{color:#59b35a}",
      ".dgit-fst[data-s=D]{color:#e07a5f}",
      ".dgit-fst[data-s=M],.dgit-fst[data-s=R]{color:#5b9bd5}",
      ".dgit-diff{flex:auto;min-height:0;overflow:auto;border-top:.5px solid var(--dsw-alias-border-l3);font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.45;padding:6px 0;margin:0}",
      ".dgit-diffplain{padding:6px 12px;white-space:pre}",
      ".dgit-dl{display:block;white-space:pre;padding:0 12px}",
      ".dgit-dl[data-k=\"+\"]{background:rgba(89,179,90,.12);color:#8fd48f}",
      ".dgit-dl[data-k=\"-\"]{background:rgba(224,122,95,.14);color:#e07a5f}",
      ".dgit-dl[data-k=\"@\"]{color:#5b9bd5}",
      ".dgit-dl[data-k=\"h\"]{color:var(--dsw-alias-label-tertiary)}",
      ".dgit-menu{position:fixed;z-index:280;min-width:168px;padding:6px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.12));box-shadow:0 10px 32px rgba(0,0,0,.16)}",
      ".dgit-menu button{width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;border-radius:8px;padding:7px 10px;cursor:pointer}",
      ".dgit-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dgit-menuhead{padding:4px 10px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}",
      ".dgit-commit{flex:auto;min-height:0;display:flex;flex-direction:column}",
      ".dgit-chead{flex:none;display:flex;align-items:center;gap:8px;height:32px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));font-size:12px;font-weight:600}",
      ".dgit-cmain{flex:auto;min-height:0;display:flex}",
      ".dgit-ctree{flex:none;min-width:120px;max-width:70%;overflow:auto;overflow-x:hidden;padding:4px 6px 8px;border-right:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06))}",
      ".dgit-csplit{flex:none;width:5px;cursor:ew-resize;margin:0 -2px;z-index:2}",
      ".dgit-csplit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dgit-cdiff{flex:auto;min-width:0;display:flex;flex-direction:column}",
      ".dgit-cdiff .dgit-diff{border-top:0;flex:auto}",
      ".dgit-csec{display:flex;align-items:center;gap:6px;padding:6px 8px 4px;font-size:12px;font-weight:600}",
      ".dgit-csec>input{flex:none;margin:0}",
      ".dgit-ccount{color:var(--dsw-alias-label-tertiary);font-weight:400}",
      ".dgit-cgroup+.dgit-cgroup{margin-top:2px}",
      ".dgit-crow{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;border-radius:6px;cursor:default}",
      ".dgit-crow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}",
      ".dgit-crow>input{flex:none;margin:0}",
      ".dgit-crow[data-on=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}",
      ".dgit-cbody{flex:auto;display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer}",
      ".dgit-ficon{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".dgit-ficon[data-type=java]{color:#e07a5f}",
      ".dgit-ficon[data-type=xml]{color:#5b9bd5}",
      ".dgit-ficon[data-type=sql]{color:#3f9e7a}",
      ".dgit-ficon[data-type=md]{color:#8a7fd0}",
      ".dgit-ficon[data-type=script]{color:#c9a227}",
      ".dgit-ficon[data-type=image]{color:#c274c0}",
      ".dgit-cname{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-cname[data-k=untracked]{color:#e07a5f}",
      ".dgit-cname[data-k=mod]{color:#5b9bd5}",
      ".dgit-cname[data-k=del]{color:#c0655f;text-decoration:line-through}",
      ".dgit-cname[data-k=add]{color:#5aa469}",
      ".dgit-crow[data-on=true] .dgit-cname{font-weight:600}",
      ".dgit-cdir{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);direction:rtl;text-align:left}",
      ".dgit-cfoot{flex:none;padding:8px 10px 10px;border-top:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:8px}",
      ".dgit-cmsg{width:100%;height:76px;min-height:52px;max-height:260px;resize:vertical;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-module-platform,#f4f6f8);color:inherit;font:inherit;font-size:12.5px;line-height:1.5;padding:7px 9px;outline:none}",
      ".dgit-cstatus{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px}",
      ".dgit-cstatus[data-bad=true]{color:#c45}",
      // Idle commits have no status; collapsing the empty row keeps the box and
      // the actions from being pushed apart by a blank line.
      ".dgit-cfoot>.dgit-cstatus:empty{display:none}",
      ".dgit-cfoot>.dgit-cstatus{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-cactions{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;row-gap:8px}",
      ".dgit-camend{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-text-2,rgba(0,0,0,.65));cursor:pointer;user-select:none;white-space:nowrap}",
      ".dgit-camend input{cursor:pointer;margin:0}",
      // The commit footer's three actions share one neutral look — same height,
      // radius, padding and background — so none of them reads as the primary
      // one. The modal keeps its own data-k primary/ghost styling.
      ".dgit-cbtn{appearance:none;border:1px solid transparent;height:30px;padding:0 14px;border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer;flex:none;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:5px;background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}",
      ".dgit-cbtn:not([data-k]):hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}",
      ".dgit-cbtn[data-k=primary]{background:var(--dsw-alias-link,#3d6fd9);color:#fff}",
      ".dgit-cbtn[data-k=primary]:hover:not([disabled]){filter:brightness(1.07)}",
      ".dgit-cbtn[data-k=ghost]{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.12))}",
      ".dgit-cbtn[data-k=ghost]:hover:not([disabled]){border-color:var(--dsw-alias-link,#3d6fd9);color:var(--dsw-alias-link,#3d6fd9)}",
      ".dgit-cbtn[disabled]{opacity:.55;cursor:default}",
      ".dgit-diffpane{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}",
      ".dgit-diffhead{flex:none;display:flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".dgit-diffhead strong{color:var(--dsw-alias-label-primary);font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-jumpbtn{flex:none;appearance:none;height:20px;padding:0 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10.5px;font-weight:600;line-height:1;cursor:pointer}",
      ".dgit-jumpbtn:hover{border-color:var(--dsw-alias-link,#3d6fd9);color:var(--dsw-alias-link,#3d6fd9)}",
      ".dgit-diffpane .dgit-diff{flex:auto;border-top:0}",
      ".dgit-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);max-width:min(520px,calc(100% - 24px));padding:6px 10px;border-radius:8px;background:var(--dsw-alias-toast-bg,rgba(20,24,30,.92));color:#fff;font-size:12px;line-height:1.45;text-align:left;white-space:normal;overflow-wrap:anywhere;pointer-events:none;z-index:6}",
      ".dgit-toast.dgit-warn{background:#8a5a12}",
      ".dgit-modal{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.34)}",
      ".dgit-card{width:min(420px,92vw);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.12));box-shadow:0 18px 48px rgba(0,0,0,.28)}",
      ".dgit-cform{display:flex;flex-direction:column;gap:6px;padding:12px 14px 4px}",
      ".dgit-clabel{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}",
      ".dgit-cfrom{font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-cinput{width:100%;height:30px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));border-radius:7px;background:var(--dsw-alias-bg-module-platform,#f4f6f8);color:inherit;font:inherit;font-size:13px;padding:0 9px;outline:none}",
      ".dgit-cinput:focus{border-color:var(--dsw-alias-link,#3d6fd9)}",
      ".dgit-cactions-pad{padding:8px 14px 14px}",
      ".dgit-init{flex:auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}",
      ".dgit-initcard{box-sizing:border-box;width:min(420px,100%);display:flex;flex-direction:column;gap:8px;padding:18px;border-radius:12px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.12));background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.03))}",
      ".dgit-inittitle{font-size:13px;font-weight:600}",
      ".dgit-initdesc{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
      ".dgit-inithint{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".dgit-initcard .dgit-cbtn{align-self:flex-start;margin-top:4px}",
      ".dgit-opbar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:12px;background:rgba(224,176,64,.14);border-bottom:.5px solid rgba(224,176,64,.3);color:var(--dsw-alias-label-primary)}",
      ".dgit-opbar[data-conflict=\"false\"]{background:rgba(91,155,213,.14);border-bottom-color:rgba(91,155,213,.3)}",
      ".dgit-opdot{flex:none;width:8px;height:8px;border-radius:99px;background:#e0b040}",
      ".dgit-opbar[data-conflict=\"false\"] .dgit-opdot{background:#5b9bd5}",
      ".dgit-optext{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}",
      ".dgit-ophint{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dgit-opbtn{appearance:none;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));background:transparent;color:inherit;font:inherit;font-size:12px;height:22px;padding:0 9px;border-radius:6px;cursor:pointer}",
      ".dgit-opbtn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dgit-opbtn[data-k=warn]{border-color:rgba(196,68,85,.5);color:#c44555}",
      ".dgit-opbtn[disabled]{opacity:.55;cursor:default}"
    ].join("\n");

    const detectMac = () => {
      try {
        if (window.navigator.userAgentData !== undefined && window.navigator.userAgentData.platform === "macOS") return true;
      } catch {}
      try { return /Macintosh|Mac OS X/i.test(window.navigator.userAgent); } catch {}
      return false;
    };
    const IS_MAC = detectMac();

    // ---------------------------------------------------------------------
    // Rebindable chord: "jump to the file this diff is showing".
    //
    // `dsh-keyboard-shortcuts` owns the catalog and the settings page; this
    // plugin contributes the command and reads the binding back. The identical
    // local default keeps the key working when the shortcuts plugin is absent.
    // ---------------------------------------------------------------------
    const GIT_CHORDS = {
      "git.toggle": { ctrl: !IS_MAC, alt: false, shift: false, meta: IS_MAC, code: "Digit9" },
      "git.pull": { ctrl: !IS_MAC, alt: false, shift: false, meta: IS_MAC, code: "KeyT" },
      "git.push": { ctrl: !IS_MAC, alt: false, shift: true, meta: IS_MAC, code: "KeyT" },
      "git.commit": { ctrl: !IS_MAC, alt: false, shift: true, meta: IS_MAC, code: "KeyK" },
      "git.jumpToSource": { ctrl: false, alt: false, shift: false, meta: false, code: "F4" }
    };

    const matchChordSpec = (spec, event) => {
      if (spec === null || spec === undefined) return false;
      if (!!spec.ctrl !== !!event.ctrlKey) return false;
      if (!!spec.alt !== !!event.altKey) return false;
      if (!!spec.shift !== !!event.shiftKey) return false;
      if (!!spec.meta !== !!event.metaKey) return false;
      return spec.code === event.code;
    };

    const gitChordHeld = (id, event) => {
      const api = window.__dshKeyboardShortcuts;
      if (api !== undefined && api !== null && typeof api.match === "function") {
        try {
          const known = typeof api.has !== "function" ? true : api.has(id) === true;
          if (known) return api.match(id, event) === true;
        } catch {}
      }
      return matchChordSpec(GIT_CHORDS[id], event);
    };

    const GIT_COMMANDS = [
      {
        id: "git.toggle",
        group: "git",
        order: 10,
        global: true,
        labels: { zh: "显示/隐藏 Git 面板（编辑器下方）", en: "Show or hide the Git panel under the editor" },
        default: GIT_CHORDS["git.toggle"]
      },
      {
        id: "git.pull",
        group: "git",
        order: 20,
        labels: { zh: "拉取", en: "Pull" },
        default: GIT_CHORDS["git.pull"]
      },
      {
        id: "git.push",
        group: "git",
        order: 25,
        labels: { zh: "推送", en: "Push" },
        default: GIT_CHORDS["git.push"]
      },
      {
        id: "git.commit",
        group: "git",
        order: 30,
        labels: { zh: "提交", en: "Commit" },
        default: GIT_CHORDS["git.commit"]
      },
      {
        id: "git.jumpToSource",
        group: "git",
        order: 60,
        labels: { zh: "跳转到变更行", en: "Jump to the changed line" },
        default: GIT_CHORDS["git.jumpToSource"]
      }
    ];

    // A short keycap label for the jump chord, so the diff toolbar button and
    // the commit window follow whatever the user has bound in Settings.
    const gitChordLabel = (id) => {
      let spec = GIT_CHORDS[id];
      const api = window.__dshKeyboardShortcuts;
      if (api !== undefined && api !== null && typeof api.binding === "function") {
        try {
          const bound = api.binding(id);
          if (bound !== undefined) spec = bound;
        } catch {}
      }
      if (spec === null || spec === undefined) return "";
      const parts = [];
      if (IS_MAC) {
        if (spec.ctrl) parts.push("⌃");
        if (spec.alt) parts.push("⌥");
        if (spec.shift) parts.push("⇧");
        if (spec.meta) parts.push("⌘");
      } else {
        if (spec.ctrl) parts.push("Ctrl");
        if (spec.alt) parts.push("Alt");
        if (spec.shift) parts.push("⇧");
        if (spec.meta) parts.push("Win");
      }
      if (spec.code) {
        const code = spec.code;
        const key = code === "Escape" ? "Esc"
          : code.indexOf("Key") === 0 && code.length === 4 ? code.slice(3)
          : code.indexOf("Digit") === 0 ? code.slice(5)
          : code;
        parts.push(key);
      }
      return parts.join(IS_MAC ? "" : "+");
    };
    const withChord = (label, id) => {
      const key = gitChordLabel(id);
      return key === "" ? label : label + " (" + key + ")";
    };

    const isNineEvent = (event) => event.code === "Digit9" || event.code === "Numpad9" || event.key === "9";

    // ⌘9 / Ctrl+9 is the browser's "last tab" shortcut, so the page often never
    // sees that exact chord. While the binding is still the default Digit9
    // chord, also accept the other modifier (⌃9 on Mac) so the panel can open.
    const toggleHeld = (event) => {
      if (gitChordHeld("git.toggle", event)) return true;
      if (event.altKey || event.shiftKey) return false;
      if (event.metaKey === event.ctrlKey) return false;
      if (!isNineEvent(event)) return false;
      let spec = GIT_CHORDS["git.toggle"];
      const api = window.__dshKeyboardShortcuts;
      if (api !== undefined && api !== null && typeof api.binding === "function") {
        try {
          const bound = api.binding("git.toggle");
          if (bound !== undefined) spec = bound;
        } catch {}
      }
      if (spec === null || spec === undefined) return false;
      if (spec.code !== "Digit9" && spec.code !== "Numpad9") return false;
      if (spec.alt || spec.shift) return false;
      return !!spec.ctrl !== !!spec.meta;
    };

    // A binding saved while the default was plain ⌘K / Ctrl+K still answers that
    // chord. ⌘⇧K / Ctrl+Shift+K keeps opening the commit window either way: it is
    // the default now, and it stays available until the user rebinds commit off
    // KeyK entirely.
    const commitShiftHeld = (event) => {
      if (event.altKey || !event.shiftKey) return false;
      if (event.metaKey === event.ctrlKey) return false;
      if (event.code !== "KeyK") return false;
      let spec = GIT_CHORDS["git.commit"];
      const api = window.__dshKeyboardShortcuts;
      if (api !== undefined && api !== null && typeof api.binding === "function") {
        try {
          const bound = api.binding("git.commit");
          if (bound !== undefined) spec = bound;
        } catch {}
      }
      if (spec === null || spec === undefined) return false;
      if (spec.code !== "KeyK" || spec.alt) return false;
      return !!spec.ctrl !== !!spec.meta;
    };

    const makeBus = (initial) => {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        set: (next) => {
          value = next;
          for (const fn of listeners) {
            try { fn(); } catch {}
          }
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        }
      };
    };

    const originOf = () => {
      try {
        const o = window.location.origin;
        return o !== undefined && o !== "null" ? o : "http://dsh.internal";
      } catch {
        return "http://dsh.internal";
      }
    };

    const postJson = async (path, body) => {
      const response = await fetch(new URL(path, originOf()), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok) {
        const err = (data && data.error) ? String(data.error) : ("HTTP " + response.status);
        throw new Error(err);
      }
      return data;
    };

    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ":");
    const encodePath = (path) => path.split("/").map(encodeSegment).join("/");
    const fileAddressFor = (sessionId, cwd, path) => {
      const normalized = String(path || "").replace(/\\/g, "/");
      const root = cwd === undefined || cwd === null || cwd === "" ? "" : String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
      let rel = normalized;
      if (root !== "" && (normalized === root || normalized === root + "/")) rel = "";
      else if (root !== "" && normalized.startsWith(root + "/")) rel = normalized.slice(root.length + 1);
      // Absolute path outside the workspace root (a Git root above the
      // session workspace): keep it absolute in the session address. The
      // empty first segment encodes the leading "/", which both this plugin
      // and the host resolver treat as absolute, so the address resolves to
      // the file itself instead of cwd + "/Users/...". Matches the host's
      // own fileAddressFor for this case.
      else if (root !== "" && normalized.charAt(0) === "/") rel = normalized;
      rel = rel.replace(/^(?:\.\/)+/, "");
      return FILE_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(rel);
    };
    const parseGitDiffAddress = (address) => {
      if (typeof address !== "string" || address.indexOf(DIFF_PREFIX) !== 0) return null;
      const rest = address.slice(DIFF_PREFIX.length);
      const parts = rest.split("/");
      if (parts.length < 2) return null;
      let sessionId = parts[0];
      let hash = parts[1];
      try { sessionId = decodeURIComponent(sessionId); } catch {}
      try { hash = decodeURIComponent(hash); } catch {}
      const path = parts.slice(2).map((part) => {
        try { return decodeURIComponent(part); } catch { return part; }
      }).join("/");
      return { sessionId, hash, path };
    };

    const readNum = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key);
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
      } catch {}
      return fallback;
    };
    const readFlag = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === "1") return true;
        if (raw === "0") return false;
      } catch {}
      return fallback;
    };
    const writeLS = (key, value) => {
      try { window.localStorage.setItem(key, String(value)); } catch {}
    };

    const parseDecorations = (refs) => {
      if (!refs) return [];
      const out = [];
      const parts = String(refs).split(", ");
      for (let i = 0; i < parts.length; i++) {
        let name = parts[i].trim();
        if (name === "") continue;
        let pointed = false;
        if (name.indexOf("HEAD -> ") === 0) {
          pointed = true;
          name = name.slice(8);
        }
        if (name === "HEAD") out.push({ kind: "head", name: "HEAD", pointed: true });
        else if (name.indexOf("tag: ") === 0) out.push({ kind: "tag", name: name.slice(5), pointed });
        else if (name.indexOf("/") >= 0) out.push({ kind: "remote", name, pointed });
        else out.push({ kind: "local", name, pointed });
      }
      return out;
    };

    const compactPills = (decos) => {
      if (decos.length === 0) return [];
      const locals = {};
      const rest = [];
      for (let i = 0; i < decos.length; i++) {
        const d = decos[i];
        if (d.kind === "local") locals[d.name] = d;
        else rest.push(d);
      }
      const pills = [];
      const used = {};
      for (let i = 0; i < rest.length; i++) {
        const d = rest[i];
        if (d.kind === "remote") {
          const short = d.name.indexOf("/") >= 0 ? d.name.slice(d.name.lastIndexOf("/") + 1) : d.name;
          if (locals[short]) {
            pills.push({ kind: "local", name: "origin & " + short, pointed: d.pointed || locals[short].pointed });
            used[short] = 1;
            continue;
          }
        }
        pills.push(d);
      }
      for (const name of Object.keys(locals)) {
        if (!used[name]) pills.push(locals[name]);
      }
      return pills.slice(0, 3);
    };

    const formatWhen = (at, todayLabel) => {
      if (!at) return "";
      const d = new Date(at * 1000);
      if (Number.isNaN(d.getTime())) return "";
      const now = new Date();
      const pad = (n) => (n < 10 ? "0" + n : String(n));
      const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        return todayLabel + " " + hm;
      }
      return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
    };

    function apply(ctx) {
      const localeService = () => { try { return ctx.get("locale"); } catch { return undefined; } };
      const sessionsService = () => { try { return ctx.get("sessions"); } catch { return undefined; } };
      const uiSessionService = () => { try { return ctx.get("uiSession"); } catch { return undefined; } };
      const sidebarRightService = () => { try { return ctx.get("sidebarRight"); } catch { return undefined; } };

      const langOf = () => {
        const loc = localeService();
        try {
          const snap = loc === undefined ? undefined : loc.getSnapshot === undefined ? undefined : loc.getSnapshot();
          const id = snap === undefined ? undefined : snap.id ?? snap.locale ?? snap.language;
          if (id === "zh" || (typeof id === "string" && id.indexOf("zh") === 0)) return "zh";
          if (id === "en" || (typeof id === "string" && id.indexOf("en") === 0)) return "en";
        } catch {}
        try {
          const nav = window.navigator.language || "";
          if (nav.indexOf("zh") === 0) return "zh";
        } catch {}
        return "zh";
      };

      const langBus = makeBus(langOf());
      /**
       * Live widths while a splitter is being dragged, or `null` when idle.
       *
       * A drag paints the width straight to the DOM instead of going through
       * `uiBus`, because every `uiBus.set` re-renders the whole dock — the
       * commit table included. That leaves the inline style owned by the DOM
       * rather than by React, so an unrelated re-render landing mid-drag (a
       * status tick, a toast) would repaint the stale committed width and make
       * the splitter snap back. While one of these is set, the matching render
       * site prefers it, which turns a mid-drag repaint into a no-op.
       *
       * These have to sit at the apply scope rather than in a ref inside `Dock`,
       * because the two render sites live in different components
       * (`CommitDialog` for the tree width, `Dock` for the branch width).
       */
      const dragW = { branch: null, tree: null, detail: null };
      const uiBus = makeBus({
        visible: false,
        collapsed: false,
        branchW: readNum(BRANCH_W_KEY, DEFAULT_BRANCH_W),
        commitTreeW: readNum(COMMIT_TREE_W_KEY, DEFAULT_COMMIT_TREE_W),
        detailW: Math.min(DETAIL_MAX_W, Math.max(DETAIL_MIN_W, readNum(DETAIL_W_KEY, DEFAULT_DETAIL_W))),
        toast: "",
        warn: false
      });
      /**
       * Whether the Git panel is showing as the editor's bottom dock.
       *
       * It used to be a workspace mode that took the whole column. The column
       * is the editor's now, and the panel shares it, so its state lives here
       * and reaches the editor's CSS through `data-dsh-git-dock`.
       */
      const dockBus = makeBus({ open: false, docked: false });
      const commitBus = makeBus({
        open: false,
        files: [],
        selected: {},
        openDirs: {},
        message: "",
        busy: false,
        generating: false,
        amend: false,
        status: "",
        bad: false,
        menu: null
      });
      // The tall-dock flag follows `commitBus.open` itself rather than the one
      // helper that used to clear it: the dialog also closes via Escape, the
      // back button, and a successful commit, and every one of them must give
      // the column its height back.
      commitBus.subscribe(() => {
        if (commitBus.getSnapshot().open === true) return;
        try {
          if (document.documentElement.dataset[TALL_ATTR] === "1") document.documentElement.dataset[TALL_ATTR] = "0";
        } catch {}
      });
      const dataBus = makeBus({
        sessionId: "",
        cwd: "",
        workspace: "",
        repos: [],
        reposKnown: false,
        repoPath: "",
        repoPinned: false,
        root: "",
        loading: false,
        error: "",
        repo: false,
        head: "",
        hash: "",
        short: "",
        dirty: false,
        files: [],
        local: [],
        remote: [],
        tags: [],
        commits: [],
        unborn: false,
        operation: { kind: "", conflicted: false },
        conflicted: false,
        selectedRef: "",
        selectedHash: "",
        query: "",
        author: "",
        since: "",
        branchQuery: "",
        detail: null,
        detailTab: "files",
        historyFile: "",
        diffPath: "",
        diffText: "",
        diffLoading: false,
        checkingOut: false,
        pulling: false,
        pushing: false,
        menu: null,
        newBranch: null,
        rename: null,
        opBusy: false,
        initializing: false,
        leftOpen: { local: true, remote: true, tags: false }
      });

      const t = (key, vars) => {
        const pack = I18N[langBus.getSnapshot()] || I18N.zh;
        let s = pack[key] ?? I18N.en[key] ?? key;
        if (vars !== undefined) {
          for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
        }
        return s;
      };

      const loc = localeService();
      if (loc !== undefined && typeof loc.subscribe === "function") {
        ctx.effect(() => loc.subscribe(() => { langBus.set(langOf()); }));
      }

      const styleTag = document.createElement("style");
      styleTag.dataset.plugin = PLUGIN;
      styleTag.textContent = STYLE;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => { if (styleTag.isConnected) styleTag.remove(); });

      /**
       * The selected Session id straight from the host's public contract.
       *
       * `uiSession.adapter.current` is a typed `HostObservable<StandardSourceBinding>`
       * whose `key` is the session on the main stage — the same source
       * ui-sidebar-right consumes. It is the declared API and the one source
       * present in every Session Controller generation this plugin runs against,
       * which is why it is read first: the list store's own selection field was
       * removed in 0.1.6-alpha.2 and answered `undefined` ever after, so the panel
       * reported "没有打开的会话" while a session sat wide open.
       *
       * @returns the selected id, or `undefined` when no host/api answers.
       */
      const uiSessionId = () => {
        try {
          const ui = uiSessionService();
          const source = ui === undefined || ui.adapter === undefined ? undefined : ui.adapter.current;
          if (source === undefined || typeof source.getSnapshot !== "function") return undefined;
          const key = source.getSnapshot()?.key;
          return key === undefined || key === null || key === "" ? undefined : key;
        } catch {
          return undefined;
        }
      };

      /**
       * Fallback over a raw list snapshot, used only when the `uiSession` service
       * cannot answer (it is read through an optional lookup, so a composition
       * that omits that UI package leaves it undefined). The selection then
       * survives solely as the `mainView` reference on the row.
       */
      const mainSessionId = (snap) => {
        const rows = Object.values(snap.byId || {});
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row !== undefined && row !== null && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0) return row.id;
        }
        return undefined;
      };

      const currentSession = () => {
        const sessions = sessionsService();
        const snap = sessions === undefined || sessions.list === undefined ? undefined : sessions.list.getSnapshot();
        const id = uiSessionId() ?? (snap === undefined || snap === null ? undefined : mainSessionId(snap));
        if (id === undefined || id === null) return null;
        // The row is still the authority for the working directory; a session the
        // list has not catalogued yet simply has no workspace to show.
        const entry = snap === undefined || snap === null || snap.byId === undefined ? undefined : snap.byId[id];
        const cwd = entry !== undefined && typeof entry.cwd === "string" ? entry.cwd : "";
        return { id, cwd };
      };

      let toastTimer = 0;
      const showToast = (text, warn) => {
        const ui = uiBus.getSnapshot();
        uiBus.set({ ...ui, toast: text, warn: warn === true });
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
          uiBus.set({ ...uiBus.getSnapshot(), toast: "" });
        }, warn === true ? 8000 : 1600);
      };

      /**
       * Close the commit window, if it is open.
       *
       * `commitBus.open` is the single source of truth for the dialog, and the
       * dialog only exists while the dock is mounted in the files workspace.
       * Every path that takes the dock down must therefore clear the flag too:
       * leaving it set leaves the state claiming a dialog that is not on screen,
       * which then reappears when the dock is rebuilt (and makes the jump chord
       * skip its own handling, because that path treats an open dialog as "the
       * dialog's inputs own this key").
       */
      const closeCommit = () => {
        try { document.documentElement.dataset[TALL_ATTR] = "0"; } catch {}
        if (commitBus.getSnapshot().open !== true) return;
        commitBus.set({ ...commitBus.getSnapshot(), open: false });
      };

      let loadSeq = 0;
      const setData = (patch) => dataBus.set({ ...dataBus.getSnapshot(), ...patch });

      /**
       * Compare the file list `git status --porcelain=v2` produces.
       *
       * The order is stable for a given index, so a positional compare is enough
       * and avoids building a key or sorting on every tick.
       */
      const sameFileList = (a, b) => {
        const left = Array.isArray(a) ? a : [];
        if (left.length !== b.length) return false;
        for (let i = 0; i < left.length; i += 1) {
          const x = left[i];
          const y = b[i];
          if (x === undefined || y === undefined) return false;
          if (x.path !== y.path || x.xy !== y.xy || x.orig !== y.orig) return false;
        }
        return true;
      };

      /** Compare a branch/tag list by the fields the panel renders. */
      const sameRefList = (a, b) => {
        const left = Array.isArray(a) ? a : [];
        if (left.length !== b.length) return false;
        for (let i = 0; i < left.length; i += 1) {
          const x = left[i];
          const y = b[i];
          if (x === undefined || y === undefined) return false;
          if (x.name !== y.name || x.hash !== y.hash || x.current !== y.current || x.upstream !== y.upstream) return false;
        }
        return true;
      };

      const emptyRepoPatch = () => ({
        repo: false,
        head: "",
        root: "",
        hash: "",
        short: "",
        dirty: false,
        files: [],
        local: [],
        remote: [],
        tags: [],
        commits: [],
        unborn: false,
        operation: { kind: "", conflicted: false },
        conflicted: false,
        selectedHash: "",
        detail: null,
        diffPath: "",
        diffText: "",
        menu: null,
        newBranch: null,
        rename: null
      });

      const load = async (opts) => {
        if (!uiBus.getSnapshot().visible) return;
        const options = opts === undefined ? {} : opts;
        const session = currentSession();
        if (session === null) {
          setData({ sessionId: "", cwd: "", loading: false, error: "noSession", ...emptyRepoPatch() });
          return;
        }
        if (session.cwd === "") {
          setData({ sessionId: session.id, cwd: "", loading: false, error: "noWorkspace", ...emptyRepoPatch() });
          return;
        }
        const snap = dataBus.getSnapshot();
        const workspaceChanged = snap.sessionId !== session.id || snap.workspace !== session.cwd;
        let repos = !workspaceChanged && snap.reposKnown === true && options.rescan !== true ? snap.repos : null;
        if (repos === null || workspaceChanged) repos = await discoverRepos(session.cwd);
        const chosen = chooseRepo(session.cwd, repos, options.repoPath);
        const gitPath = chosen.legacy ? session.cwd : chosen.path;
        const switched = workspaceChanged || snap.repoPath !== chosen.path;
        const query = switched && options.query === undefined ? "" : (options.query !== undefined ? options.query : snap.query);
        const author = switched && options.author === undefined ? "" : (options.author !== undefined ? options.author : snap.author);
        const since = switched && options.since === undefined ? "" : (options.since !== undefined ? options.since : snap.since);
        const selectedRef = switched && options.selectedRef === undefined ? "" : (options.selectedRef !== undefined ? options.selectedRef : snap.selectedRef);
        const seq = ++loadSeq;
        const quiet = options.quiet === true && !switched && Array.isArray(snap.commits) && snap.commits.length > 0;
        // A switched session/repo invalidates the commit window outright: its
        // file list, its diffs and its `cwd` all belong to the repo that just
        // went away. Leaving it open shows one repository's changes under
        // another's branch, and the jump chord then resolves those paths against
        // the new root.
        if (switched) closeCommit();
        setData({
          sessionId: session.id,
          workspace: session.cwd,
          cwd: gitPath || session.cwd,
          repoPath: chosen.path,
          repoPinned: chosen.pinned === true,
          repos: chosen.repos,
          reposKnown: chosen.legacy !== true,
          loading: quiet ? false : true,
          error: "",
          query,
          author,
          since,
          selectedRef,
          ...(switched ? { selectedHash: "", detail: null, diffPath: "", diffText: "", menu: null, commits: [] } : {})
        });
        if (chosen.missing) {
          setData({ loading: false, error: "noRepo", repo: false, ...emptyRepoPatch() });
          return;
        }
        try {
          const q = String(query || "").trim();
          const body = { cwd: gitPath, author, since };
          body.rev = selectedRef && selectedRef !== "HEAD" ? selectedRef : "HEAD";
          if (q !== "") body.search = q;
          const [state, log] = await Promise.all([
            postJson(STATE_PATH, { cwd: gitPath }),
            postJson(LOG_PATH, body)
          ]);
          if (seq !== loadSeq) return;
          if (!state || state.repo !== true) {
            setData({ loading: false, error: state && state.notRepo ? "noRepo" : (state && state.error ? String(state.error) : "noRepo"), ...emptyRepoPatch() });
            return;
          }
          setData({
            loading: false,
            error: log && log.error ? String(log.error) : "",
            repo: true,
            head: state.head || "",
            root: state.root || "",
            hash: state.hash || "",
            short: state.short || "",
            unborn: state.unborn === true,
            operation: state.operation && typeof state.operation === "object" ? state.operation : { kind: "", conflicted: false },
            conflicted: state.conflicted === true,
            dirty: state.dirty === true,
            files: Array.isArray(state.files) ? state.files : [],
            local: Array.isArray(state.local) ? state.local : [],
            remote: Array.isArray(state.remote) ? state.remote : [],
            tags: switched ? [] : (dataBus.getSnapshot().tags || []),
            commits: log && log.repo === true && Array.isArray(log.commits) ? log.commits : []
          });
        } catch (err) {
          if (seq !== loadSeq) return;
          console.error("dsh-git-manager load:", err);
          setData({ loading: false, error: err && err.message ? String(err.message) : "noRepo", ...emptyRepoPatch() });
        }
      };

      /**
       * Re-read only the repository state (branch, status, operation) without
       * touching the commit list.
       *
       * `syncSession` runs on a 15s timer, so this deliberately avoids the log
       * request: the list only needs re-fetching when HEAD or a ref actually
       * moves, which this reports back to the caller.
       *
       * @returns the fresh state, or null when there is nothing to read.
       */
      const refreshStatus = async () => {
        const session = currentSession();
        if (session === null || session.cwd === "") return null;
        const snap = dataBus.getSnapshot();
        if (snap.workspace && snap.workspace !== session.cwd) return null;
        const gitPath = sessionCwd();
        if (!gitPath) return null;
        try {
          const data = await postJson(STATE_PATH, { cwd: gitPath });
          // The await above can span a session switch: a new `load` then
          // already owns dataBus, and writing session A's state over it would
          // flash the wrong repository until the next tick.
          const now = currentSession();
          const cur = dataBus.getSnapshot();
          if (now === null || now.id !== session.id || cur.sessionId !== snap.sessionId || cur.cwd !== snap.cwd) return data;
          if (!data || data.repo !== true) {
            // A non-repo workspace is the steady state for most sessions, so only
            // write when the panel is not already showing exactly that.
            if (snap.repo !== false || snap.error !== "noRepo") {
              setData({ repo: false, error: data && data.notRepo ? "noRepo" : "noRepo", ...emptyRepoPatch() });
            }
            return null;
          }
          /**
           * The periodic tick re-reads the whole state, but most ticks find
           * nothing changed. `dataBus.set` notifies every subscriber and
           * re-renders the whole dock, so compare the fields that drive the tree,
           * the status line and the branch picker first, and skip the write when
           * they are identical. `refreshStatus` still returns `data`, so the
           * graph-moved check in `syncSession` keeps working.
           */
          const files = Array.isArray(data.files) ? data.files : [];
          const local = Array.isArray(data.local) ? data.local : [];
          const remote = Array.isArray(data.remote) ? data.remote : [];
          const operation = data.operation && typeof data.operation === "object" ? data.operation : { kind: "", conflicted: false };
          const unchanged = snap.repo === true
            && snap.error === ""
            && (snap.head || "") === (data.head || "")
            && (snap.hash || "") === (data.hash || "")
            && snap.unborn === (data.unborn === true)
            && (snap.operation && snap.operation.kind) === operation.kind
            && snap.conflicted === (data.conflicted === true)
            && snap.dirty === (data.dirty === true)
            && sameFileList(snap.files, files)
            && sameRefList(snap.local, local)
            && sameRefList(snap.remote, remote);
          if (unchanged) return data;
          setData({
            repo: true,
            error: "",
            head: data.head || "",
            root: data.root || "",
            hash: data.hash || "",
            short: data.short || "",
            unborn: data.unborn === true,
            operation: data.operation && typeof data.operation === "object" ? data.operation : { kind: "", conflicted: false },
            conflicted: data.conflicted === true,
            dirty: data.dirty === true,
            files,
            local,
            remote
          });
          return data;
        } catch (err) {
          console.error("dsh-git-manager status:", err);
          return null;
        }
      };

      let searchTimer = 0;
      const scheduleLoad = (patch) => {
        if (patch) setData(patch);
        if (searchTimer) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => load(patch || {}), 150);
      };

      const loadDetail = async (hash) => {
        const snap = dataBus.getSnapshot();
        if (!snap.cwd || !hash) {
          setData({ selectedHash: hash || "", detail: null, detailTab: "files", historyFile: "", diffPath: "", diffText: "" });
          return;
        }
        if (hash === "WORKING") {
          setData({
            selectedHash: hash,
            detailTab: "files",
            historyFile: "",
            diffPath: "",
            diffText: "",
            detail: {
              commit: { subject: t("dirty"), body: "", author: "", at: Math.floor(Date.now() / 1000), hash: "", short: "" },
              files: (snap.files || []).map((f) => ({ status: (f.xy || " M").trim().slice(-1) || "M", path: f.path, orig: f.orig || "" }))
            }
          });
          return;
        }
        setData({ selectedHash: hash, detailTab: "files", historyFile: "", diffPath: "", diffText: "" });
        try {
          const data = await postJson(SHOW_PATH, { cwd: snap.cwd, hash });
          const cur = dataBus.getSnapshot();
          if (cur.selectedHash !== hash) return;
          setData({ detail: { commit: data.commit || null, files: Array.isArray(data.files) ? data.files : [] } });
        } catch (err) {
          console.error("dsh-git-manager show:", err);
        }
      };

      const workspaceCwd = () => {
        const session = currentSession();
        return session && typeof session.cwd === "string" ? session.cwd : "";
      };
      const sessionCwd = () => {
        const snap = dataBus.getSnapshot();
        if (snap.repoPath) return snap.repoPath;
        return workspaceCwd() || snap.cwd || "";
      };
      const normPath = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const parseOpenFile = (address) => {
        const prefix = FILE_PREFIX + "session/";
        if (typeof address !== "string" || address.indexOf(prefix) !== 0) return "";
        const rest = address.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) return "";
        return rest.slice(slash + 1).split("/").map((part) => {
          try { return decodeURIComponent(part); } catch { return part; }
        }).join("/");
      };
      const activeFileAbs = () => {
        const workspace = workspaceCwd();
        if (!workspace) return "";
        const sidebar = sidebarRightService();
        let tab;
        try { tab = sidebar && typeof sidebar.active === "function" ? sidebar.active() : undefined; } catch {}
        const rel = parseOpenFile(tab && tab.contentId);
        if (!rel) return "";
        return normPath(workspace) + "/" + rel.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      };
      const repoForFile = (repos, file) => {
        const norm = normPath(file);
        if (!norm || !Array.isArray(repos)) return "";
        let best = "";
        let bestLen = -1;
        for (let i = 0; i < repos.length; i++) {
          const root = normPath(repos[i] && repos[i].path);
          if (root === "") continue;
          if (norm !== root && norm.indexOf(root + "/") !== 0) continue;
          if (root.length > bestLen) {
            best = repos[i].path;
            bestLen = root.length;
          }
        }
        return best;
      };
      const storedRepo = (workspace) => {
        try { return window.localStorage.getItem(REPO_STORE + workspace) || ""; } catch { return ""; }
      };
      const discoverRepos = async (workspace) => {
        try {
          const data = await postJson(REPOS_PATH, { cwd: workspace });
          return data && Array.isArray(data.repos) ? data.repos : [];
        } catch (err) {
          console.warn("dsh-git-manager repos:", err);
          return null;
        }
      };
      const chooseRepo = (workspace, repos, forced) => {
        if (repos === null) return { path: "", pinned: false, repos: [], legacy: true };
        if (!Array.isArray(repos) || repos.length === 0) return { path: "", pinned: false, repos: [], missing: true };
        const pinned = readFlag(PIN_STORE + workspace, false);
        const saved = storedRepo(workspace);
        const has = (path) => repos.some((row) => row && row.path === path);
        if (forced && has(forced)) return { path: forced, pinned, repos };
        if (pinned && has(saved)) return { path: saved, pinned: true, repos };
        const followed = repoForFile(repos, activeFileAbs());
        if (!pinned && followed) return { path: followed, pinned: false, repos };
        if (has(saved)) return { path: saved, pinned: false, repos };
        return { path: repos[0].path, pinned: false, repos };
      };
      const selectRepo = (path) => {
        const workspace = workspaceCwd();
        if (!workspace || !path) return;
        try {
          window.localStorage.setItem(REPO_STORE + workspace, path);
          window.localStorage.setItem(PIN_STORE + workspace, "1");
        } catch {}
        load({ repoPath: path });
      };

      const ERROR_KEYS = {
        "not-a-repo": "noRepo",
        "branch-required": "branchRequired",
        "branch-invalid": "branchInvalid",
        "branch-too-long": "branchTooLong",
        "branch-exists": "branchExists",
        "branch-same": "branchSame",
        "branch-missing": "branchMissing",
        // A checkout/merge target that is not a branch, remote branch, or tag.
        // Reusing the branch wording keeps the vocabulary small: the panel only
        // ever offers names from those lists, so this means the row went stale.
        "ref-missing": "branchMissing",
        "no-operation": "noOperation",
        "current-branch": "deleteCurrent",
        "stash-conflict": "stashConflict"
      };
      const errorText = (error, fallbackKey) => {
        const code = error === undefined || error === null ? "" : String(error);
        if (code !== "" && ERROR_KEYS[code]) return t(ERROR_KEYS[code]);
        if (/branch already exists/i.test(code)) return t("branchExists");
        if (/not a valid|invalid ref|check-ref-format/i.test(code)) return t("branchInvalid");
        if (/would be overwritten by checkout|before you switch branches/i.test(code)) return t("checkoutDirty");
        if (/would be overwritten by merge|before you merge/i.test(code)) return t("pullDirty");
        if (/Applying autostash resulted in conflicts|stash entry is kept/i.test(code)) return t("stashConflict");
        return code !== "" ? code : t(fallbackKey);
      };

      /**
       * Shared host-mutation path. The host no longer returns a fresh repo
       * state; this always reloads after success, and optionally after failure
       * (merge/cherry-pick/pull can leave the repo conflicted).
       */
      const runAction = async (opts) => {
        const busy = opts.busy || "checkingOut";
        setData({ [busy]: true, menu: null });
        if (opts.working) showToast(t(opts.working));
        try {
          const data = await postJson(opts.path, opts.body);
          if (data && data.ok === false) {
            setData({ [busy]: false });
            showToast(errorText(data.error, opts.fail), true);
            // `switched` means the branch already moved and only the stash
            // restore failed. Reload so the panel does not keep the old HEAD.
            if (opts.reloadOnFail || data.switched === true) await load(opts.loadOpts || {});
            return data;
          }
          setData({ [busy]: false, ...(opts.successPatch || {}) });
          if (data && data.stashed === true && opts.stashed) showToast(t(opts.stashed));
          else if (opts.ok) showToast(t(opts.ok));
          await load(opts.loadOpts || {});
          return data;
        } catch (err) {
          setData({ [busy]: false });
          showToast(errorText(err && err.message, opts.fail), true);
          if (opts.reloadOnFail) await load(opts.loadOpts || {});
          return null;
        }
      };

      const checkout = async (ref) => {
        const cwd = sessionCwd();
        if (!cwd || !ref) return;
        await runAction({
          path: CHECKOUT_PATH,
          body: { cwd, ref },
          fail: "checkoutFail",
          stashed: "checkoutStashed",
          loadOpts: { selectedRef: "" },
          successPatch: { selectedRef: "" }
        });
      };

      /** The editor chunk, when it exposes the diff surface. */
      const editorDiffApi = () => {
        const panel = window.__dshEditorPanel;
        return panel !== undefined && panel !== null && typeof panel.openDiff === "function" ? panel : null;
      };

      /**
       * Show one file's change in the editor area, above the dock.
       *
       * The panel keeps the list; the diff gets the editor, where a change can
       * be read at full width and `F4` can drop into the file itself.
       *
       * @returns whether the editor took it — false means fall back to the
       *          in-panel diff.
       */
      const openDiffInEditor = (relPath, hash, text) => {
        const panel = editorDiffApi();
        if (panel === null) return false;
        const geometry = diffGeometry(text);
        try {
          panel.openDiff({
            key: "git:" + hash + ":" + relPath,
            path: relPath,
            hash,
            title: relPath.split("/").pop(),
            text,
            rows: geometry.rows,
            line: geometry.hunks.length > 0 ? geometry.hunks[0].changeLine : 0
          });
          return true;
        } catch (err) {
          console.error("dsh-git-manager openDiffInEditor:", err);
          return false;
        }
      };

      const openHistoryFile = (relPath) => {
        const snap = dataBus.getSnapshot();
        if (!snap.cwd || !relPath) return;
        const hash = snap.selectedHash || "WORKING";
        const inEditor = editorDiffApi() !== null;
        // A token guards the reply: a later click must not paint an older diff.
        const token = hash + "\0" + relPath;
        setData({ historyFile: relPath, detailTab: "files", diffPath: token, diffText: "", diffLoading: !inEditor });
        window.requestAnimationFrame(() => {
          const host = document.querySelector(".dgit-host");
          const el = host === null ? null : host.querySelector(".dgit-dfiles .dgit-frow[data-on=true]");
          if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
        });
        postJson(DIFF_PATH, { cwd: snap.cwd, hash, path: relPath }).then((data) => {
          const text = typeof data.diff === "string" ? data.diff : "";
          if (openDiffInEditor(relPath, hash, text)) {
            const cur = dataBus.getSnapshot();
            if (cur.diffPath === token && (cur.diffText !== "" || cur.diffLoading)) {
              setData({ diffPath: "", diffLoading: false, diffText: "" });
            }
            return;
          }
          const cur = dataBus.getSnapshot();
          if (cur.diffPath !== token) return;
          setData({ diffLoading: false, diffText: text });
        }).catch((err) => {
          const cur = dataBus.getSnapshot();
          if (cur.diffPath !== token) return;
          setData({ diffLoading: false, diffText: "" });
          console.error("dsh-git-manager diff:", err);
        });
      };

      let fileStepLock = false;
      const stepHistoryFile = (dir) => {
        if (fileStepLock) return;
        const snap = dataBus.getSnapshot();
        const files = snap.detail && Array.isArray(snap.detail.files) ? snap.detail.files : [];
        if (files.length === 0) return;
        let i = files.findIndex((f) => f.path === snap.historyFile);
        if (i < 0) i = dir > 0 ? -1 : files.length;
        const next = Math.max(0, Math.min(files.length - 1, i + dir));
        if (!files[next] || files[next].path === snap.historyFile) return;
        fileStepLock = true;
        openHistoryFile(files[next].path);
        window.setTimeout(() => { fileStepLock = false; }, 0);
      };

      /**
       * The rows the commit table draws, in draw order: the virtual "uncommitted
       * changes" row first when it applies, then the loaded commits. Shared by
       * the renderer and the arrow-key stepper so both walk the same list.
       */
      const displayCommitsOf = (snap) => {
        const list = [];
        if (snap.dirty && (snap.selectedRef === "" || snap.selectedRef === "HEAD" || snap.selectedRef === snap.head) && snap.query === "") {
          list.push({
            hash: "WORKING",
            short: "",
            parents: snap.hash ? [snap.hash] : [],
            author: "",
            email: "",
            at: Math.floor(Date.now() / 1000),
            subject: t("dirty"),
            refs: "",
            virtual: true
          });
        }
        for (let i = 0; i < (snap.commits || []).length; i++) list.push(snap.commits[i]);
        return list;
      };

      /**
       * Move the commit selection one row up or down and load that commit's
       * detail, mirroring what a click on the row would do. Stops at either end.
       */
      let commitStepLock = false;
      const stepCommit = (dir) => {
        if (commitStepLock) return;
        const snap = dataBus.getSnapshot();
        const list = displayCommitsOf(snap);
        if (list.length === 0) return;
        let i = list.findIndex((c) => c.hash === snap.selectedHash);
        if (i < 0) i = dir > 0 ? -1 : list.length;
        const next = Math.max(0, Math.min(list.length - 1, i + dir));
        const row = list[next];
        if (!row || row.hash === snap.selectedHash) return;
        commitStepLock = true;
        loadDetail(row.hash);
        window.setTimeout(() => { commitStepLock = false; }, 0);
        window.requestAnimationFrame(() => {
          const rows = document.querySelectorAll(".dgit-table .dgit-row[data-hash]");
          for (let r = 0; r < rows.length; r++) {
            if (rows[r].getAttribute("data-hash") !== row.hash) continue;
            if (typeof rows[r].scrollIntoView === "function") rows[r].scrollIntoView({ block: "nearest" });
            break;
          }
        });
      };

      /**
       * Absolute path of a repo-relative path, so a file can be opened through
       * the workspace even when the Git root sits above the session workspace.
       */
      const sourcePathOf = (relPath) => {
        const snap = dataBus.getSnapshot();
        const rel = String(relPath || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
        if (rel === "" || rel.charAt(0) === "/") return rel;
        const root = String(snap.root || snap.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
        return root === "" ? rel : root + "/" + rel;
      };

      /**
       * Whether the working-tree file a diff names is actually gone.
       *
       * The diff itself comes from Git, so a preview can legitimately show a
       * file the working tree no longer has: a deletion, or the old side of a
       * rename. Jumping to source reads the file from disk, so opening that
       * address would just land on the preview's "file does not exist" state.
       * Probing the host's own file route first keeps that dead tab from being
       * created at all.
       *
       * Only a definitive 404 counts as gone; a probe that fails for any other
       * reason (route absent, permission refused) falls through to the old
       * behaviour rather than blocking a jump that might have worked.
       *
       * @returns whether the file is known to be missing.
       */
      const sourceFileGone = async (absPath) => {
        if (absPath === "") return false;
        try {
          const response = await fetch(new URL("api/file?path=" + encodeURIComponent(absPath), originOf()), {
            method: "HEAD",
            credentials: "include"
          });
          return response.status === 404;
        } catch {
          return false;
        }
      };

      /**
       * The path an editor address uses for `absPath`: relative to the session
       * workspace, "" when the file sits outside it.
       *
       * Git roots can sit above the workspace, so `path:../outside.js` style
       * relatives are refused here instead of being handed to the editor,
       * whose file route keeps reads inside the workspace.
       */
      const relInWorkspace = (absPath, cwd) => {
        const abs = String(absPath || "").replace(/\\/g, "/");
        const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
        if (abs === "" || root === "") return "";
        if (abs.indexOf(root + "/") !== 0) return "";
        return abs.slice(root.length + 1);
      };

      /**
       * Hand the jump to the code editor, the way a search result is opened:
       * same workspace, same tab strip, and it can land on a line.
       *
       * @returns whether the editor accepted the jump.
       */
      const openInEditor = (absPath, line, cwd) => {
        const panel = window.__dshEditorPanel;
        if (panel === undefined || panel === null || typeof panel.openFile !== "function") return false;
        const rel = relInWorkspace(absPath, cwd);
        if (rel === "") return false;
        const at = Math.floor(Number(line));
        try {
          panel.openFile(rel, Number.isFinite(at) && at > 0 ? at : 0);
          return true;
        } catch (err) {
          console.error("dsh-idea openInEditor:", err);
          return false;
        }
      };

      /**
       * Open the real file a diff preview is showing, at the change the reader
       * is looking at, in the files workspace.
       *
       * The diff address names a revision, but the jump target is always the
       * working-tree file, so this builds a `file` address rather than reusing
       * the diff's. The editor is tried first because it is the only surface
       * that can reveal a line; the plain file address is the fallback for
       * repositories whose root sits outside the session workspace.
       *
       * @param relPath Repo-relative path the diff names.
       * @param line   1-based new-side line to reveal, 0 to just open the file.
       * @returns whether a navigation was issued.
       */
      const jumpToSourceFile = async (relPath, line) => {
        const snap = dataBus.getSnapshot();
        const session = currentSession();
        const sessionId = snap.sessionId || (session && session.id) || "";
        if (!sessionId || !relPath) return false;
        const cwd = (session && session.cwd) || snap.cwd || "";
        const absPath = sourcePathOf(relPath);
        if (await sourceFileGone(absPath)) {
          showToast(t("jumpMissing"), true);
          return false;
        }
        if (openInEditor(absPath, line, cwd)) return true;
        const sidebar = sidebarRightService();
        if (sidebar === undefined || typeof sidebar.openResource !== "function") return false;
        try {
          // The host preview understands the same `line` param, so a fallback
          // jump still lands on the change instead of the top of the file.
          const at = Math.floor(Number(line));
          const opts = Number.isFinite(at) && at > 0 ? { params: { line: at } } : undefined;
          sidebar.openResource(fileAddressFor(sessionId, cwd, absPath), opts);
          return true;
        } catch (err) {
          console.error("dsh-idea jumpToSourceFile:", err);
          showToast(err && err.message ? String(err.message) : t("jumpFail"), true);
          return false;
        }
      };

      const deleteBranch = async (ref, kind) => {
        const snap = dataBus.getSnapshot();
        const cwd = sessionCwd();
        if (!cwd || !ref) return;
        if (ref === snap.head) {
          showToast(t("deleteCurrent"), true);
          setData({ menu: null });
          return;
        }
        const msg = t("deleteConfirm").replace("{name}", ref);
        try { if (!window.confirm(msg)) { setData({ menu: null }); return; } } catch { setData({ menu: null }); return; }
        await runAction({
          path: DELETE_PATH,
          // The list this menu came from already knows whether the row is a
          // local branch or a remote-tracking one; sending that beats letting
          // the host split the name on "/", which misfiles every `feature/x`.
          body: { cwd, ref, kind: kind === "remote" ? "remote" : "local" },
          ok: "deleteOk",
          fail: "deleteFail",
          loadOpts: { selectedRef: snap.selectedRef === ref ? "" : snap.selectedRef }
        });
      };

      const cherryPick = async () => {
        const snap = dataBus.getSnapshot();
        const cwd = sessionCwd();
        const hash = snap.selectedHash;
        if (!cwd) return;
        if (!hash) {
          showToast(t("cherryNeed"), true);
          return;
        }
        if (hash === "WORKING") {
          showToast(t("cherryWorking"), true);
          return;
        }
        if (hash === snap.hash) {
          showToast(t("cherrySame"), true);
          return;
        }
        await runAction({
          path: CHERRY_PATH,
          body: { cwd, hash },
          working: "cherrying",
          ok: "cherryOk",
          fail: "cherryFail",
          reloadOnFail: true
        });
      };

      const openNewBranch = (ref) => {
        const snap = dataBus.getSnapshot();
        const from = ref || snap.head || "";
        setData({
          menu: null,
          newBranch: {
            from,
            name: "",
            busy: false,
            status: "",
            bad: false
          }
        });
      };

      const closeNewBranch = () => {
        if (dataBus.getSnapshot().newBranch === null) return;
        setData({ newBranch: null });
      };

      const createBranch = async () => {
        const snap = dataBus.getSnapshot();
        const draft = snap.newBranch;
        if (!draft || draft.busy) return;
        const cwd = sessionCwd();
        if (!cwd) return;
        const name = String(draft.name || "").trim();
        if (name === "") {
          setData({ newBranch: { ...draft, status: t("branchRequired"), bad: true } });
          return;
        }
        setData({ newBranch: { ...draft, busy: true, status: t("creating"), bad: false } });
        try {
          const data = await postJson(CREATE_PATH, { cwd, ref: name, from: draft.from || "" });
          if (data && data.ok === false) {
            const cur = dataBus.getSnapshot().newBranch;
            setData({ newBranch: cur ? { ...cur, busy: false, status: errorText(data.error, "createFail"), bad: true } : null });
            return;
          }
          setData({ newBranch: null, checkingOut: false });
          showToast(t("createOk") + " " + name);
          await load({ selectedRef: "" });
        } catch (err) {
          const cur = dataBus.getSnapshot().newBranch;
          setData({ newBranch: cur ? { ...cur, busy: false, status: errorText(err && err.message, "createFail"), bad: true } : null });
        }
      };

      const initRepo = async () => {
        if (dataBus.getSnapshot().initializing) return;
        const cwd = sessionCwd();
        if (!cwd) return;
        await runAction({
          path: INIT_PATH,
          body: { cwd },
          busy: "initializing",
          working: "initing",
          ok: "initOk",
          fail: "initFail",
          loadOpts: { query: "", author: "", since: "", selectedRef: "" }
        });
      };

      const runOperation = async (action) => {
        if (dataBus.getSnapshot().opBusy === true) return;
        const cwd = sessionCwd();
        if (!cwd) return;
        await runAction({
          path: OPERATION_PATH,
          body: { cwd, action },
          busy: "opBusy",
          working: "opWorking",
          ok: action === "abort" ? "opAbortOk" : "opOk",
          fail: "opFail",
          reloadOnFail: true
        });
      };

      const openRenameBranch = (ref, current) => {
        if (!ref) return;
        setData({
          menu: null,
          newBranch: null,
          rename: { ref, name: ref, current: current === true, busy: false, status: "", bad: false }
        });
      };

      const closeRename = () => {
        if (dataBus.getSnapshot().rename === null) return;
        setData({ rename: null });
      };

      const renameBranch = async () => {
        const snap = dataBus.getSnapshot();
        const draft = snap.rename;
        if (!draft || draft.busy) return;
        const cwd = sessionCwd();
        if (!cwd) return;
        const to = String(draft.name || "").trim();
        if (to === "") {
          setData({ rename: { ...draft, status: t("branchRequired"), bad: true } });
          return;
        }
        setData({ rename: { ...draft, busy: true, status: t("renaming"), bad: false } });
        try {
          const data = await postJson(RENAME_PATH, { cwd, ref: draft.ref, to });
          if (data && data.ok === false) {
            const cur = dataBus.getSnapshot().rename;
            setData({ rename: cur ? { ...cur, busy: false, status: errorText(data.error, "renameFail"), bad: true } : null });
            return;
          }
          setData({ rename: null });
          showToast(t("renameOk") + " " + to);
          await load({});
        } catch (err) {
          const cur = dataBus.getSnapshot().rename;
          setData({ rename: cur ? { ...cur, busy: false, status: errorText(err && err.message, "renameFail"), bad: true } : null });
        }
      };

      const pull = async () => {
        const cwd = sessionCwd();
        if (!cwd || dataBus.getSnapshot().pulling) return;
        await runAction({
          path: PULL_PATH,
          body: { cwd },
          busy: "pulling",
          working: "pulling",
          ok: "pullOk",
          fail: "pullFail",
          reloadOnFail: true
        });
      };

      /**
       * Push the current branch — the standalone twin of "Commit and Push".
       *
       * That commit-window button is the only other caller of /push, so without
       * this the commits made by a plain "Commit" had no way out of the local
       * repository at all: the window closes on success and the toolbar only
       * offered Pull. Kept separate from `runCommit` because there is usually no
       * commit to make by the time a user reaches for it.
       */
      const push = async () => {
        const cwd = sessionCwd();
        if (!cwd || dataBus.getSnapshot().pushing) return;
        await runAction({
          path: PUSH_PATH,
          body: { cwd },
          busy: "pushing",
          working: "pushing",
          ok: "pushOk",
          fail: "pushFail",
          reloadOnFail: true
        });
      };

      const mergeRef = async (ref) => {
        const cwd = sessionCwd();
        if (!cwd || !ref) return;
        await runAction({
          path: MERGE_PATH,
          body: { cwd, ref },
          ok: "mergeOk",
          fail: "mergeFail",
          reloadOnFail: true
        });
      };

      const openBranchMenu = (event, ref, current, kind) => {
        if (!ref) return;
        event.preventDefault();
        event.stopPropagation();
        setData({
          menu: {
            x: event.clientX,
            y: event.clientY,
            ref,
            kind: kind === "remote" ? "remote" : "local",
            current: current === true
          }
        });
      };

      let lastSessionKey = "";
      const syncSession = () => {
        if (!uiBus.getSnapshot().visible) return;
        const session = currentSession();
        const key = session === null ? "" : (session.id + "\0" + (session.cwd || ""));
        // A different session/workspace needs the full load (its commit list is
        // unrelated to what is on screen).
        if (key !== lastSessionKey) {
          lastSessionKey = key;
          load({});
          return;
        }
        // Same workspace: only re-read the state. A commit made outside this
        // panel moves HEAD, and that is the one case worth re-fetching the
        // graph for — the periodic tick must not pull the whole log.
        const before = dataBus.getSnapshot();
        refreshStatus().then((data) => {
          if (data === null) return;
          const cur = dataBus.getSnapshot();
          const graphMoved = cur.hash !== before.hash ||
            (cur.local || []).length !== (before.local || []).length ||
            (cur.operation && cur.operation.kind) !== (before.operation && before.operation.kind);
          if (graphMoved) load({ quiet: true });
        });
      };

      const loadTags = async () => {
        const session = currentSession();
        if (session === null || session.cwd === "") return;
        const gitPath = sessionCwd();
        const before = dataBus.getSnapshot();
        try {
          const data = await postJson(TAGS_PATH, { cwd: gitPath });
          // Same guard as refreshStatus: never land a reply whose session or
          // repository went away while the request was in flight.
          const now = currentSession();
          const cur = dataBus.getSnapshot();
          if (now === null || now.id !== session.id || cur.sessionId !== before.sessionId || cur.cwd !== before.cwd) return;
          setData({ tags: Array.isArray(data.tags) ? data.tags : [] });
        } catch (err) {
          console.error("dsh-git-manager tags:", err);
        }
      };

      const selectedPaths = (snap) => Object.keys(snap.selected || {}).filter((p) => snap.selected[p]);
      const JUNK_NAMES = {
        ".DS_Store": 1, "Thumbs.db": 1, "ehthumbs.db": 1, "desktop.ini": 1,
        ".directory": 1, ".Spotlight-V100": 1, ".Trashes": 1,
        ".AppleDouble": 1, ".LSOverride": 1, "npm-debug.log": 1, "yarn-error.log": 1,
        "pnpm-debug.log": 1, ".eslintcache": 1
      };
      const JUNK_EXT = { pyc: 1, pyo: 1, pyd: 1, class: 1, swp: 1, swo: 1, tmp: 1 };
      const JUNK_DIR = { __pycache__: 1, ".pytest_cache": 1 };
      const isJunkPath = (path) => {
        const parts = String(path || "").split("/");
        for (let i = 0; i < parts.length; i++) {
          const name = parts[i];
          if (!name) continue;
          if (JUNK_NAMES[name] === 1 || JUNK_DIR[name] === 1) return true;
          if (name.charAt(0) === "." && name.slice(-4) === ".swp") return true;
          if (name.charAt(name.length - 1) === "~") return true;
          const dot = name.lastIndexOf(".");
          if (dot > 0 && JUNK_EXT[name.slice(dot + 1).toLowerCase()] === 1) return true;
        }
        return false;
      };

      /**
       * Normalize the host's file list into the commit window's shape.
       *
       * Tracked changes start checked; untracked files do not. The two section
       * headers start expanded.
       */
      const commitFilesFrom = (raw) => {
        const files = (Array.isArray(raw) ? raw : []).filter((f) => f && f.path && !isJunkPath(f.path));
        const selected = {};
        for (let i = 0; i < files.length; i++) {
          if (String(files[i].xy || "") !== "??") selected[files[i].path] = true;
        }
        return { files, selected, openDirs: { changes: true, unversioned: true } };
      };

      const openCommit = async () => {
        const session = currentSession();
        if (session === null || session.cwd === "") {
          showToast(t(session === null ? "noSession" : "noWorkspace"), true);
          return;
        }
        // The commit window lives inside the Git dock. ⌘⇧K opens the dock (and
        // the editor it hangs off); a collapsed column used to swallow the key
        // because `visible` stayed true while nothing was on screen.
        enterGitFullscreen();
        // Tree + diff + message do not fit the log list's height, so the dock
        // takes most of the column while the window is up.
        try { document.documentElement.dataset[TALL_ATTR] = "1"; } catch {}
        const gitPath = sessionCwd() || session.cwd;
        // The dock already polls `git status`, so when its file list matches
        // this repo we can open instantly with it and refresh in the
        // background; only a cold panel blocks on a fresh /state fetch.
        const dock = dataBus.getSnapshot();
        const dockReady = dock.repo === true && dock.cwd === gitPath && Array.isArray(dock.files) && dock.files.length > 0;
        if (dockReady) {
          const { files, selected, openDirs } = commitFilesFrom(dock.files);
          commitBus.set({
            open: true, files, selected, openDirs, message: "", busy: false,
            generating: false, amend: false,
            status: "", bad: false, cwd: gitPath, diffPath: "", diffText: "", diffLoading: false, menu: null
          });
          const first = commitOrderedPaths({ files })[0];
          if (first) openCommitDiff(first);
          // One status refresh for drift. The preview above already loaded the
          // diff, so this must not fetch it again or wipe the box.
          reloadCommitFiles(gitPath, { status: "", bad: false }, false);
          return;
        }
        commitBus.set({
          open: true, files: [], selected: {}, openDirs: { changes: true, unversioned: true },
          message: "", busy: true, generating: false, amend: false,
          status: t("loading"), bad: false, menu: null,
          diffPath: "", diffText: "", diffLoading: false, cwd: gitPath
        });
        try {
          const data = await postJson(STATE_PATH, { cwd: gitPath });
          const { files, selected, openDirs } = commitFilesFrom(data.files);
          commitBus.set({
            open: true, files, selected, openDirs, message: "", busy: false,
            generating: false, amend: false,
            status: "", bad: false, cwd: gitPath, diffPath: "", diffText: "", diffLoading: false, menu: null
          });
          const first = commitOrderedPaths({ files })[0];
          if (first) openCommitDiff(first);
        } catch (err) {
          commitBus.set({ ...commitBus.getSnapshot(), busy: false, status: err && err.message ? String(err.message) : t("commitFail"), bad: true });
        }
      };

      /**
       * Re-read the change set after a rollback, keeping the dialog's own state
       * (commit message, expansion, and which checkboxes the user had ticked).
       *
       * Selection is preserved per path rather than wholesale: an untouched file
       * keeps whatever the user chose, and a path that disappeared is dropped.
       * The preview diff is refreshed too, otherwise it would still show the
       * content that was just discarded.
       *
       * `patch` is applied last so the caller can leave a final status in the
       * footer — the rollback that triggered this reload has already finished,
       * and a successful one must not leave "rolling back…" on screen.
       *
       * The snapshot is read after the status round-trip, so a message typed
       * while it was in flight is kept. `refreshDiff` is false when the caller
       * already opened the preview and only wants the file list brought up to date.
       */
      const reloadCommitFiles = async (cwd, patch, refreshDiff) => {
        try {
          const data = await postJson(STATE_PATH, { cwd });
          const snap = commitBus.getSnapshot();
          if (snap.open !== true) return;
          const { files, selected, openDirs } = commitFilesFrom(data.files);
          const next = {};
          for (let i = 0; i < files.length; i++) {
            const path = files[i].path;
            const keep = Object.prototype.hasOwnProperty.call(snap.selected || {}, path) ? snap.selected[path] : selected[path];
            next[path] = keep === true;
          }
          const stillThere = snap.diffPath !== "" && files.some((f) => f.path === snap.diffPath);
          commitBus.set({
            ...snap,
            files,
            selected: next,
            openDirs: { ...openDirs, ...(snap.openDirs || {}) },
            busy: false,
            menu: null,
            diffPath: stillThere ? snap.diffPath : "",
            diffText: stillThere ? snap.diffText : "",
            diffLoading: stillThere ? snap.diffLoading : false,
            ...(patch || {})
          });
          if (refreshDiff !== false && stillThere) openCommitDiff(snap.diffPath);
        } catch (err) {
          commitBus.set({
            ...commitBus.getSnapshot(),
            busy: false,
            menu: null,
            status: err && err.message ? String(err.message) : t("rollbackFail"),
            bad: true
          });
        }
      };

      /**
       * Restore the context-clicked path — or the whole checked set when the
       * click was on a checkbox — to its committed version.
       *
       * Untracked paths have no committed version, so for them "rollback" means
       * deleting the file; the confirmation says so explicitly.
       */
      const rollbackFiles = async (paths) => {
        const snap = commitBus.getSnapshot();
        const session = currentSession();
        const cwd = sessionCwd() || snap.cwd;
        if (!cwd) return;
        const list = [];
        const seen = new Set();
        for (let i = 0; i < (paths || []).length; i++) {
          const p = paths[i];
          if (typeof p !== "string" || p === "" || seen.has(p)) continue;
          seen.add(p);
          list.push(p);
        }
        if (list.length === 0) return;
        const byPath = new Map();
        for (let i = 0; i < (snap.files || []).length; i++) byPath.set(snap.files[i].path, snap.files[i]);
        const onlyUntracked = list.every((p) => {
          const file = byPath.get(p);
          return file !== undefined && String(file.xy || "") === "??";
        });
        const label = list.length === 1 ? baseNameOf(list[0]) : "";
        // Only an all-untracked set is really a deletion; a mixed set is a
        // rollback that happens to remove some files, so it keeps the generic
        // "cannot be recovered" wording.
        const msg = onlyUntracked && list.length === 1
          ? t("rollbackUntrackedConfirm").replace("{name}", label)
          : list.length === 1
            ? t("rollbackConfirm").replace("{name}", label)
            : t("rollbackConfirmMany").replace("{n}", String(list.length));
        try {
          if (!window.confirm(msg)) { commitBus.set({ ...commitBus.getSnapshot(), menu: null }); return; }
        } catch {
          commitBus.set({ ...commitBus.getSnapshot(), menu: null });
          return;
        }
        commitBus.set({ ...commitBus.getSnapshot(), menu: null, busy: true, status: t("rollingBack"), bad: false });
        try {
          const data = await postJson(ROLLBACK_PATH, { cwd, paths: list });
          if (data && data.ok === false) {
            // Keep the failure visible in the footer: the reload must not clear
            // it, or the user would only see the toast-less silence.
            await reloadCommitFiles(cwd, {
              status: rollbackErrorText(data.error),
              bad: true
            });
            return;
          }
          const n = Array.isArray(data && data.rolledBack) ? data.rolledBack.length : list.length;
          showToast(n === 1 ? t("rollbackOkOne").replace("{name}", baseNameOf(list[0])) : t("rollbackOk").replace("{n}", String(n)));
          await reloadCommitFiles(cwd, { status: "", bad: false });
          if (uiBus.getSnapshot().visible) load({ quiet: true });
        } catch (err) {
          await reloadCommitFiles(cwd, {
            status: err && err.message ? String(err.message) : t("rollbackFail"),
            bad: true
          });
        }
      };

      /**
       * Turn a host rollback error into text the user can act on.
       *
       * `path-is-directory:` is the data-loss guard: a tracked file was replaced
       * by a directory holding untracked files, and restoring it would delete
       * them. That detail is worth spelling out rather than showing the raw code.
       */
      const rollbackErrorText = (error) => {
        const raw = error ? String(error) : "";
        const marker = "path-is-directory:";
        if (raw.indexOf(marker) === 0) {
          return t("rollbackDirBlocked").replace("{name}", raw.slice(marker.length));
        }
        return raw || t("rollbackFail");
      };

      const openCommitDiff = async (relPath) => {
        const snap = commitBus.getSnapshot();
        const session = currentSession();
        const cwd = sessionCwd() || snap.cwd;
        if (!cwd || !relPath) return;
        commitBus.set({ ...snap, diffPath: relPath, diffText: "", diffLoading: true });
        try {
          const data = await postJson(DIFF_PATH, { cwd, hash: "WORKING", path: relPath });
          const cur = commitBus.getSnapshot();
          if (cur.diffPath !== relPath) return;
          commitBus.set({ ...cur, diffLoading: false, diffText: typeof data.diff === "string" ? data.diff : "" });
        } catch (err) {
          const cur = commitBus.getSnapshot();
          if (cur.diffPath !== relPath) return;
          commitBus.set({ ...cur, diffLoading: false, diffText: "" });
          showToast(err && err.message ? String(err.message) : t("noDiff"), true);
        }
      };

      /**
       * The commit window's flat file rows in draw order — tracked changes
       * first, then untracked files, each sorted by path exactly as the tree
       * renders them. The arrow-key stepper and the footer buttons both walk
       * this list so "next file" always matches what is on screen.
       */
      const commitOrderedPaths = (snap) => {
        const changed = [];
        const extra = [];
        for (let i = 0; i < (snap.files || []).length; i++) {
          const f = snap.files[i];
          if (!f || !f.path) continue;
          if (String(f.xy || "") === "??") extra.push(f);
          else changed.push(f);
        }
        const byPath = (a, b) => String(a.path).localeCompare(String(b.path));
        changed.sort(byPath);
        extra.sort(byPath);
        return changed.concat(extra).map((f) => f.path);
      };

      let commitFileStepLock = false;
      const stepCommitFile = (dir) => {
        if (commitFileStepLock) return;
        const snap = commitBus.getSnapshot();
        if (!snap.open || snap.busy) return;
        const paths = commitOrderedPaths(snap);
        if (paths.length === 0) return;
        let i = paths.indexOf(snap.diffPath);
        if (i < 0) i = dir > 0 ? -1 : paths.length;
        const next = paths[Math.max(0, Math.min(paths.length - 1, i + dir))];
        if (!next || next === snap.diffPath) return;
        commitFileStepLock = true;
        openCommitDiff(next);
        window.setTimeout(() => { commitFileStepLock = false; }, 0);
        window.requestAnimationFrame(() => {
          const rows = document.querySelectorAll(".dgit-ctree .dgit-crow");
          for (let r = 0; r < rows.length; r++) {
            if (rows[r].getAttribute("title") !== next) continue;
            if (typeof rows[r].scrollIntoView === "function") rows[r].scrollIntoView({ block: "nearest" });
            break;
          }
        });
      };

      /**
       * Ask the host for a commit message and stream it into the box.
       *
       * The message is only a suggestion: it lands in the editable textarea, so
       * a generated line the user dislikes costs nothing but a keystroke. The
       * host reads the staged diff when there is one and the worktree diff
       * otherwise, so this never depends on the checkbox selection.
       */
      let genSeq = 0;
      const generateMessage = async () => {
        const snap = commitBus.getSnapshot();
        if (!snap.open || snap.busy || snap.generating) return;
        const session = currentSession();
        const cwd = sessionCwd() || snap.cwd;
        if (!cwd) return;
        // Each click owns a sequence number: a later click, or closing the
        // window, retires this run so a slow reply cannot overwrite newer text.
        const seq = ++genSeq;
        const stale = () => seq !== genSeq || !commitBus.getSnapshot().open;
        // The button itself carries the progress label, so the status slot is
        // cleared rather than repeating the same words beside it.
        commitBus.set({ ...snap, generating: true, status: "", bad: false, message: "" });
        const fail = (detail) => {
          if (stale()) return;
          const err = String(detail || "");
          commitBus.set({
            ...commitBus.getSnapshot(),
            generating: false,
            // Never invent a message on failure: leave the box as the user had
            // it and say what went wrong.
            message: snap.message,
            status: err === "no-changes" ? t("genNoChanges") : (err || t("genFail")),
            bad: true
          });
        };
        try {
          const response = await fetch(new URL(MESSAGE_PATH, originOf()), {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/x-ndjson" },
            credentials: "include",
            body: JSON.stringify({ cwd, lang: langBus.getSnapshot(), sessionId: session && session.id ? String(session.id) : "" })
          });
          if (!response.ok || response.body === null) {
            let detail = "HTTP " + response.status;
            try {
              const data = await response.json();
              if (data && data.error) detail = String(data.error);
            } catch {}
            fail(detail);
            return;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let streamed = "";
          let terminal = null;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line === "") continue;
              let row = null;
              try { row = JSON.parse(line); } catch { continue; }
              if (row && typeof row.delta === "string" && row.delta !== "") {
                streamed += row.delta;
                if (stale()) continue;
                // Paint the raw reply as it is written; the terminal row
                // replaces it with the cleaned text.
                commitBus.set({ ...commitBus.getSnapshot(), message: streamed });
              } else if (row && typeof row === "object" && ("ok" in row || "error" in row || "message" in row)) {
                terminal = row;
              }
            }
          }
          if (stale()) return;
          if (terminal === null) { fail(streamed === "" ? "" : "incomplete-response"); return; }
          if (terminal.ok === false) { fail(terminal.error ? String(terminal.error) : ""); return; }
          const finalText = typeof terminal.message === "string" && terminal.message !== "" ? terminal.message : streamed;
          commitBus.set({ ...commitBus.getSnapshot(), generating: false, message: finalText, status: "", bad: false });
          showToast(t("genOk"));
        } catch (err) {
          fail(err && err.message ? String(err.message) : "");
        }
      };

      const runCommit = async (alsoPush) => {
        const snap = commitBus.getSnapshot();
        const session = currentSession();
        const cwd = sessionCwd() || snap.cwd;
        if (!cwd) return;
        const paths = selectedPaths(snap);
        if (paths.length === 0) {
          commitBus.set({ ...snap, status: t("noFiles"), bad: true });
          return;
        }
        // An amend may legitimately keep the existing message, so only a plain
        // commit insists on text being present.
        if (snap.amend !== true && String(snap.message || "").trim() === "") {
          commitBus.set({ ...snap, status: t("noMessage"), bad: true });
          return;
        }
        commitBus.set({ ...snap, busy: true, status: t("committing"), bad: false });
        try {
          const data = await postJson(COMMIT_PATH, { cwd, message: snap.message, paths, amend: snap.amend === true });
          if (data && data.ok === false) {
            commitBus.set({ ...commitBus.getSnapshot(), busy: false, status: data.error ? String(data.error) : t("commitFail"), bad: true });
            return;
          }
          if (alsoPush) {
            commitBus.set({ ...commitBus.getSnapshot(), status: t("pushing") });
            const pushed = await postJson(PUSH_PATH, { cwd });
            if (pushed && pushed.ok === false) {
              commitBus.set({ ...commitBus.getSnapshot(), busy: false, status: pushed.error ? String(pushed.error) : t("pushFail"), bad: true });
              if (uiBus.getSnapshot().visible) load({});
              return;
            }
            showToast(t("pushOk"));
          } else showToast(t("commitOk"));
          commitBus.set({ ...commitBus.getSnapshot(), open: false, busy: false, status: "" });
          if (uiBus.getSnapshot().visible) load({});
        } catch (err) {
          commitBus.set({ ...commitBus.getSnapshot(), busy: false, status: err && err.message ? String(err.message) : t("commitFail"), bad: true });
        }
      };

      /**
       * Install the "the current session changed" wake-up.
       *
       * Both sources are subscribed, because either can move the selection: the
       * `uiSession` binding is the selection signal itself, while the list store
       * also carries the row's `cwd` and its `mainView` retention (the fallback
       * path). Watching only the list missed a selection that did not change any
       * row, and watching only `uiSession` missed a workspace change.
       *
       * Read through injections rather than once at apply time: neither provider
       * is in this plugin's inject list, so either can arrive after this apply
       * runs. Reading them eagerly left the stores unwatched and the panel blank
       * until the 15s poll — `syncSession` right below only sees an empty list
       * and does nothing.
       */
      // The list store notifies for far more than "the current session changed"
      // (any title, model, or cwd edit) and `syncSession` costs a `/state` round
      // trip, so both subscriptions share one memo of the pair acted on: a change
      // that lands on both sources refreshes once, not twice.
      let lastSelectionKey = null;
      const onSelectionMaybeChanged = () => {
        let key = null;
        try {
          const sessions = sessionsService();
          const snap = sessions === undefined || sessions.list === undefined ? undefined : sessions.list.getSnapshot();
          const id = uiSessionId() ?? (snap === undefined || snap === null ? undefined : mainSessionId(snap));
          const row = snap === undefined || snap === null || snap.byId === undefined || id === undefined ? undefined : snap.byId[id];
          key = String(id) + "\0" + String(row && row.cwd);
        } catch {}
        if (key === lastSelectionKey) return;
        lastSelectionKey = key;
        syncSession();
      };
      const watchSelection = (source) => {
        if (source === undefined || typeof source.subscribe !== "function") return;
        ctx.effect(() => {
          const stop = source.subscribe(onSelectionMaybeChanged);
          return typeof stop === "function" ? stop : undefined;
        });
      };
      ctx.inject(["uiSession"], (uiCtx) => {
        const ui = uiCtx.uiSession;
        watchSelection(ui === undefined || ui.adapter === undefined ? undefined : ui.adapter.current);
      });
      ctx.inject(["sessions"], (sessionsCtx) => {
        const sessions = sessionsCtx.sessions;
        watchSelection(sessions === undefined ? undefined : sessions.list);
      });
      syncSession();

      const useBus = (bus) => {
        const [value, setValue] = React.useState(bus.getSnapshot);
        React.useEffect(() => {
          const update = () => setValue(bus.getSnapshot());
          update();
          return bus.subscribe(update);
        }, [bus]);
        return value;
      };

      function IconSearch() {
        return React.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
          React.createElement("circle", { cx: 7, cy: 7, r: 4.2, stroke: "currentColor", strokeWidth: 1.4 }),
          React.createElement("path", { d: "M10.2 10.2L13 13", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
        );
      }
      function IconRefresh() {
        return React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
          React.createElement("path", { d: "M13 8a5 5 0 1 1-1.3-3.4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
          React.createElement("path", { d: "M13 3.5V6h-2.5", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
        );
      }
      function IconCherry() {
        return React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
          React.createElement("path", { d: "M8 7.2C8 7.2 9.6 3.2 12.4 2.4", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
          React.createElement("path", { d: "M8 7.2C8 7.2 6.2 3.6 3.6 3", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
          React.createElement("circle", { cx: 5.2, cy: 11, r: 2.4, fill: "currentColor" }),
          React.createElement("circle", { cx: 10.4, cy: 10.4, r: 2.4, fill: "currentColor" })
        );
      }
      function IconPush() {
        // The refresh glyph's mirror image: same arc, arrow pointing away from
        // the repo instead of into it, so Push reads as "Pull, but outbound".
        return React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
          React.createElement("path", { d: "M3 8a5 5 0 1 0 1.3-3.4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
          React.createElement("path", { d: "M3 3.5V6h2.5", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
        );
      }
      function IconChev({ up }) {
        return React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
          React.createElement("path", { d: up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
        );
      }

      function BranchRow({ name, current, selected, onSelect, onCheckout, onMenu, title }) {
        return React.createElement("button", {
          type: "button",
          className: "dgit-brow",
          "data-on": selected ? "true" : "false",
          "data-current": current ? "true" : "false",
          title: title || t("doubleCheckout"),
          onClick: onSelect,
          onDoubleClick: onCheckout,
          onContextMenu: onMenu
        },
          React.createElement("span", { className: "dgit-dot", style: current ? undefined : { background: "#6d7684" } }),
          React.createElement("span", { className: "dgit-bname" }, name)
        );
      }

      function GitDiffTitle({ useTabInfo }) {
        const info = useTabInfo();
        const parsed = parseGitDiffAddress((info.tab && info.tab.navigation && info.tab.navigation.address) || (info.tab && info.tab.contentId) || "");
        const name = parsed && parsed.path ? parsed.path.split("/").pop() : t("diffTitle");
        return React.createElement("span", null, name);
      }

      function GitDiffBody({ useTabInfo }) {
        const info = useTabInfo();
        const parsed = parseGitDiffAddress((info.tab && info.tab.navigation && info.tab.navigation.address) || (info.tab && info.tab.contentId) || "");
        const [text, setText] = React.useState("");
        const [loading, setLoading] = React.useState(true);
        const path = parsed && parsed.path;
        const visible = !!(info.tab && info.tab.visible);
        // The line the diff is scrolled to; DiffView keeps it current so the
        // chord lands on the change on screen rather than the file's top.
        const jumpRef = React.useRef(0);
        React.useEffect(() => {
          if (!path) return undefined;
          // The jump chord mirrors IDEA (F4 by default): the diff preview names
          // the file it is showing, and this opens that file at the change in
          // the editor. Bound on the window because a diff tab body is rarely
          // the focused element, and rebound from Settings → 快捷键.
          const onKey = (event) => {
            if (!gitChordHeld("git.jumpToSource", event)) return;
            if (!visible) return;
            // A floated diff and a docked one can be visible together; the
            // first handler to see the key claims it so only one file opens.
            if (event.__dgitF4 === true) return;
            // The commit window covers the tab bodies and binds the same chord
            // for its own preview; without this both handlers would open a file
            // at once.
            if (commitBus.getSnapshot().open) return;
            const focus = event.target;
            const tag = focus && focus.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            if (focus && focus.isContentEditable === true) return;
            event.__dgitF4 = true;
            event.preventDefault();
            event.stopPropagation();
            jumpToSourceFile(path, jumpRef.current);
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, [path, visible]);
        React.useEffect(() => {
          if (!parsed) {
            setLoading(false);
            setText("");
            return undefined;
          }
          const session = currentSession();
          // The diff address names the session it belongs to; a tab that
          // survives a session switch must keep reading that session's repo,
          // so resolve the cwd from that session's row, not the current one.
          const sessions = sessionsService();
          const listSnap = sessions === undefined || sessions.list === undefined ? undefined : sessions.list.getSnapshot();
          const owner = listSnap === undefined || listSnap === null || listSnap.byId === undefined ? undefined : listSnap.byId[parsed.sessionId];
          const ownerCwd = owner !== undefined && typeof owner.cwd === "string" ? owner.cwd : "";
          const cwd = ownerCwd || sessionCwd() || (session && session.cwd) || dataBus.getSnapshot().cwd;
          if (!cwd) {
            setLoading(false);
            setText("");
            return undefined;
          }
          let cancelled = false;
          setLoading(true);
          postJson(DIFF_PATH, { cwd, hash: parsed.hash, path: parsed.path }).then((data) => {
            if (cancelled) return;
            setText(typeof data.diff === "string" ? data.diff : "");
            setLoading(false);
          }).catch((err) => {
            if (cancelled) return;
            setText("");
            setLoading(false);
            console.error("dsh-git-manager diff tab:", err);
          });
          return () => { cancelled = true; };
        }, [parsed && parsed.sessionId, parsed && parsed.hash, parsed && parsed.path]);
        if (!parsed) return React.createElement("div", { className: "dgit-empty" }, t("noDiff"));
        const short = parsed.hash === "WORKING" ? t("dirty") : String(parsed.hash).slice(0, 7);
        return React.createElement("div", { className: "dgit-diffpane" },
          React.createElement("div", { className: "dgit-diffhead" },
            React.createElement("strong", { title: parsed.path }, parsed.path.split("/").pop()),
            React.createElement("span", null, parsed.path),
            React.createElement("span", null, short),
            React.createElement("span", { className: "dgit-spacer" }),
            React.createElement("button", {
              type: "button",
              className: "dgit-jumpbtn",
              title: t("jumpSource", { key: gitChordLabel("git.jumpToSource") }),
              onClick: () => jumpToSourceFile(parsed.path, jumpRef.current)
            }, gitChordLabel("git.jumpToSource"))
          ),
          React.createElement(DiffView, { text, loading, jumpRef })
        );
      }

      /**
       * A unified diff that also tracks *where* the reader is.
       *
       * The jump chord needs a line, not just a file. The hunk around the
       * viewport centre is the one the reader is looking at, so its first
       * changed line is published into `jumpRef` — on every new diff and on
       * every scroll — and the F4 handlers read it when the key fires.
       */
      function DiffView({ text, loading, jumpRef }) {
        const preRef = React.useRef(null);
        const geoRef = React.useRef(null);
        const frameRef = React.useRef(0);
        const raw = String(text || "");

        // Row at the viewport centre. Every row is one unwrapped line, so the
        // height is uniform and the row is plain arithmetic — no per-row
        // measurement, which matters on diffs with thousands of spans.
        const visibleRow = () => {
          const el = preRef.current;
          if (!el) return 0;
          const lh = parseFloat(window.getComputedStyle(el).lineHeight);
          if (!Number.isFinite(lh) || lh <= 0) return 0;
          // `.dgit-diff` pads 6px above the first row.
          return Math.max(0, Math.floor((el.scrollTop + el.clientHeight / 2 - 6) / lh));
        };
        const publish = () => {
          if (jumpRef === undefined || jumpRef === null) return;
          const geo = geoRef.current;
          jumpRef.current = geo === null ? 0 : diffLineAt(geo.hunks, visibleRow());
        };

        React.useEffect(() => {
          geoRef.current = loading ? null : diffGeometry(raw);
          publish();
        }, [raw, loading]);
        React.useEffect(() => () => {
          if (frameRef.current !== 0) {
            try { window.cancelAnimationFrame(frameRef.current); } catch {}
            frameRef.current = 0;
          }
        }, []);

        const onScroll = () => {
          if (typeof window.requestAnimationFrame !== "function") { publish(); return; }
          if (frameRef.current !== 0) return;
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = 0;
            publish();
          });
        };

        if (loading) return React.createElement("div", { className: "dgit-diff" }, t("loading"));
        if (raw.trim() === "") return React.createElement("div", { className: "dgit-diff" }, t("noDiff"));
        const lines = raw.replace(/\n$/, "").split("\n");
        // Huge diffs skip per-line vnodes; coloring is not worth thousands of nodes.
        if (lines.length > 800) {
          return React.createElement("pre", { ref: preRef, onScroll, className: "dgit-diff dgit-diffplain" }, raw);
        }
        return React.createElement("pre", { ref: preRef, onScroll, className: "dgit-diff" },
          lines.map((line, i) => {
            let k = " ";
            if (line.indexOf("+++") === 0 || line.indexOf("---") === 0 || line.indexOf("diff ") === 0 || line.indexOf("index ") === 0) k = "h";
            else if (line.indexOf("@@") === 0) k = "@";
            else if (line.charAt(0) === "+") k = "+";
            else if (line.charAt(0) === "-") k = "-";
            return React.createElement("span", { key: i, className: "dgit-dl", "data-k": k }, line === "" ? "\n" : line + "\n");
          })
        );
      }

      function fileStatus(xy) {
        const s = String(xy || "  ");
        if (s === "??") return "untracked";
        if (s.indexOf("D") >= 0) return "del";
        if (s.indexOf("A") >= 0 || s.indexOf("?") >= 0) return "add";
        return "mod";
      }

      /**
       * File glyph kind for the flat commit list, chosen from the extension so
       * the icon carries the same information a directory tree used to.
       */
      function fileKind(file) {
        const name = String((file && (file.name || file.path)) || "");
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        if (ext === "java" || ext === "kt" || ext === "scala") return "java";
        if (ext === "xml" || ext === "yml" || ext === "yaml") return "xml";
        if (ext === "sql") return "sql";
        if (ext === "md" || ext === "markdown") return "md";
        if (ext === "bat" || ext === "cmd" || ext === "sh") return "script";
        if (ext === "properties" || ext === "conf" || ext === "ini") return "config";
        if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx" || ext === "json") return "code";
        if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "svg" || ext === "webp") return "image";
        return "text";
      }

      /** Directory portion of a repo-relative path, "" for a root-level file. */
      function dirOf(path) {
        const normalized = String(path || "");
        const slash = normalized.lastIndexOf("/");
        return slash < 0 ? "" : normalized.slice(0, slash);
      }

      function baseNameOf(path) {
        const normalized = String(path || "");
        const slash = normalized.lastIndexOf("/");
        return slash < 0 ? normalized : normalized.slice(slash + 1);
      }

      // Single-color stroke glyphs per file kind. Kept small and inline so the
      // plugin stays dependency-free, matching the rest of this bundle.
      const FILE_GLYPH = {
        java: "M6 2.5h2.6L12 6v7.5H6zM8.6 2.5V6H12",
        xml: "M5.5 5L3 8l2.5 3M10.5 5L13 8l-2.5 3",
        sql: "M3 4.5c0-1 2-1.5 4.5-1.5S12 3.5 12 4.5 10 6 7.5 6 3 5.5 3 4.5zM3 4.5v7c0 1 2 1.5 4.5 1.5s4.5-.5 4.5-1.5v-7",
        md: "M3 4h10v8H3zM5 10V6l2 2 2-2v4M10.5 6v4M9.5 9l1 1.5L11.5 9",
        script: "M4 5l-2 3 2 3M12 5l2 3-2 3M9 4l-2 8",
        config: "M8 2.5l4.5 2.6v5.8L8 13.5l-4.5-2.6V5.1z",
        code: "M6 5L3 8l3 3M10 5l3 3-3 3",
        image: "M3 4h10v8H3zM3 9.5l2.5-2 2 2 2.5-3 3 3.5",
        text: "M4 3h8M4 6h8M4 9h8M4 12h5"
      };

      function FileGlyph(props) {
        const kind = props.kind;
        const d = FILE_GLYPH[kind] || FILE_GLYPH.text;
        return React.createElement("svg", {
          className: "dgit-ficon",
          "data-type": kind,
          width: 15,
          height: 15,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true"
        }, React.createElement("path", {
          d: d,
          stroke: "currentColor",
          "stroke-width": 1.3,
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        }));
      }

      /** "9 files" in English, bare "9" in Chinese where the heading already says 文件. */
      function countLabel(n) {
        const unit = t("fileUnit");
        return unit === "" ? String(n) : n + " " + unit;
      }

      function CommitDialog(props) {
        const snap = useBus(commitBus);
        const ui = useBus(uiBus);
        useBus(langBus);
        // Line of the change the preview is scrolled to, kept by DiffView.
        const jumpRef = React.useRef(0);
        React.useEffect(() => {
          if (!snap.open) return undefined;
          const onKey = (event) => {
            if (event.key === "Escape" && !commitBus.getSnapshot().busy) {
              event.preventDefault();
              // Escape backs out of the context menu first; only a second press
              // closes the dialog.
              if (commitBus.getSnapshot().menu) {
                commitBus.set({ ...commitBus.getSnapshot(), menu: null });
                return;
              }
              commitBus.set({ ...commitBus.getSnapshot(), open: false });
              return;
            }
            // The jump chord opens the file the commit window is previewing as
            // a diff, at the change in view.
            if (!gitChordHeld("git.jumpToSource", event)) {
              // ↑/↓ walk the file list on the left, loading each file's diff,
              // like the file arrows in the log detail pane. The commit message
              // textarea and the checkboxes keep their own arrow behaviour.
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const focus = event.target;
              const ftag = focus && focus.tagName;
              if (ftag === "TEXTAREA" || ftag === "INPUT" || ftag === "SELECT") return;
              if (focus && focus.isContentEditable === true) return;
              if (event.isComposing === true) return;
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              if (commitBus.getSnapshot().menu) return;
              event.preventDefault();
              event.stopPropagation();
              stepCommitFile(event.key === "ArrowDown" ? 1 : -1);
              return;
            }
            if (event.__dgitF4 === true) return;
            const tag = event.target && event.target.tagName;
            if (tag === "TEXTAREA" || tag === "INPUT") return;
            const diffPath = commitBus.getSnapshot().diffPath;
            if (!diffPath) return;
            event.__dgitF4 = true;
            event.preventDefault();
            event.stopPropagation();
            jumpToSourceFile(diffPath, jumpRef.current);
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, [snap.open]);
        if (!snap.open) return null;
        const changed = [];
        const extra = [];
        for (let i = 0; i < (snap.files || []).length; i++) {
          if (String(snap.files[i].xy || "") === "??") extra.push(snap.files[i]);
          else changed.push(snap.files[i]);
        }
        const setSel = (paths, on) => {
          // Read the bus, not the render-time `snap`: a background reload or
          // diff fetch may have landed since this render, and spreading the
          // stale snapshot would silently undo it.
          const cur = commitBus.getSnapshot();
          const next = { ...cur.selected };
          for (let i = 0; i < paths.length; i++) next[paths[i]] = on;
          commitBus.set({ ...cur, selected: next });
        };
        // Flat, IDEA-style list: one row per file, with the directory trail
        // rendered after the name. Files are ordered by path so entries that
        // share a directory stay adjacent.
        //
        // Right-clicking restores that one file. The menu also offers a
        // checkbox-aware "rollback selected" variant, mirroring how the log's
        // file rows behave elsewhere in the panel.
        const selectedForRow = (file) => {
          const picks = selectedPaths(snap);
          if (snap.selected[file.path] && picks.length > 1) return picks;
          return [file.path];
        };
        const renderRow = (file) => {
          const k = fileStatus(file.xy);
          const name = file.name || baseNameOf(file.path);
          const dir = dirOf(file.path);
          const active = snap.diffPath === file.path;
          return React.createElement("div", {
            key: file.path,
            className: "dgit-crow",
            "data-on": active ? "true" : "false",
            title: file.path,
            onContextMenu: (event) => {
              event.preventDefault();
              event.stopPropagation();
              commitBus.set({
                ...commitBus.getSnapshot(),
                menu: {
                  x: event.clientX,
                  y: event.clientY,
                  path: file.path,
                  paths: selectedForRow(file)
                }
              });
            }
          },
            React.createElement("input", {
              type: "checkbox",
              checked: !!snap.selected[file.path],
              onChange: () => setSel([file.path], !snap.selected[file.path])
            }),
            React.createElement("span", {
              className: "dgit-cbody",
              onClick: () => openCommitDiff(file.path)
            },
              React.createElement(FileGlyph, { kind: fileKind(file) }),
              React.createElement("span", {
                className: "dgit-cname",
                "data-k": k
              }, name),
              dir === "" ? null : React.createElement("span", { className: "dgit-cdir" }, dir)
            )
          );
        };
        const section = (id, label, list) => {
          if (list.length === 0) return null;
          const paths = list.map((f) => f.path);
          const on = paths.every((p) => snap.selected[p]);
          const open = snap.openDirs[id] !== false;
          const ordered = list.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
          return React.createElement("div", { key: id, className: "dgit-cgroup" },
            React.createElement("label", { className: "dgit-csec" },
              React.createElement("input", { type: "checkbox", checked: on, onChange: () => setSel(paths, !on) }),
              React.createElement("span", {
                style: { cursor: "pointer" },
                onClick: (event) => {
                  event.preventDefault();
                  const cur = commitBus.getSnapshot();
                  commitBus.set({ ...cur, openDirs: { ...cur.openDirs, [id]: !open } });
                }
              }, (open ? "▾ " : "▸ ") + label),
              React.createElement("span", { className: "dgit-ccount" }, countLabel(list.length))
            ),
            open ? ordered.map(renderRow) : null
          );
        };
        return React.createElement("div", { className: "dgit-commit", role: "region", "aria-label": t("commitTitle") },
          React.createElement("div", { className: "dgit-chead" },
            React.createElement("button", {
              type: "button",
              className: "dgit-iconbtn",
              title: t("back"),
              disabled: snap.busy,
              onClick: () => commitBus.set({ ...commitBus.getSnapshot(), open: false })
            }, "←"),
            React.createElement("span", null, t("commitTitle"))
          ),
          React.createElement("div", { className: "dgit-cmain" },
            React.createElement("div", { className: "dgit-ctree", style: { width: (dragW.tree === null ? ui.commitTreeW : dragW.tree) + "px" } },
              changed.length === 0 && extra.length === 0
                ? React.createElement("div", { className: "dgit-empty" }, t("empty"))
                : React.createElement(React.Fragment, null,
                    section("changes", t("changes"), changed),
                    section("unversioned", t("unversioned"), extra))
            ),
            React.createElement("div", {
              className: "dgit-csplit",
              role: "separator",
              "aria-orientation": "vertical",
              title: t("resizeTree"),
              onMouseDown: props.onSplit
            }),
            React.createElement("div", { className: "dgit-cdiff" },
              snap.diffPath
                ? React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "dgit-diffhead" },
                      React.createElement("strong", { title: snap.diffPath }, baseNameOf(snap.diffPath)),
                      React.createElement("span", null, dirOf(snap.diffPath)),
                      React.createElement("span", { className: "dgit-spacer" }),
                      React.createElement("button", {
                        type: "button",
                        className: "dgit-iconbtn",
                        style: { width: 20, height: 20 },
                        title: t("prevFile") + " (↑)",
                        disabled: snap.busy,
                        onClick: () => stepCommitFile(-1)
                      }, React.createElement(IconChev, { up: true })),
                      React.createElement("button", {
                        type: "button",
                        className: "dgit-iconbtn",
                        style: { width: 20, height: 20 },
                        title: t("nextFile") + " (↓)",
                        disabled: snap.busy,
                        onClick: () => stepCommitFile(1)
                      }, React.createElement(IconChev, { up: false })),
                      React.createElement("button", {
                        type: "button",
                        className: "dgit-jumpbtn",
                        title: t("jumpSource", { key: gitChordLabel("git.jumpToSource") }),
                        onClick: () => jumpToSourceFile(snap.diffPath, jumpRef.current)
                      }, gitChordLabel("git.jumpToSource"))
                    ),
                    React.createElement(DiffView, { text: snap.diffText, loading: snap.diffLoading, jumpRef })
                  )
                : React.createElement("div", { className: "dgit-empty" }, t("diffTitle"))
            )
          ),
          React.createElement("div", { className: "dgit-cfoot" },
            React.createElement("textarea", {
              className: "dgit-cmsg",
              value: snap.message,
              placeholder: t("commitMsg"),
              disabled: snap.busy,
              onChange: (event) => commitBus.set({ ...commitBus.getSnapshot(), message: event.target.value })
            }),
            React.createElement("div", { className: "dgit-cstatus", "data-bad": snap.bad ? "true" : "false", title: snap.status }, snap.status),
            React.createElement("div", { className: "dgit-cactions" },
              // Amend changes what the buttons on the right will do, so it
              // reads as a modifier of them rather than a peer.
              React.createElement("label", {
                className: "dgit-camend",
                title: t("amendTitle")
              },
                React.createElement("input", {
                  type: "checkbox",
                  checked: snap.amend === true,
                  disabled: snap.busy,
                  onChange: (event) => commitBus.set({ ...commitBus.getSnapshot(), amend: event.target.checked })
                }),
                React.createElement("span", null, t("amend"))
              ),
              React.createElement("span", { className: "dgit-spacer" }),
              // Generate sits immediately before Commit: it fills the same box
              // the commit reads from, so it belongs with the actions rather
              // than on the status line.
              React.createElement("button", {
                type: "button",
                className: "dgit-cbtn",
                disabled: snap.busy || snap.generating,
                title: snap.generating ? t("genWorking") : t("genMessage"),
                onClick: () => generateMessage()
              }, snap.generating ? t("genWorking") : t("genMessage")),
              React.createElement("button", {
                type: "button",
                className: "dgit-cbtn",
                disabled: snap.busy || snap.generating,
                title: t("commitBtn"),
                onClick: () => runCommit(false)
              }, t("commitBtn")),
              React.createElement("button", {
                type: "button",
                className: "dgit-cbtn",
                disabled: snap.busy || snap.generating,
                title: t("commitPush"),
                onClick: () => runCommit(true)
              }, t("commitPush"))
            )
          ),
          commitMenu(snap)
        );
      }

      /**
       * The commit window's right-click menu, rendered into `document.body` so
       * the docked panel's `overflow` cannot clip it.
       *
       * A single path rolls back exactly what was clicked. When the clicked row
       * is part of a multi-file selection the entry switches to that whole set,
       * which is the escape hatch for "I picked ten files, throw them all away".
       * Only an all-untracked set is labelled as a deletion, because those files
       * have no committed version to restore to.
       */
      function commitMenu(snap) {
        const menu = snap.menu;
        if (!menu) return null;
        const many = menu.paths.length > 1;
        const n = menu.paths.length;
        const byPath = new Map();
        for (let i = 0; i < (snap.files || []).length; i++) byPath.set(snap.files[i].path, snap.files[i]);
        const allUntracked = menu.paths.every((p) => {
          const file = byPath.get(p);
          return file !== undefined && String(file.xy || "") === "??";
        });
        const portal = createPortal || ((node) => node);
        return portal(React.createElement("div", {
          className: "dgit-menu",
          style: {
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 100)
          },
          onClick: (event) => event.stopPropagation(),
          onMouseDown: (event) => event.stopPropagation()
        },
          React.createElement("div", {
            className: "dgit-menuhead",
            title: menu.path
          }, many ? t("rollbackFiles").replace("{n}", String(n)) : baseNameOf(menu.path)),
          React.createElement("button", {
            type: "button",
            onClick: () => rollbackFiles(menu.paths)
          }, (allUntracked ? t("rollbackUntracked") : t("rollbackTitle")) + (many ? " (" + n + ")" : ""))
        ), document.body);
      }

      function InitPanel() {
        const data = useBus(dataBus);
        useBus(langBus);
        return React.createElement("div", { className: "dgit-init" },
          React.createElement("div", { className: "dgit-initcard" },
            React.createElement("div", { className: "dgit-inittitle" }, t("initRepo")),
            React.createElement("div", { className: "dgit-initdesc" }, t("initRepoDesc")),
            data.cwd ? React.createElement("div", { className: "dgit-cfrom", title: data.cwd }, data.cwd) : null,
            React.createElement("div", { className: "dgit-inithint" }, t("initRepoHint")),
            React.createElement("button", {
              type: "button",
              className: "dgit-cbtn",
              "data-k": "primary",
              disabled: data.initializing,
              onClick: () => initRepo()
            }, data.initializing ? t("initing") : t("initBtn"))
          )
        );
      }

      function NameDialog() {
        const data = useBus(dataBus);
        useBus(langBus);
        const kind = data.newBranch ? "create" : (data.rename ? "rename" : "");
        const draft = kind === "create" ? data.newBranch : data.rename;
        const field = kind === "create" ? "newBranch" : "rename";
        const inputRef = React.useRef(null);
        // Ref on the dialog card so the window-level Enter handler can tell
        // whether a key originated inside the dialog or somewhere else in the UI.
        const cardRef = React.useRef(null);
        React.useEffect(() => {
          if (!draft) return undefined;
          if (inputRef.current && typeof inputRef.current.focus === "function") {
            try {
              inputRef.current.focus();
              if (kind === "rename" && typeof inputRef.current.select === "function") inputRef.current.select();
            } catch {}
          }
          const onKey = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (kind === "create") closeNewBranch();
              else closeRename();
            } else if (event.key === "Enter") {
              // This listener is on window and sees every Enter, including
              // ones typed into unrelated inputs elsewhere in the UI; only
              // keys from inside the dialog card (or with no specific focus
              // element, i.e. body/document) may confirm the dialog.
              const card = cardRef.current;
              const target = event.target;
              const fromBody = target === document.body || target === document.documentElement || target === document;
              if (card && target && !fromBody && typeof card.contains === "function" && !card.contains(target)) return;
              const snap = dataBus.getSnapshot();
              const cur = kind === "create" ? snap.newBranch : snap.rename;
              if (cur && !cur.busy) {
                event.preventDefault();
                if (kind === "create") createBranch();
                else renameBranch();
              }
            }
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, [kind]);
        if (!draft || kind === "") return null;
        const from = kind === "create" ? (draft.from || data.head || "HEAD") : draft.ref;
        const title = t(kind === "create" ? "newBranchTitle" : "renameTitle");
        const hint = kind === "create"
          ? (draft.status || t("newBranchHint").replace("{from}", from))
          : (draft.status || "");
        const close = kind === "create" ? closeNewBranch : closeRename;
        const submit = kind === "create" ? createBranch : renameBranch;
        const submitLabel = draft.busy
          ? t(kind === "create" ? "creating" : "renaming")
          : t(kind === "create" ? "createBranchBtn" : "renameBtn");
        return React.createElement("div", {
          className: "dgit-modal",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !draft.busy) close();
          }
        },
          React.createElement("div", { className: "dgit-card", role: "dialog", "aria-label": title, ref: cardRef },
            React.createElement("div", { className: "dgit-chead" }, title),
            React.createElement("div", { className: "dgit-cform" },
              React.createElement("label", { className: "dgit-clabel" }, t(kind === "create" ? "newBranchFrom" : "branch")),
              React.createElement("div", { className: "dgit-cfrom", title: from }, from),
              React.createElement("label", { className: "dgit-clabel" }, t("newBranchName")),
              React.createElement("input", {
                ref: inputRef,
                className: "dgit-cinput",
                value: draft.name,
                placeholder: t("newBranchPlaceholder"),
                disabled: draft.busy,
                spellCheck: false,
                onChange: (event) => {
                  const cur = dataBus.getSnapshot()[field];
                  if (cur) setData({ [field]: { ...cur, name: event.target.value, bad: false, status: "" } });
                }
              }),
              React.createElement("div", { className: "dgit-cstatus", "data-bad": draft.bad ? "true" : "false" }, hint)
            ),
            React.createElement("div", { className: "dgit-cactions dgit-cactions-pad" },
              React.createElement("span", { className: "dgit-spacer" }),
              React.createElement("button", {
                type: "button",
                className: "dgit-cbtn",
                "data-k": "ghost",
                disabled: draft.busy,
                onClick: () => close()
              }, t("cancel")),
              React.createElement("button", {
                type: "button",
                className: "dgit-cbtn",
                "data-k": "primary",
                disabled: draft.busy,
                onClick: () => submit()
              }, submitLabel)
            )
          )
        );
      }

      /**
       * Persistent banner for an in-progress merge / rebase / cherry-pick.
       * It stays visible (unlike a toast) because the repository is in a state
       * the user must resolve or abort before doing anything else.
       */
      function OperationBar({ kind, conflicted, busy, onContinue, onAbort }) {
        const labelKey = {
          merge: "conflictMerge",
          "cherry-pick": "conflictCherry",
          revert: "conflictRevert",
          rebase: "conflictRebase"
        }[kind] || "conflictMerge";
        return React.createElement("div", { className: "dgit-opbar", "data-conflict": conflicted ? "true" : "false" },
          React.createElement("span", { className: "dgit-opdot" }),
          React.createElement("span", { className: "dgit-optext" },
            React.createElement("strong", null, t(labelKey)),
            React.createElement("span", { className: "dgit-ophint" }, conflicted ? t("conflictHint") : kind)
          ),
          React.createElement("span", { className: "dgit-spacer" }),
          React.createElement("button", {
            type: "button",
            className: "dgit-opbtn",
            disabled: busy,
            onClick: onContinue
          }, t("opContinue")),
          React.createElement("button", {
            type: "button",
            className: "dgit-opbtn",
            "data-k": "warn",
            disabled: busy,
            onClick: onAbort
          }, t("opAbort"))
        );
      }

      function Dock() {
        const ui = useBus(uiBus);
        const data = useBus(dataBus);
        const commit = useBus(commitBus);
        useBus(langBus);
        const hostRef = React.useRef(null);
        // Line of the change the history preview is scrolled to, kept by
        // DiffView. The chord lands there, not at the top of the file.
        const jumpRef = React.useRef(0);

        React.useEffect(() => {
          const onDoc = () => {
            if (dataBus.getSnapshot().menu) setData({ menu: null });
            if (commitBus.getSnapshot().menu) {
              commitBus.set({ ...commitBus.getSnapshot(), menu: null });
            }
          };
          const onKey = (event) => {
            if (gitChordHeld("git.jumpToSource", event)) {
              if (!uiBus.getSnapshot().visible || commitBus.getSnapshot().open) return;
              const focus = event.target;
              const tag = focus && focus.tagName;
              if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
              if (focus && focus.isContentEditable === true) return;
              const path = dataBus.getSnapshot().historyFile;
              if (!path || event.__dgitF4 === true) return;
              event.__dgitF4 = true;
              event.preventDefault();
              event.stopPropagation();
              jumpToSourceFile(path, jumpRef.current);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const focus = event.target;
            const tag = focus && focus.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            // The composer and other rich inputs are contenteditable, not
            // INPUT/TEXTAREA, so a tag check alone would eat their arrows.
            if (focus && focus.isContentEditable === true) return;
            if (event.isComposing === true) return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (!uiBus.getSnapshot().visible) return;
            if (commitBus.getSnapshot().open) return;
            const snap = dataBus.getSnapshot();
            if (!snap.detail) return;
            const dir = event.key === "ArrowDown" ? 1 : -1;
            // Clicking a row chooses which list the arrows walk: a picked file
            // row (which leaves `historyFile` set) keeps them on the changed
            // files, and anything else — a commit row clears `historyFile` —
            // walks the commit table. Real focus inside the file list wins.
            const focusInFiles = focus !== null && typeof focus.closest === "function" && focus.closest(".dgit-dfiles") !== null;
            const onFiles = snap.detailTab !== "message" && (focusInFiles || snap.historyFile !== "");
            event.preventDefault();
            event.stopPropagation();
            if (onFiles) stepHistoryFile(dir);
            else stepCommit(dir);
          };
          window.addEventListener("click", onDoc);
          window.addEventListener("keydown", onKey);
          return () => {
            window.removeEventListener("click", onDoc);
            window.removeEventListener("keydown", onKey);
          };
        }, []);

        const sinceOptions = [
          { id: "", label: t("date") },
          { id: "midnight", label: t("today") },
          { id: "7 days ago", label: t("week") },
          { id: "30 days ago", label: t("month") }
        ];

        const authors = [];
        const seenA = {};
        for (let i = 0; i < data.commits.length; i++) {
          const a = data.commits[i].author;
          if (!a || seenA[a]) continue;
          seenA[a] = 1;
          authors.push(a);
        }

        const branchQ = (data.branchQuery || "").trim().toLowerCase();
        const matchB = (name) => branchQ === "" || String(name).toLowerCase().indexOf(branchQ) >= 0;
        const locals = (data.local || []).filter((b) => matchB(b.name));
        const remotes = (data.remote || []).filter((b) => matchB(b.name));
        const tags = (data.tags || []).filter((b) => matchB(b.name));

        const remoteGroups = {};
        for (let i = 0; i < remotes.length; i++) {
          const name = remotes[i].name;
          const slash = name.indexOf("/");
          const remote = slash < 0 ? name : name.slice(0, slash);
          if (!remoteGroups[remote]) remoteGroups[remote] = [];
          remoteGroups[remote].push(remotes[i]);
        }

        // Any active query was already applied server-side (git log --grep /
        // hash lookup), so the returned commits are the result set. Filtering
        // again here would wrongly drop commits whose match was in the body
        // rather than in the fields echoed back on the row.
        const displayCommits = displayCommitsOf(data);

        const startDrag = (event, { move, finish }) => {
          event.preventDefault();
          const onMove = (ev) => move(ev);
          const onUp = () => {
            if (finish) finish();
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        };

        const onBranchSplit = (event) => {
          const host = hostRef.current;
          if (!host) return;
          const startX = event.clientX;
          const startW = ui.branchW;
          // Same reasoning as the commit-tree splitter: paint `--dgit-bw`
          // directly and publish to `uiBus` once, on release, so dragging does
          // not re-render the commit table on every mousemove.
          let live = startW;
          dragW.branch = startW;
          startDrag(event, {
            move: (ev) => {
              const w = Math.min(420, Math.max(140, startW + (ev.clientX - startX)));
              host.style.setProperty("--dgit-bw", w + "px");
              live = w;
              dragW.branch = w;
            },
            finish: () => {
              dragW.branch = null;
              writeLS(BRANCH_W_KEY, live);
              uiBus.set({ ...uiBus.getSnapshot(), branchW: live });
            }
          });
        };

        const onCommitSplit = (event) => {
          const host = hostRef.current;
          if (!host) return;
          const pane = host.querySelector(".dgit-cmain");
          const paneW = pane && pane.clientWidth ? pane.clientWidth : 520;
          const paneTree = host.querySelector(".dgit-ctree");
          const maxW = Math.max(160, paneW - 200);
          const startX = event.clientX;
          const startW = uiBus.getSnapshot().commitTreeW;
          let live = startW;
          dragW.tree = startW;
          startDrag(event, {
            move: (ev) => {
              const w = Math.min(maxW, Math.max(140, startW + (ev.clientX - startX)));
              // Write the width straight to the node; see the `dragW` declaration
              // for why this does not go through `uiBus` per move.
              if (paneTree) paneTree.style.width = w + "px";
              live = w;
              dragW.tree = w;
            },
            finish: () => {
              dragW.tree = null;
              writeLS(COMMIT_TREE_W_KEY, live);
              uiBus.set({ ...uiBus.getSnapshot(), commitTreeW: live });
            }
          });
        };

        // The detail pane is the right-hand column: message and changed files
        // sit beside the log instead of under it, which is what gives them room
        // in a dock only a few hundred pixels tall.
        const detailWidth = dragW.detail === null ? ui.detailW : dragW.detail;
        const hostStyle = {
          "--dgit-bw": (dragW.branch === null ? ui.branchW : dragW.branch) + "px",
          "--dgit-detail-w": Math.round(detailWidth) + "px"
        };
        const onDetailSplit = (event) => {
          const host = hostRef.current;
          const pane = event.currentTarget.parentNode;
          if (!host || !pane) return;
          const startX = event.clientX;
          const startW = pane.getBoundingClientRect().width;
          const rootW = host.getBoundingClientRect().width;
          pane.dataset.drag = "1";
          let live = uiBus.getSnapshot().detailW;
          dragW.detail = live;
          startDrag(event, {
            move: (ev) => {
              // Dragging left widens the pane, because it hangs off the right
              // edge of the log.
              const next = startW - (ev.clientX - startX);
              const capped = Math.min(Math.max(DETAIL_MIN_W, Math.round(rootW * 0.6)), DETAIL_MAX_W);
              live = Math.min(capped, Math.max(DETAIL_MIN_W, next));
              host.style.setProperty("--dgit-detail-w", live + "px");
              dragW.detail = live;
            },
            finish: () => {
              pane.dataset.drag = "0";
              dragW.detail = null;
              writeLS(DETAIL_W_KEY, live);
              uiBus.set({ ...uiBus.getSnapshot(), detailW: live });
            }
          });
        };

        let body = null;
        if (commit.open) {
          body = React.createElement(CommitDialog, { onSplit: onCommitSplit });
        } else {
          let main;
          if (data.loading && data.commits.length === 0) main = React.createElement("div", { className: "dgit-status" }, data.checkingOut ? t("checkout") : t("loading"));
          else if (data.error === "noWorkspace" || data.error === "noSession") main = React.createElement("div", { className: "dgit-empty" }, t(data.error));
          else if (!data.repo && data.cwd !== "") main = React.createElement(InitPanel);
          else if (data.error && data.commits.length === 0) main = React.createElement("div", { className: "dgit-empty" }, t(data.error) === data.error ? data.error : t(data.error));
          else if (displayCommits.length === 0) main = React.createElement("div", { className: "dgit-empty" }, t("empty"));
          else {
            const rows = displayCommits.map((c) => {
              const pills = compactPills(parseDecorations(c.refs));
              return React.createElement("div", {
                key: c.hash,
                className: "dgit-row",
                "data-hash": c.hash,
                "data-on": data.selectedHash === c.hash ? "true" : "false",
                onClick: () => loadDetail(c.hash),
                onDoubleClick: () => {
                  try {
                    if (c.hash && c.hash !== "WORKING") {
                      window.navigator.clipboard.writeText(c.hash);
                      showToast(t("copied"));
                    }
                  } catch {}
                }
              },
                React.createElement("div", { className: "dgit-msg" },
                  pills.map((p, pi) => React.createElement("span", { key: pi, className: "dgit-pill", "data-k": p.kind }, p.name)),
                  React.createElement("span", { className: "dgit-subj", title: c.subject }, c.subject)
                ),
                React.createElement("div", { className: "dgit-author", title: c.email || c.author }, c.author),
                React.createElement("div", { className: "dgit-date" }, formatWhen(c.at, t("today")))
              );
            });
            main = React.createElement("div", { className: "dgit-table" }, rows);
          }

          const detailTab = data.detailTab === "message" ? "message" : "files";
          // The diff itself is in the editor now; this pane only carries one
          // when the editor chunk is missing, so the files list gets the room.
          const detailDiff = data.diffLoading || data.diffText !== "";
          const detail = data.detail && data.selectedHash ? React.createElement("div", { className: "dgit-detail", "data-diff": data.historyFile && detailDiff ? "1" : "0" },
            React.createElement("div", { className: "dgit-detail-handle", onMouseDown: onDetailSplit }),
            React.createElement("div", { className: "dgit-dtabs" },
              React.createElement("button", {
                type: "button",
                className: "dgit-dtab",
                "data-on": detailTab === "files" ? "true" : "false",
                onClick: () => setData({ detailTab: "files" })
              }, t("tabFiles")),
              React.createElement("button", {
                type: "button",
                className: "dgit-dtab",
                "data-on": detailTab === "message" ? "true" : "false",
                onClick: () => setData({ detailTab: "message" })
              }, t("tabMessage"))
            ),
            React.createElement("div", { className: "dgit-dbody" },
              detailTab === "message"
                ? React.createElement("div", { className: "dgit-dmeta" },
                    data.detail.commit ? ((data.detail.commit.body || data.detail.commit.subject || "") +
                      (data.detail.commit.hash ? "\n\n" + data.detail.commit.hash : "")) : ""
                  )
                : React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "dgit-dfiles" },
                      (data.detail.files || []).map((f) => React.createElement("button", {
                        key: f.path,
                        type: "button",
                        className: "dgit-frow",
                        tabIndex: -1,
                        "data-on": data.historyFile === f.path ? "true" : "false",
                        onClick: () => openHistoryFile(f.path)
                      },
                        React.createElement("span", { className: "dgit-fst", "data-s": String(f.status || "M").charAt(0) }, String(f.status || "M").charAt(0)),
                        React.createElement("span", { className: "dgit-bname" }, f.path)
                      ))
                    ),
                    data.historyFile ? React.createElement("div", { className: "dgit-diffhead" },
                      React.createElement("strong", { title: data.historyFile }, data.historyFile.split("/").pop()),
                      React.createElement("span", null, data.historyFile),
                      React.createElement("span", { className: "dgit-spacer" }),
                      React.createElement("button", {
                        type: "button",
                        className: "dgit-jumpbtn",
                        title: t("jumpSource", { key: gitChordLabel("git.jumpToSource") }),
                        onClick: () => jumpToSourceFile(data.historyFile, jumpRef.current)
                      }, gitChordLabel("git.jumpToSource"))
                    ) : null,
                    data.historyFile && detailDiff ? React.createElement(DiffView, { text: data.diffText, loading: data.diffLoading, jumpRef }) : null
                  )
            )
          ) : null;

          const sec = (id, label, kids, canCreate) => {
            if (!kids || kids.length === 0) return null;
            const open = data.leftOpen[id] !== false;
            return React.createElement(React.Fragment, { key: id },
              React.createElement("div", {
                className: "dgit-sec",
                onClick: () => setData({ leftOpen: { ...data.leftOpen, [id]: !open } }),
                onContextMenu: canCreate === true ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setData({ menu: { x: event.clientX, y: event.clientY, ref: data.head || "HEAD", current: true, headOnly: true } });
                } : undefined
              }, (open ? "▾ " : "▸ ") + label),
              open ? kids : null
            );
          };

          const remoteKids = [];
          const groupNames = Object.keys(remoteGroups).sort();
          for (let g = 0; g < groupNames.length; g++) {
            const remote = groupNames[g];
            remoteKids.push(React.createElement("div", { key: remote, className: "dgit-sec", style: { paddingLeft: 18 } }, remote));
            const list = remoteGroups[remote];
            for (let i = 0; i < list.length; i++) {
              const b = list[i];
              const short = b.name.indexOf("/") >= 0 ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
              remoteKids.push(React.createElement(BranchRow, {
                key: b.name,
                name: short,
                current: b.name === data.head || (data.local || []).some((l) => l.current && l.upstream === b.name),
                selected: data.selectedRef === b.name,
                onSelect: () => scheduleLoad({ selectedRef: b.name }),
                onCheckout: () => checkout(b.name),
                onMenu: (event) => openBranchMenu(event, b.name, false, "remote")
              }));
            }
          }

          body = React.createElement(React.Fragment, null,
            React.createElement("div", { className: "dgit-tools" },
              React.createElement("div", { className: "dgit-search" },
                React.createElement(IconSearch, null),
                React.createElement("input", {
                  value: data.query,
                  placeholder: t("search"),
                  onChange: (event) => scheduleLoad({ query: event.target.value })
                })
              ),
              React.createElement("select", {
                className: "dgit-sel",
                value: data.author,
                onChange: (event) => scheduleLoad({ author: event.target.value })
              },
                React.createElement("option", { value: "" }, t("user")),
                authors.map((a) => React.createElement("option", { key: a, value: a }, a))
              ),
              React.createElement("select", {
                className: "dgit-sel",
                value: data.since,
                onChange: (event) => scheduleLoad({ since: event.target.value })
              }, sinceOptions.map((o) => React.createElement("option", { key: o.id, value: o.id }, o.label))),
              React.createElement("button", {
                type: "button",
                className: "dgit-iconbtn dgit-tip",
                "data-tip": t("cherry"),
                title: t("cherry"),
                "aria-label": t("cherry"),
                onClick: () => cherryPick()
              }, React.createElement(IconCherry, null)),
              React.createElement("button", {
                type: "button",
                className: "dgit-iconbtn dgit-tip",
                "data-tip": withChord(t("pull"), "git.pull"),
                title: withChord(t("pull"), "git.pull"),
                "aria-label": withChord(t("pull"), "git.pull"),
                onClick: () => pull()
              }, React.createElement(IconRefresh, null)),
              React.createElement("button", {
                type: "button",
                className: "dgit-iconbtn dgit-tip",
                "data-tip": withChord(t("push"), "git.push"),
                title: withChord(t("push"), "git.push"),
                "aria-label": withChord(t("push"), "git.push"),
                disabled: data.pushing,
                onClick: () => push()
              }, React.createElement(IconPush, null))
            ),
            React.createElement("div", { className: "dgit-body" },
              React.createElement("div", { className: "dgit-left" },
                React.createElement("input", {
                  className: "dgit-bsearch",
                  value: data.branchQuery,
                  placeholder: t("branch") + " / tag",
                  onChange: (event) => setData({ branchQuery: event.target.value })
                }),
                React.createElement("div", { className: "dgit-btree" },
                  React.createElement(BranchRow, {
                    name: t("head"),
                    current: true,
                    selected: data.selectedRef === "" || data.selectedRef === "HEAD",
                    onSelect: () => scheduleLoad({ selectedRef: "" }),
                    onCheckout: undefined,
                    onMenu: (event) => openBranchMenu(event, data.head || "HEAD", true),
                    title: data.head || "HEAD"
                  }),
                  sec("local", t("local"), locals.map((b) => React.createElement(BranchRow, {
                    key: b.name,
                    name: b.name,
                    current: b.current,
                    selected: data.selectedRef === b.name,
                    onSelect: () => scheduleLoad({ selectedRef: b.name }),
                    onCheckout: () => checkout(b.name),
                    onMenu: (event) => openBranchMenu(event, b.name, b.current, "local")
                  })), true),
                  sec("remote", t("remote"), remoteKids, true),
                  React.createElement("div", {
                    className: "dgit-sec",
                    onClick: () => {
                      const next = data.leftOpen.tags !== true;
                      setData({ leftOpen: { ...data.leftOpen, tags: next } });
                      if (next && (data.tags || []).length === 0) loadTags();
                    }
                  }, (data.leftOpen.tags === true ? "▾ " : "▸ ") + t("tags")),
                  data.leftOpen.tags === true ? tags.map((b) => React.createElement(BranchRow, {
                    key: b.name,
                    name: b.name,
                    current: false,
                    selected: data.selectedRef === b.name,
                    onSelect: () => scheduleLoad({ selectedRef: b.name }),
                    onCheckout: () => checkout(b.name),
                    onMenu: (event) => openBranchMenu(event, b.name, false)
                  })) : null
                )
              ),
              React.createElement("div", { className: "dgit-bsplit", onMouseDown: onBranchSplit }),
              React.createElement("div", { className: "dgit-right" }, main, detail)
            )
          );
        }

        return React.createElement("div", {
          ref: hostRef,
          className: "dgit-shell",
          style: hostStyle
        },
          React.createElement("div", { className: "dgit-bar" },
            React.createElement("span", { className: "dgit-title" }, t("title")),
            Array.isArray(data.repos) && data.repos.length > 1 ? React.createElement("select", {
              className: "dgit-repo",
              value: data.repoPath || data.repos[0].path,
              title: t("repoSwitch"),
              onChange: (event) => selectRepo(event.target.value)
            }, data.repos.map((repo) => React.createElement("option", { key: repo.path, value: repo.path }, repo.name))) : (
              Array.isArray(data.repos) && data.repos.length === 1 && data.repos[0].path !== data.workspace
                ? React.createElement("span", { className: "dgit-branchchip", title: data.repos[0].path }, data.repos[0].name)
                : null
            ),
            data.dirty ? React.createElement("span", { className: "dgit-dirty", title: t("dirty") }) : null,
            React.createElement("span", { className: "dgit-branchchip" }, data.head || ""),
            React.createElement("span", { className: "dgit-spacer" })
          ),
          body,
          data.repo && data.operation && data.operation.kind !== "" ? React.createElement(OperationBar, {
            kind: data.operation.kind,
            conflicted: data.conflicted,
            busy: data.opBusy === true,
            onContinue: () => runOperation("continue"),
            onAbort: () => runOperation("abort")
          }) : null,
          ui.toast ? React.createElement("div", { className: ui.warn ? "dgit-toast dgit-warn" : "dgit-toast" }, ui.toast) : null,
          data.menu ? (createPortal || ((node) => node))(React.createElement("div", {
            className: "dgit-menu",
            style: { left: Math.min(data.menu.x, window.innerWidth - 180), top: Math.min(data.menu.y, window.innerHeight - 120) },
            onClick: (event) => event.stopPropagation(),
            onMouseDown: (event) => event.stopPropagation()
          },
            React.createElement("button", { type: "button", onClick: () => openNewBranch(data.menu.ref) }, t("newBranch")),
            // Rename and the delete label key off the row's own kind rather than
            // a "/" in the name: a remote-tracking branch must not be renamed,
            // and a local `feature/x` must not be reported as a remote delete.
            data.menu.headOnly || data.menu.kind === "remote" ? null : React.createElement("button", { type: "button", onClick: () => openRenameBranch(data.menu.ref, data.menu.current) }, t("renameBranch")),
            data.menu.headOnly ? null : React.createElement("button", { type: "button", onClick: () => checkout(data.menu.ref) }, t("checkoutMenu")),
            data.menu.headOnly || data.menu.current ? null : React.createElement("button", { type: "button", onClick: () => mergeRef(data.menu.ref) }, t("merge") + (data.head ? " (" + data.head + ")" : "")),
            data.menu.headOnly || data.menu.current ? null : React.createElement("button", { type: "button", onClick: () => deleteBranch(data.menu.ref, data.menu.kind) }, data.menu.kind === "remote" ? t("deleteRemote") : t("deleteBranch"))
          ), document.body) : null,
          (data.newBranch || data.rename) ? (createPortal || ((node) => node))(React.createElement(NameDialog, null), document.body) : null
        );
      }

      // Contribute this plugin's chords to the shared shortcut catalog so they
      // appear in Settings → 快捷键 and can be rebound. This runs before the
      // dock renderer is set up on purpose: the catalog is an independent
      // concern, and a missing `react-dom` must not silently drop the row.
      // The shortcuts plugin may mount after this one; `gitChordHeld` falls
      // back to the local default until the bridge exists, and registration is
      // retried on a short timer.
      const registerCommands = () => {
        const api = window.__dshKeyboardShortcuts;
        if (api === undefined || api === null || typeof api.register !== "function") return null;
        try {
          return api.register({ owner: PLUGIN, commands: GIT_COMMANDS });
        } catch (err) {
          console.error("dsh-git-manager: shortcut registration failed", err);
          return null;
        }
      };
      let unregisterCommands = registerCommands();
      let registerTimer = 0;
      if (unregisterCommands === null) {
        registerTimer = window.setInterval(() => {
          const dispose = registerCommands();
          if (dispose !== null) {
            unregisterCommands = dispose;
            window.clearInterval(registerTimer);
            registerTimer = 0;
          }
        }, 250);
      }
      // A live reload of the shortcuts plugin installs a fresh, empty catalog;
      // re-register on its ready event so this row comes back.
      const onCatalogReady = () => {
        if (typeof unregisterCommands === "function") {
          try { unregisterCommands(); } catch {}
          unregisterCommands = null;
        }
        unregisterCommands = registerCommands();
      };
      window.addEventListener("dsh-keyboard-shortcuts-ready", onCatalogReady);
      ctx.effect(() => () => {
        window.removeEventListener("dsh-keyboard-shortcuts-ready", onCatalogReady);
        if (registerTimer) window.clearInterval(registerTimer);
        if (typeof unregisterCommands === "function") {
          try { unregisterCommands(); } catch {}
        }
        unregisterCommands = null;
      });

      if (typeof createRoot !== "function") {
        console.error("dsh-git-manager: react-dom createRoot unavailable");
        return;
      }

      let host = null;
      let root = null;
      const teardown = () => {
        if (root !== null) {
          try { root.unmount(); } catch {}
          root = null;
        }
        if (host !== null) {
          try { if (host.parentNode) host.parentNode.removeChild(host); } catch {}
          host = null;
        }
      };
      // Git is visible when its dock is open inside the editor page and that page
      // is what the column shows. The editor's own handle answers the second
      // half — there is no view bus to consult any more.
      const editorPageOpen = () => {
        const panel = window.__dshEditorPanel;
        if (panel === undefined || panel === null || typeof panel.isOpen !== "function") return false;
        try { return panel.isOpen() === true; } catch { return false; }
      };
      const gitVisible = () => dockOpen() && editorPageOpen();
      const sidebarOpen = () => {
        const sidebar = sidebarRightService();
        try {
          return sidebar !== undefined && typeof sidebar.isExpanded === "function" && sidebar.isExpanded() === true;
        } catch {
          return false;
        }
      };
      const markVisible = (on) => {
        const ui = uiBus.getSnapshot();
        if (ui.visible === (on === true)) return;
        uiBus.set({ ...ui, visible: on === true, collapsed: false });
      };

      /** The editor's reserved bottom pane, when that chunk is loaded. */
      const editorDockPane = () => {
        const panel = window.__dshEditorPanel;
        if (panel === undefined || panel === null || typeof panel.gitDock !== "function") return null;
        try { return panel.gitDock() || null; } catch { return null; }
      };

      const ensureDock = () => {
        const panel = document.querySelector("[data-sidebar-right-panel]");
        if (panel === null) return false;
        const reveals = panel.querySelectorAll(".dgit-reveal");
        for (let i = 0; i < reveals.length; i++) {
          try { reveals[i].parentNode.removeChild(reveals[i]); } catch {}
        }
        // The editor owns the column, so the dock is a pane inside its page. With
        // no editor page there is nowhere to dock: the caller retries on a timer
        // until the editor chunk has published its handle.
        const pane = editorDockPane();
        if (pane === null) return false;
        const target = pane;
        // Kept mounted while hidden: tearing it down on every close would throw
        // away the commit window mid-open. A host whose column was rebuilt is
        // unmounted here instead, so nothing is left pointing at dead nodes.
        if (host !== null && !panel.contains(host)) teardown();
        const stale = panel.querySelectorAll(".dgit-host");
        for (let i = 0; i < stale.length; i++) {
          if (stale[i] === host) continue;
          try { stale[i].parentNode.removeChild(stale[i]); } catch {}
        }
        const docked = true;
        const markDocked = () => {
          const snap = dockBus.getSnapshot();
          if (snap.docked !== docked) dockBus.set({ ...snap, docked });
        };
        if (host !== null && host.parentNode === target) {
          if (docked) host.dataset.dock = "1"; else delete host.dataset.dock;
          markDocked();
          return true;
        }
        if (host === null || root === null) {
          if (host !== null) teardown();
          host = document.createElement("div");
          host.className = "dgit-host";
          if (docked) host.dataset.dock = "1"; else delete host.dataset.dock;
          target.appendChild(host);
          root = createRoot(host);
          root.render(React.createElement(Dock));
          markDocked();
          return true;
        }
        // Moving the live tree beats rebuilding it: the commit table, the
        // selected commit and any open menu live in there.
        if (docked) host.dataset.dock = "1"; else delete host.dataset.dock;
        target.appendChild(host);
        markDocked();
        return true;
      };

      /**
       * Open or close the bottom dock.
       *
       * Closing it leaves the editor alone — only the dock goes away, which is
       * the point of not making Git a workspace of its own.
       */
      const dockOpen = () => dockBus.getSnapshot().open === true;
      const setDockOpen = (on) => {
        const value = on === true;
        writeLS(DOCK_KEY, value ? "1" : "0");
        try { document.documentElement.dataset[DOCK_ATTR] = value ? "1" : "0"; } catch {}
        const snap = dockBus.getSnapshot();
        if (snap.open !== value) dockBus.set({ ...snap, open: value });
        try { window.dispatchEvent(new CustomEvent("dsh-git-dock", { detail: { open: value } })); } catch {}
      };
      // Paint the stored state before anything mounts, so a reload lands the
      // column in the shape the user left it in.
      setDockOpen(readFlag(DOCK_KEY, false));

      // While the dock is opening, the editor overlay is still mounting, so the
      // pane it reserves does not exist yet. Retry until the host lands in it.
      let dockAttachTimer = 0;
      const scheduleDockAttach = () => {
        if (dockAttachTimer !== 0) window.clearInterval(dockAttachTimer);
        let tries = 0;
        dockAttachTimer = window.setInterval(() => {
          tries += 1;
          ensureDock();
          const pane = editorDockPane();
          const docked = pane !== null && host !== null && host.parentNode === pane;
          if ((docked || tries > 50) && dockAttachTimer !== 0) {
            window.clearInterval(dockAttachTimer);
            dockAttachTimer = 0;
          }
        }, 100);
      };
      /**
       * Show the Git panel. Every open goes through here — the chip, ⌘9, pull,
       * push, and the commit chord — so the column cannot come up at the
       * ordinary width on one of them and fullscreen on another.
       *
       * The panel is a dock under the editor, so opening it opens the editor:
       * the column it shares is the editor's.
       */
      const openGitPanel = () => {
        const editor = window.__dshEditorPanel;
        // The dock lives inside the editor page, so opening Git opens that page;
        // `open()` also applies the user's full/split preference, which is why
        // Git carries no mode of its own.
        setDockOpen(true);
        if (editor !== undefined && editor !== null) {
          // `reveal` opens the page without touching a shape the user already
          // set; `open` applies the full/split preference and would drop an
          // expanded fullscreen column back to the split width.
          const show = typeof editor.reveal === "function" ? editor.reveal : editor.open;
          if (typeof show === "function") { try { show.call(editor); } catch {} }
        }
        markVisible(true);
        ensureDock();
        scheduleDockAttach();
        lastSessionKey = "";
        window.setTimeout(() => { syncSession(); }, 40);
      };
      /**
       * Close the dock. The editor stays where it is — the column is no longer
       * Git's to collapse, which is the whole point of docking it.
       */
      const leaveGitPanel = () => {
        setDockOpen(false);
        markVisible(false);
        closeCommit();
      };
      const toggleGitPanel = () => {
        // A collapsed column, or a column showing something else, is not a
        // finished open: bring Git back. Only a dock that is actually on
        // screen closes — at any width, fullscreen or split.
        if (gitVisible() && sidebarOpen()) {
          leaveGitPanel();
          return;
        }
        openGitPanel();
      };
      const revealGit = () => { openGitPanel(); };
      const enterGitFullscreen = () => { openGitPanel(); };
      const toggleGitFullscreen = () => { toggleGitPanel(); };

      const gitPanelApi = {
        toggle: () => toggleGitPanel(),
        open: () => openGitPanel(),
        fullscreen: () => toggleGitFullscreen()
      };
      window.__dshGitPanel = gitPanelApi;
      try { window.dispatchEvent(new CustomEvent("dsh-git-ready")); } catch {}

      /**
       * The editor's half of the bridge.
       *
       * Diffs are rendered by the editor now, so the editor is the one that
       * knows the change on screen; the repo-relative path, the workspace
       * fence and the probe for a deleted file all stay here.
       */
      window.__dshGitDiff = {
        jump: (path, line) => { jumpToSourceFile(path, line); }
      };

      /**
       * F4 while a diff tab fills the editor area.
       *
       * Bound in the capture phase so it owns the chord before the dock's own
       * handler sees it — with both on screen, only one jump may happen.
       */
      const onEditorDiffKey = (event) => {
        if (!gitChordHeld("git.jumpToSource", event)) return;
        if (event.__dgitF4 === true) return;
        const panel = window.__dshEditorPanel;
        if (panel === undefined || panel === null || typeof panel.activeDiff !== "function") return;
        let diff = null;
        try { diff = panel.activeDiff(); } catch {}
        if (diff === null || !diff.path) return;
        const focus = event.target;
        const tag = focus && focus.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (focus && focus.isContentEditable === true) return;
        event.__dgitF4 = true;
        event.preventDefault();
        event.stopPropagation();
        let line = 0;
        try { line = typeof panel.diffLine === "function" ? panel.diffLine() : 0; } catch {}
        jumpToSourceFile(diff.path, line);
      };
      document.addEventListener("keydown", onEditorDiffKey, true);

      let registered = false;
      const registerTypes = () => {
        let tabs;
        let slots;
        try { tabs = ctx.get("sidebarRightTabs") || ctx.sidebarRightTabs; } catch { tabs = undefined; }
        try { slots = ctx.get("slots") || ctx.slots; } catch { slots = undefined; }
        if (registered || !tabs || typeof tabs.register !== "function" || !slots || typeof slots.inject !== "function") return false;
        registered = true;
        ctx.effect(() => tabs.register({
          id: DIFF_TAB_ID,
          kind: DIFF_KIND,
          patterns: ["dsh-resource://git-diff/**"],
          priority: "extension",
          title: (address) => {
            const parsed = parseGitDiffAddress(address);
            if (!parsed || !parsed.path) return t("diffTitle");
            return parsed.path.split("/").pop() || t("diffTitle");
          }
        }), "dsh-git-manager: diff type");
        ctx.effect(() => slots.inject("sidebar.right.pane.tab", () => slots.register({
          name: "sidebar.right.pane.tab",
          key: DIFF_TAB_ID
        }, GitDiffBody)), "dsh-git-manager: diff body");
        ctx.effect(() => slots.inject("sidebar.right.pane.tab.title", () => slots.register({
          name: "sidebar.right.pane.tab.title",
          key: DIFF_TAB_ID
        }, GitDiffTitle)), "dsh-git-manager: diff title");
        return true;
      };
      if (!registerTypes()) {
        const timer = window.setInterval(() => { if (registerTypes()) window.clearInterval(timer); }, 250);
        ctx.effect(() => () => window.clearInterval(timer));
      }

      const stopUi = uiBus.subscribe(() => { ensureDock(); });

      const onGitEvent = (event) => {
        const action = event && event.detail ? event.detail.action : "";
        if (action === "toggleGit") toggleGitFullscreen();
        else if (action === "gitPull") {
          revealGit();
          pull();
        } else if (action === "gitPush") {
          revealGit();
          push();
        } else if (action === "gitCommit") {
          // Already open: the chord closes the commit window and nothing else —
          // the dock stays, since the editor is still sharing the column.
          // Opening Git itself (⌘9 / the chip) must show the change list, not
          // this dialog.
          const commitOpen = commitBus.getSnapshot().open === true;
          if (commitOpen) {
            closeCommit();
            if (!gitVisible()) openGitPanel();
            return;
          }
          openCommit();
        }
      };
      window.addEventListener("dsh-git", onGitEvent);
      const shortcutsOwns = (id) => {
        const api = window.__dshKeyboardShortcuts;
        return api !== undefined && api !== null && typeof api.has === "function" && api.has(id) === true;
      };
      const onShortcut = (event) => {
        const id = event && event.detail ? event.detail.id : "";
        if (id === "git.toggle") window.dispatchEvent(new CustomEvent("dsh-git", { detail: { action: "toggleGit" } }));
        else if (id === "git.pull") window.dispatchEvent(new CustomEvent("dsh-git", { detail: { action: "gitPull" } }));
        else if (id === "git.push") window.dispatchEvent(new CustomEvent("dsh-git", { detail: { action: "gitPush" } }));
        else if (id === "git.commit") window.dispatchEvent(new CustomEvent("dsh-git", { detail: { action: "gitCommit" } }));
      };
      window.addEventListener("dsh-shortcut", onShortcut);
      let sawToggleDown = false;
      const onGitKey = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        let action = "";
        if (toggleHeld(event)) {
          if (shortcutsOwns("git.toggle")) return;
          sawToggleDown = true;
          action = "toggleGit";
        } else if (gitChordHeld("git.pull", event)) action = "gitPull";
        else if (gitChordHeld("git.push", event)) action = "gitPush";
        else if (gitChordHeld("git.commit", event) || commitShiftHeld(event)) action = "gitCommit";
        else return;
        const focus = event.target;
        const tag = focus && focus.tagName;
        // ⌘T / ⌘⇧T / ⌘⇧K must fire even while the composer has focus. The commit
        // window's own fields keep pull and push, but not ⌘⇧K: that chord is the
        // fullscreen/collapse toggle, including while the message box is focused.
        //
        // "Open" is not enough to mean "on screen": the dialog is rendered by
        // the dock, and switching to the database workspace or collapsing the
        // column hides the dock without clearing the flag. Trusting the flag
        // alone then made the chord inert everywhere.
        const commitOnScreen = commitBus.getSnapshot().open === true
          && host !== null && host.isConnected === true && gitVisible() && sidebarOpen();
        if (action !== "toggleGit" && action !== "gitCommit" && commitOnScreen && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (focus && focus.isContentEditable === true))) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent("dsh-git", { detail: { action } }));
      };
      const onGitUp = (event) => {
        if (!toggleHeld(event) || shortcutsOwns("git.toggle")) return;
        if (sawToggleDown) {
          sawToggleDown = false;
          return;
        }
        window.dispatchEvent(new CustomEvent("dsh-git", { detail: { action: "toggleGit" } }));
      };
      window.addEventListener("keydown", onGitKey, true);
      window.addEventListener("keyup", onGitUp, true);
      document.addEventListener("keydown", onGitKey, true);
      document.addEventListener("keyup", onGitUp, true);
      // The first callback runs immediately. `gitWasShowing` starts false so that
      // call cannot release a fullscreen the user set while looking at files.
      let gitWasShowing = false;
      const syncGitChrome = () => {
        const showing = gitVisible();
        const entered = showing && !gitWasShowing;
        gitWasShowing = showing;
        markVisible(showing);
        ensureDock();
        if (entered) scheduleDockAttach();
        // Opening the dock, or switching onto it, has to load. `openGitPanel`
        // also schedules one; a second call is a no-op when the session key is
        // unchanged and the graph has not moved.
        if (entered) window.setTimeout(() => { syncSession(); }, 40);
      };
      const stopDock = dockBus.subscribe(() => { syncGitChrome(); });

      ensureDock();
      // The editor page is what reserves the dock's pane, and it mounts after this
      // plugin's apply. Retry until the dock is inside that pane — with no pane
      // there is nothing to attach to, so that is "not yet", never "done".
      let attachTries = 0;
      const attachTimer = window.setInterval(() => {
        ensureDock();
        attachTries += 1;
        const pane = editorDockPane();
        const placed = pane !== null && host !== null && host.isConnected && host.parentNode === pane;
        if (placed || attachTries > 40) window.clearInterval(attachTimer);
      }, 400);
      const onEditorDock = () => { ensureDock(); };
      window.addEventListener("dsh-editor-dock", onEditorDock);
      /**
       * Reconcile tick.
       *
       * 15s instead of 4s: `syncSession` only has to notice a commit made
       * outside the panel, and a tick that does find a change costs one
       * `/state` request plus four git subprocesses on the host. A hidden window
       * skips the tick entirely, so a backgrounded DSH stops polling git.
       */
      const followTimer = window.setInterval(() => {
        if (document.hidden === true || !uiBus.getSnapshot().visible) return;
        const snap = dataBus.getSnapshot();
        if (snap.repoPinned || !Array.isArray(snap.repos) || snap.repos.length < 2) return;
        const hit = repoForFile(snap.repos, activeFileAbs());
        if (!hit || hit === snap.repoPath) return;
        load({ repoPath: hit });
      }, 15000);
      const boot = window.setInterval(() => {
        if (document.hidden === true) return;
        ensureDock();
        syncSession();
      }, 15000);
      ctx.effect(() => () => {
        try { stopUi(); } catch {}
        try { stopDock(); } catch {}
        if (dockAttachTimer !== 0) window.clearInterval(dockAttachTimer);
        window.removeEventListener("dsh-git", onGitEvent);
        window.removeEventListener("dsh-shortcut", onShortcut);
        window.removeEventListener("keydown", onGitKey, true);
        document.removeEventListener("keydown", onEditorDiffKey, true);
        window.removeEventListener("dsh-editor-dock", onEditorDock);
        try { delete window.__dshGitDiff; } catch {}
        window.removeEventListener("keyup", onGitUp, true);
        document.removeEventListener("keydown", onGitKey, true);
        document.removeEventListener("keyup", onGitUp, true);
        window.clearInterval(followTimer);
        window.clearInterval(attachTimer);
        window.clearInterval(boot);
        if (searchTimer) window.clearTimeout(searchTimer);
        if (toastTimer) window.clearTimeout(toastTimer);
        teardown();
        if (window.__dshGitPanel === gitPanelApi) {
          try { delete window.__dshGitPanel; } catch { window.__dshGitPanel = undefined; }
        }
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
