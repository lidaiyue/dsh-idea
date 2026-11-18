// dsh-idea — Run panel (module-loader chunk). The panel is a bottom dock
// inside the editor page, below the Git dock, and the Host owns every
// process it shows. Nothing here creates an application: it starts, stops,
// restarts, and reads.
window.__ModuleLoader__.load({
  id: "dsh-idea",
  chunk: "client.run.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let React = require("react");
    if (React === null || typeof React !== "object") throw new Error("dsh-idea: run client react is unavailable");
    if (React.useState === undefined && React.default !== undefined && typeof React.default === "object") React = React.default;

    let createRoot;
    try {
      const client = require("react-dom/client");
      if (client !== null && typeof client === "object") createRoot = client.createRoot;
    } catch {}
    if (typeof createRoot !== "function") {
      try {
        const dom = require("react-dom");
        if (dom !== null && typeof dom === "object" && typeof dom.render === "function") {
          createRoot = (element) => ({
            render: (node) => dom.render(node, element),
            unmount: () => { try { dom.unmountComponentAtNode(element); } catch {} }
          });
        }
      } catch {}
    }
    if (typeof createRoot !== "function") throw new Error("dsh-run: react-dom is unavailable");

    const h = React.createElement;
    const PLUGIN = "dsh-idea-run";
    const API = "/plugins/dsh-idea/run";
    // The dock lives below the editor's own body, as a sibling of the Git pane.
    const OPEN_ATTR = "dshRunDock";
    const OPEN_KEY = "dsh.dsh-run.open";
    // The bottom area has one height, and dsh-idea already remembers it for the
    // Git pane. This panel reads that value instead of keeping a second one.
    const BOTTOM_H_KEY = "dsh.code-editor.gith";
    const DEFAULT_H = 300;
    const MIN_H = 120;
    const MAX_H = 900;
    // One timer drives the list and the live output; the panel is the only reader.
    const POLL_MS = 700;
    const LIST_EVERY = 5;
    const MAX_TAIL = 200 * 1024;

    const I18N = {
      zh: {
        title: "运行",
        openHint: "打开底部运行面板（⌥F12）",
        close: "收起运行面板",
        refresh: "重新读取配置（含自动发现）",
        start: "启动",
        stop: "停止",
        restart: "重新启动",
        startAll: "全部启动",
        stopAll: "全部停止",
        startAllHint: "启动所有未在运行的配置",
        stopAllHint: "停止所有正在运行的配置",
        startAllFailed: "全部启动失败",
        stopAllFailed: "全部停止失败",
        noSession: "没有选中的会话，无法确定工作目录。",
        noConfigs: "这个工作区没有找到可运行的应用。",
        configHint: "支持 package.json scripts、Maven/Gradle 的 Spring Boot 启动类、docker compose；也可以在 .dsh/run.json 里显式声明。",
        discovered: "自动发现",
        declared: "来自 run.json",
        badConfig: "配置无效",
        noOutput: "还没有输出。",
        stateIdle: "未启动",
        stateStarting: "启动中",
        stateReady: "已就绪",
        stateRunning: "运行中",
        stateExited: "已退出",
        stateStopped: "已停止",
        stateFailed: "失败",
        exitCode: "退出码",
        listFailed: "读取配置失败",
        startFailed: "启动失败",
        stopFailed: "停止失败",
        restartFailed: "重启失败",
        reasonPortInUse: "端口占用",
        reasonSandboxDenied: "沙箱拒绝",
        reasonCommandNotFound: "命令不存在",
        autoRestarting: "正在自动重启",
        autoRestartStopped: "自动重启已停止",
        logGap: "…（中间输出已丢弃）",
        clearLog: "清空",
        clearLogHint: "清空当前运行的可见日志，不影响进程",
      },
      en: {
        title: "Run",
        openHint: "Open the bottom run panel (Alt+F12)",
        close: "Collapse the run panel",
        refresh: "Reload configurations, discovery included",
        start: "Start",
        stop: "Stop",
        restart: "Restart",
        startAll: "Start all",
        stopAll: "Stop all",
        startAllHint: "Start every configuration that is not already running",
        stopAllHint: "Stop every configuration that is currently running",
        startAllFailed: "Starting all failed",
        stopAllFailed: "Stopping all failed",
        noSession: "No Session is selected, so the working directory is unknown.",
        noConfigs: "No runnable application was found in this workspace.",
        configHint: "Reads package.json scripts, Spring Boot applications in Maven and Gradle builds, and docker compose; .dsh/run.json declares entries explicitly.",
        discovered: "discovered",
        declared: "from run.json",
        badConfig: "Invalid configuration",
        noOutput: "No output yet.",
        stateIdle: "not started",
        stateStarting: "starting",
        stateReady: "ready",
        stateRunning: "running",
        stateExited: "exited",
        stateStopped: "stopped",
        stateFailed: "failed",
        exitCode: "exit code",
        listFailed: "Reading configurations failed",
        startFailed: "Starting failed",
        stopFailed: "Stopping failed",
        restartFailed: "Restarting failed",
        reasonPortInUse: "port in use",
        reasonSandboxDenied: "sandbox denied",
        reasonCommandNotFound: "command not found",
        autoRestarting: "auto-restarting",
        autoRestartStopped: "auto-restart stopped",
        logGap: "… (output skipped)",
        clearLog: "Clear",
        clearLogHint: "Clear the visible log for this run; the process is unchanged",
      }
    };

    const STYLE = `
.drun-pane{display:none;flex:none;min-height:120px;max-height:72%;overflow:hidden;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
html[data-dsh-run-dock="1"] .drun-pane{display:flex}
.drun-root{flex:auto;min-height:0;display:flex;flex-direction:column}
.drun-host{flex:auto;min-height:0;display:flex;flex-direction:column}
.drun-head{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.drun-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.drun-btn{flex:none;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.drun-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.drun-btn:disabled{opacity:.5;cursor:default}
.drun-body{flex:auto;min-height:0;display:flex;flex-direction:row}
.drun-list{flex:none;width:228px;min-width:200px;max-width:240px;overflow-x:hidden;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1)}
.drun-row{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;border-left:2px solid transparent}
.drun-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.drun-row[data-sel="1"]{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-brand-primary)}
.drun-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.drun-dot[data-s="run"]{background:var(--dsw-alias-state-success-primary)}
.drun-dot[data-s="start"]{background:var(--dsw-alias-state-warn-primary)}
.drun-dot[data-s="stop"]{background:var(--dsw-alias-state-warn-primary)}
.drun-dot[data-s="fail"],.drun-dot[data-s="exit"]{background:var(--dsw-alias-state-error-primary)}
.drun-names{flex:auto;min-width:0}
.drun-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drun-sub{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.drun-acts{flex:none;display:flex;gap:4px;opacity:0}
.drun-row:hover .drun-acts,.drun-row[data-sel="1"] .drun-acts{opacity:1}
.drun-out{flex:auto;min-width:0;min-height:0;display:flex;flex-direction:column}
.drun-outhead{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:4px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.drun-outcmd{flex:1 1 72px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drun-outstatus{flex:none;max-width:36%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drun-outtools{display:flex;align-items:center;gap:4px;flex:none;min-width:0}
.drun-pre{flex:auto;min-height:0;margin:0;padding:8px 10px;overflow:auto;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.drun-empty{padding:16px 12px;color:var(--dsw-alias-label-tertiary);max-width:640px}
.drun-note{flex:none;margin:0;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-error-primary);font-size:11px;white-space:pre-wrap;word-break:break-word}
.drun-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.drun-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.drun-chipico{font-size:9px;line-height:1}
`;

    /** The locale the page is drawn in, read from the Client locale service. */
    function langOf(ctx) {
      try {
        const locale = ctx.get("locale");
        const snapshot = locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : undefined;
        const id = snapshot && (snapshot.id || snapshot.locale || snapshot.language);
        if (typeof id === "string" && id.indexOf("en") === 0) return "en";
        if (typeof id === "string" && id.indexOf("zh") === 0) return "zh";
      } catch {}
      try { if (String(window.navigator.language || "").indexOf("en") === 0) return "en"; } catch {}
      return "zh";
    }

    const EMPTY_LOG = { text: "", err: "", next: { stdout: 0, stderr: 0 }, state: "idle", phase: undefined, port: undefined, exitCode: null, startedAt: undefined };

    /** Keep the newest bytes of one accumulated stream. */
    const clip = (text) => (text.length > MAX_TAIL ? text.slice(text.length - MAX_TAIL) : text);

    /** Fold one `tail` frame into the accumulated view; returns the same object when nothing changed. */
    function mergeLog(before, data, gapNote) {
      const stdout = data.stdout !== null && typeof data.stdout === "object" && typeof data.stdout.text === "string" ? data.stdout : null;
      const stderr = data.stderr !== null && typeof data.stderr === "object" && typeof data.stderr.text === "string" ? data.stderr : null;
      const startedAt = typeof data.startedAt === "number" ? data.startedAt : before.startedAt;
      const gap = typeof gapNote === "string" && gapNote !== "" ? gapNote + "\n" : "";
      const next = {
        text: stdout === null ? before.text : clip(before.text + (stdout.lossy === true ? gap : "") + stdout.text),
        err: stderr === null ? before.err : clip(before.err + (stderr.lossy === true ? gap : "") + stderr.text),
        next: {
          stdout: stdout === null ? before.next.stdout : stdout.next,
          stderr: stderr === null ? before.next.stderr : stderr.next
        },
        state: typeof data.state === "string" ? data.state : before.state,
        phase: data.phase === undefined ? before.phase : data.phase,
        port: data.port === undefined ? before.port : data.port,
        exitCode: data.exitCode === undefined ? before.exitCode : data.exitCode,
        startedAt
      };
      if (
        next.text === before.text && next.err === before.err && next.state === before.state
        && next.phase === before.phase && next.port === before.port && next.exitCode === before.exitCode
        && next.startedAt === before.startedAt
      ) return before;
      return next;
    }

    /**
     * Remove ANSI/CSI/OSC sequences, and leftover SGR like `[32m` when ESC
     * was lost. Ordinary bracket text such as `[stderr]` is kept.
     * Kept in sync with lib/ansi.js.
     */
    function stripAnsi(text) {
      if (typeof text !== "string" || text === "") return "";
      return text
        .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
        .replace(/\u009b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
        .replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
        .replace(/\u001b[@-Z\\-_]/g, "")
        .replace(/\[(\d+)(;\d+)*m/g, "");
    }

    /** Which dot a row paints: a ready app is running, a starting one is waiting. */
    function dotOf(row) {
      if (row.state === "running") return row.phase === "starting" ? "start" : "run";
      if (row.state === "stopped") return "stop";
      if (row.state === "failed") return "fail";
      if (row.state === "exited") return "exit";
      return "idle";
    }

    const REASON_KEYS = {
      "port-in-use": "reasonPortInUse",
      "sandbox-denied": "reasonSandboxDenied",
      "command-not-found": "reasonCommandNotFound"
    };

    const messageOf = (error) => (error && error.message ? String(error.message) : "failed");

    function apply(ctx) {
      const slots = ctx.get("slots") || ctx.slots;
      if (slots === undefined) return;
      const service = (serviceName) => { try { return ctx.get(serviceName); } catch { return undefined; } };

      let lang = langOf(ctx);
      const listeners = new Set();
      const t = (key) => ((I18N[lang] || I18N.zh)[key] ?? I18N.en[key] ?? key);
      const loc = service("locale");
      if (loc && typeof loc.subscribe === "function") {
        ctx.effect(() => loc.subscribe(() => {
          const next = langOf(ctx);
          if (next === lang) return;
          lang = next;
          for (const fn of listeners) { try { fn(); } catch {} }
        }));
      }
      const useLang = () => {
        const [, bump] = React.useState(0);
        React.useEffect(() => {
          const fn = () => bump((n) => n + 1);
          listeners.add(fn);
          return () => listeners.delete(fn);
        }, []);
        return lang;
      };

      const styleTag = document.createElement("style");
      styleTag.dataset.plugin = PLUGIN;
      styleTag.textContent = STYLE;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => { if (styleTag.isConnected) styleTag.remove(); });

      const originOf = () => {
        try {
          const origin = window.location.origin;
          return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
        } catch { return "http://dsh.internal"; }
      };
      const post = async (path, body) => {
        const response = await fetch(new URL(path, originOf()), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          credentials: "include",
          body: JSON.stringify(body)
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok) {
          const detail = data && data.message ? String(data.message) : data && data.error ? String(data.error) : "HTTP " + response.status;
          throw new Error(detail);
        }
        return data === null ? {} : data;
      };

      /** The Session on screen, whose directory is the workspace this panel acts on. */
      const currentSession = () => {
        let id;
        try {
          const uiSession = service("uiSession");
          const source = uiSession && uiSession.adapter ? uiSession.adapter.current : undefined;
          const key = source && source.getSnapshot ? source.getSnapshot()?.key : undefined;
          if (key !== undefined && key !== null && key !== "") id = key;
        } catch {}
        const sessions = service("sessions");
        const snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : undefined;
        if (id === undefined && snapshot && snapshot.byId) {
          for (const row of Object.values(snapshot.byId)) {
            if (row && row.retainedBy && row.retainedBy.mainView > 0) { id = row.id; break; }
          }
        }
        if (id === undefined || id === null || !snapshot || !snapshot.byId) return null;
        const entry = snapshot.byId[id];
        const cwd = entry && typeof entry.cwd === "string" ? entry.cwd : "";
        return cwd === "" ? null : { id, cwd };
      };

      // ── the dock under the editor ──────────────────────────────────────────
      // The editor page publishes the element it reserves for a bottom pane, and
      // the pane sits inside the same flex column as the editor body. Appending
      // one sibling after it docks this panel under the editor, sharing the
      // bottom area's height, and leaves the Git pane's own layout untouched.
      const isOpen = () => document.documentElement.dataset[OPEN_ATTR] === "1";
      const setOpen = (on) => {
        try { document.documentElement.dataset[OPEN_ATTR] = on ? "1" : "0"; } catch {}
        try { window.localStorage.setItem(OPEN_KEY, on ? "1" : "0"); } catch {}
        // The editor page's status bar owns the visible toggle, so the open
        // state has to reach it even when the change came from the chip or the
        // keyboard.
        try { window.dispatchEvent(new CustomEvent("dsh-run-dock", { detail: { open: on } })); } catch {}
      };
      /** The bottom area's height, as the editor remembers it. */
      const storedHeight = () => {
        let value = DEFAULT_H;
        try {
          const saved = Number(window.localStorage.getItem(BOTTOM_H_KEY));
          if (Number.isFinite(saved) && saved > 0) value = saved;
        } catch {}
        return Math.min(MAX_H, Math.max(MIN_H, Math.round(value)));
      };

      /** The editor page's flex column: the parent of the pane the editor reserves for a dock. */
      const editorBodyOf = () => {
        const panel = window.__dshEditorPanel;
        if (panel === undefined || panel === null || typeof panel.gitDock !== "function") return null;
        let pane;
        try { pane = panel.gitDock(); } catch { return null; }
        return pane === null || pane === undefined ? null : pane.parentElement;
      };

      let mount = null; // { body, pane, host, root }
      const teardown = () => {
        if (mount === null) return;
        const current = mount;
        mount = null;
        try { current.root.unmount(); } catch {}
        try { current.pane.remove(); } catch {}
      };

      const ensureDock = () => {
        const body = editorBodyOf();
        if (body === null) return false;
        if (mount !== null) {
          if (mount.body === body && mount.pane.parentElement === body) return true;
          teardown();
        }
        const pane = document.createElement("div");
        pane.className = "drun-pane";
        pane.style.height = storedHeight() + "px";
        const host = document.createElement("div");
        host.className = "drun-host";
        pane.appendChild(host);
        body.appendChild(pane);
        const root = createRoot(host);
        root.render(h(RunDock, { onClose: closeDock }));

        mount = { body, pane, host, root };
        return true;
      };

      let ensureTimer;
      const scheduleEnsure = () => {
        window.clearInterval(ensureTimer);
        let tries = 0;
        ensureTimer = window.setInterval(() => {
          // Closing while the retry is still running must not remount a hidden
          // dock behind the user's back.
          if (!isOpen()) { window.clearInterval(ensureTimer); ensureTimer = undefined; return; }
          tries += 1;
          if (ensureDock() || tries > 12) { window.clearInterval(ensureTimer); ensureTimer = undefined; }
        }, 150);
      };

      function openDock() {
        const panel = window.__dshEditorPanel;
        if (panel !== undefined && panel !== null) {
          // The dock belongs to the editor page, so opening it opens that page
          // without touching a shape the user already chose.
          const show = typeof panel.reveal === "function" ? panel.reveal : panel.open;
          if (typeof show === "function") { try { show.call(panel); } catch {} }
        }
        stowGit();
        setOpen(true);
        if (!ensureDock()) scheduleEnsure();
      }
      /**
       * Close Git without toggling it back open. `toggle()` can reopen Git when
       * its dock flag is stale or the column is not yet on screen.
       */
      function stowGit() {
        try {
          const git = window.__dshGitPanel;
          if (git !== undefined && git !== null && typeof git.close === "function") {
            git.close();
            return;
          }
          if (document.documentElement.dataset.dshGitDock === "1"
            && git !== undefined && git !== null && typeof git.toggle === "function") {
            git.toggle();
          }
        } catch {}
      }
      function closeDock() {
        setOpen(false);
        window.clearInterval(ensureTimer);
        ensureTimer = undefined;
        // Unmount, not just hide: a hidden dock used to keep its 700ms polling
        // running for the rest of the page load. Reopening builds a fresh dock
        // and reloads its state, which is what a closed panel shows anyway.
        teardown();
      }
      const toggleDock = () => (isOpen() ? closeDock() : openDock());
      window.__dshRunPanel = { open: openDock, close: closeDock, toggle: toggleDock, isOpen };
      try { window.dispatchEvent(new CustomEvent("dsh-run-ready")); } catch {}

      // The editor page appears, disappears, and is re-created by its own tab;
      // both of its lifecycle events are signals to reconcile the dock.
      const onEditorEvent = () => {
        if (isOpen()) scheduleEnsure();
      };
      const applyStoredHeight = () => {
        if (mount === null || mount.pane === null) return;
        mount.pane.style.height = storedHeight() + "px";
      };
      const onDockHeight = () => { applyStoredHeight(); };
      window.addEventListener("dsh-editor-ready", onEditorEvent);
      window.addEventListener("dsh-editor-dock", onEditorEvent);
      window.addEventListener("dsh-bottom-dock-height", onDockHeight);
      ctx.effect(() => () => {
        window.removeEventListener("dsh-editor-ready", onEditorEvent);
        window.removeEventListener("dsh-editor-dock", onEditorEvent);
        window.removeEventListener("dsh-bottom-dock-height", onDockHeight);
        window.clearInterval(ensureTimer);
        teardown();
        try { delete window.__dshRunPanel; } catch { window.__dshRunPanel = undefined; }
        try { window.dispatchEvent(new CustomEvent("dsh-run-ready")); } catch {}
      });

      // A reload keeps the panel where the user left it. If Git also restored
      // itself open, close it so the two docks do not stack.
      try {
        if (window.localStorage.getItem(OPEN_KEY) === "1") {
          stowGit();
          setOpen(true);
        }
      } catch {}
      if (isOpen()) scheduleEnsure();

      function RunDock({ onClose }) {
        useLang();
        const [view, setView] = React.useState({ loading: true, cwd: "", file: "", error: "", note: "", runs: [], sources: [], declared: 0 });
        const [logs, setLogs] = React.useState({});
        const [selected, setSelected] = React.useState("");
        const [busy, setBusy] = React.useState("");
        const [bulk, setBulk] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const [follow, setFollow] = React.useState(true);
        const preRef = React.useRef(null);
        const followRef = React.useRef(true);
        followRef.current = follow;
        const ignoreScroll = React.useRef(false);

        const viewRef = React.useRef(view);
        viewRef.current = view;
        const logsRef = React.useRef(logs);
        logsRef.current = logs;
        const selectedRef = React.useRef(selected);
        selectedRef.current = selected;
        const cycles = React.useRef(0);

        const reload = React.useCallback(async (fresh) => {
          const session = currentSession();
          if (session === null) {
            setView({ loading: false, cwd: "", file: "", error: "", note: "", runs: [], sources: [], declared: 0 });
            return;
          }
          try {
            const data = await post(API + "/list", fresh === true ? { cwd: session.cwd, fresh: true } : { cwd: session.cwd });
            const runs = Array.isArray(data.runs) ? data.runs : [];
            setView({
              loading: false,
              cwd: session.cwd,
              file: typeof data.file === "string" ? data.file : "",
              error: typeof data.error === "string" ? data.error : "",
              note: typeof data.message === "string" ? data.message : "",
              runs,
              sources: Array.isArray(data.sources) ? data.sources : [],
              declared: Number.isInteger(data.declared) ? data.declared : 0
            });
            setSelected((previous) => {
              if (previous !== "" && runs.some((row) => row.id === previous)) return previous;
              return runs.length > 0 ? runs[0].id : "";
            });
          } catch (error) {
            setView({ loading: false, cwd: session.cwd, file: "", error: "list-failed", note: messageOf(error), runs: [], sources: [], declared: 0 });
          }
        }, []);

        React.useEffect(() => {
          let stopped = false;
          const step = async () => {
            if (stopped) return;
            // The pane stays mounted inside the editor page, and the editor can
            // be collapsed, hidden, or re-created without telling this panel.
            // Polling for a dock nobody can see is pure background load: skip
            // until it is open and attached again.
            if (!isOpen() || document.hidden === true) return;
            if (mount === null || mount.host.isConnected !== true) return;
            cycles.current += 1;
            const current = viewRef.current;
            const restarting = current.runs.some((row) => row.restartStatus === "scheduled" || row.restartStatus === "restarting");
            if (cycles.current === 1 || cycles.current % LIST_EVERY === 0 || restarting) {
              await reload(false);
              if (stopped) return;
            }
            const state = viewRef.current;
            if (state.cwd === "" || state.runs.length === 0) return;
            const wanted = state.runs.filter((row) => row.state === "running" || row.restartStatus === "scheduled" || row.restartStatus === "restarting" || row.id === selectedRef.current);
            for (const row of wanted) {
              const before = logsRef.current[row.id] || EMPTY_LOG;
              try {
                const data = await post(API + "/tail", { cwd: state.cwd, id: row.id, stdout: before.next.stdout, stderr: before.next.stderr });
                if (stopped) return;
                let frame = data;
                // A new process resets Host offsets. Re-read from zero so the
                // new output still appears in this same row, after the old log.
                if (typeof data.startedAt === "number" && typeof before.startedAt === "number" && data.startedAt !== before.startedAt) {
                  frame = await post(API + "/tail", { cwd: state.cwd, id: row.id, stdout: 0, stderr: 0 });
                  if (stopped) return;
                  const base = { ...before, next: { stdout: 0, stderr: 0 }, startedAt: data.startedAt };
                  const next = mergeLog(base, frame, t("logGap"));
                  const merged = { ...logsRef.current, [row.id]: next };
                  logsRef.current = merged;
                  setLogs(merged);
                  continue;
                }
                const next = mergeLog(before, frame, t("logGap"));
                if (next === before) continue;
                const merged = { ...logsRef.current, [row.id]: next };
                logsRef.current = merged;
                setLogs(merged);
              } catch {}
            }
          };
          const timer = window.setInterval(() => { void step(); }, POLL_MS);
          void step();
          return () => { stopped = true; window.clearInterval(timer); };
        }, [reload]);

        const selectedRow = view.runs.find((row) => row.id === selected) || null;
        const log = logs[selected] || EMPTY_LOG;
        // Both are memoized: every poll used to re-concatenate and re-strip the
        // whole retained log (up to 200KB), even when only the dock's open
        // state or the selected row had changed.
        const output = React.useMemo(() => (
          log.err === "" ? log.text : `${log.text}${log.text === "" || log.text.endsWith("\n") ? "" : "\n"}[stderr]\n${log.err}`
        ), [log.text, log.err]);
        const visible = React.useMemo(() => stripAnsi(output), [output]);

        React.useEffect(() => {
          const pre = preRef.current;
          if (pre === null || !follow) return;
          ignoreScroll.current = true;
          pre.scrollTop = pre.scrollHeight;
          const release = () => { ignoreScroll.current = false; };
          if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(() => window.requestAnimationFrame(release));
          } else release();
        }, [visible, follow]);

        const onPreScroll = () => {
          if (ignoreScroll.current) return;
          const pre = preRef.current;
          if (pre === null) return;
          const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 16;
          if (atBottom !== followRef.current) setFollow(atBottom);
        };

        const clearLog = () => {
          const id = selectedRef.current;
          if (id === "") return;
          const before = logsRef.current[id] || EMPTY_LOG;
          // Keep tail offsets so later polls append new bytes and do not replay the old log.
          const cleared = { ...before, text: "", err: "" };
          const merged = { ...logsRef.current, [id]: cleared };
          logsRef.current = merged;
          setLogs(merged);
        };

        const act = async (row, action) => {
          setBusy(row.id);
          setNotice(null);
          try {
            await post(API + "/" + action, { cwd: viewRef.current.cwd, id: row.id });
            // A start or a restart replaces the process, so the old byte
            // offsets no longer address this run's output.
            const reset = { ...EMPTY_LOG, state: action === "stop" ? row.state : "running", phase: action === "stop" ? row.phase : "starting", port: row.port };
            const merged = { ...logsRef.current, [row.id]: reset };
            logsRef.current = merged;
            setLogs(merged);
            await reload(false);
          } catch (error) {
            setNotice({ error: action + "-failed", note: messageOf(error) });
          } finally {
            setBusy("");
          }
        };

        const actAll = async (action) => {
          const state = viewRef.current;
          const targets = action === "stop"
            ? state.runs.filter((row) => row.state === "running")
            : state.runs.filter((row) => row.state !== "running");
          if (state.cwd === "" || targets.length === 0) return;
          setBusy("all");
          setNotice(null);
          setBulk({ action, done: 0, total: targets.length });
          const errors = [];
          try {
            for (let index = 0; index < targets.length; index += 1) {
              const row = targets[index];
              try {
                await post(API + "/" + action, { cwd: viewRef.current.cwd, id: row.id });
                if (action !== "stop") {
                  const reset = { ...EMPTY_LOG, state: "running", phase: "starting", port: row.port };
                  const merged = { ...logsRef.current, [row.id]: reset };
                  logsRef.current = merged;
                  setLogs(merged);
                }
              } catch (error) {
                errors.push(row.name + ": " + messageOf(error));
              }
              setBulk({ action, done: index + 1, total: targets.length });
            }
            await reload(false);
            if (errors.length > 0) {
              setNotice({
                error: action === "stop" ? "stop-all-failed" : "start-all-failed",
                note: errors.join("\n")
              });
            }
          } finally {
            setBusy("");
            setBulk(null);
          }
        };

        const label = (row) => {
          let base;
          if (row.state === "running") {
            if (row.phase === "starting") base = t("stateStarting");
            else if (row.phase === "ready") base = t("stateReady");
            else base = t("stateRunning");
          } else {
            const key = "state" + row.state.charAt(0).toUpperCase() + row.state.slice(1);
            base = t(key);
          }
          const bits = [base];
          if (row.state !== "running" && row.exitCode !== null && row.exitCode !== undefined) {
            bits.push(t("exitCode") + " " + row.exitCode);
          }
          const reasonKey = typeof row.reason === "string" ? REASON_KEYS[row.reason] : undefined;
          if (reasonKey !== undefined) bits.push(t(reasonKey));
          else if (typeof row.error === "string" && row.error !== "") bits.push(row.error);
          if (row.restartStatus === "scheduled" || row.restartStatus === "restarting") {
            const n = row.restartAttempt !== undefined && row.restartAttempt > 0 ? String(row.restartAttempt) : "";
            const limit = row.restartLimit !== undefined ? "/" + row.restartLimit : "";
            bits.unshift(t("autoRestarting") + (n === "" ? "" : " " + n + limit));
          } else if (row.restartStatus === "stopped") {
            bits.push(t("autoRestartStopped"));
          }
          return bits.join(" · ");
        };
        const portText = (row) => (row.port === undefined || row.port === null ? "" : ` :${row.port}`);

        const headLabel = () => {
          if (view.error !== "") return view.error;
          if (view.declared > 0) return view.file || view.cwd;
          if (view.sources.length > 0) return `${t("discovered")} · ${view.sources.join(", ")}`;
          return view.file || view.cwd;
        };

        const startable = view.runs.filter((row) => row.state !== "running");
        const stoppable = view.runs.filter((row) => row.state === "running");
        const locked = busy !== "";
        const head = h("div", { className: "drun-head" },
          h("button", {
            type: "button",
            className: "drun-btn",
            title: t("startAllHint"),
            disabled: startable.length === 0 || locked,
            onClick: () => { void actAll("start"); }
          }, t("startAll")),
          h("button", {
            type: "button",
            className: "drun-btn",
            title: t("stopAllHint"),
            disabled: stoppable.length === 0 || locked,
            onClick: () => { void actAll("stop"); }
          }, t("stopAll")),
          bulk === null ? null : h("span", { className: "drun-path", style: { flex: "none" } },
            t(bulk.action === "stop" ? "stopAll" : "startAll") + " " + bulk.done + "/" + bulk.total),
          h("span", { className: "drun-path", title: view.file || view.cwd }, headLabel()),
          h("button", {
            type: "button",
            className: "drun-btn",
            title: t("refresh"),
            disabled: locked,
            onClick: () => { setNotice(null); void reload(true); }
          }, "⟳"),
          h("button", {
            type: "button",
            className: "drun-btn",
            title: t("close"),
            "aria-label": t("close"),
            onClick: () => { if (typeof onClose === "function") onClose(); }
          }, "▾"));

        if (view.loading) return h("div", { className: "drun-root" }, head, h("div", { className: "drun-empty" }, "…"));
        if (view.cwd === "") return h("div", { className: "drun-root" }, head, h("div", { className: "drun-empty" }, t("noSession")));
        if (view.runs.length === 0) {
          return h("div", { className: "drun-root" }, head,
            h("div", { className: "drun-empty" },
              h("div", null, view.error === "" ? t("noConfigs") : `${t("badConfig")} (${view.error})`),
              h("div", { style: { marginTop: 6 } }, view.note === "" ? t("configHint") : view.note)));
        }

        const rows = view.runs.map((row) => h("div", {
          key: row.id,
          className: "drun-row",
          "data-sel": row.id === selected ? "1" : "0",
          onClick: () => setSelected(row.id),
          title: row.command
        },
        h("span", { className: "drun-dot", "data-s": dotOf(row) }),
        h("span", { className: "drun-names" },
          h("span", { className: "drun-name" }, row.name),
          h("span", { className: "drun-sub" }, label(row) + portText(row))),
        h("span", { className: "drun-acts" },
          row.state === "running"
            ? h("button", { type: "button", className: "drun-btn", disabled: busy !== "", title: t("stop"), onClick: (event) => { event.stopPropagation(); void act(row, "stop"); } }, "■")
            : h("button", { type: "button", className: "drun-btn", disabled: busy !== "", title: t("start"), onClick: (event) => { event.stopPropagation(); void act(row, "start"); } }, "▶"),
          h("button", { type: "button", className: "drun-btn", disabled: busy !== "", title: t("restart"), onClick: (event) => { event.stopPropagation(); void act(row, "restart"); } }, "⟳"))));

        return h("div", { className: "drun-root" },
          head,
          h("div", { className: "drun-body" },
            h("div", { className: "drun-list" }, rows),
            h("div", { className: "drun-out" },
              h("div", { className: "drun-outhead" },
                h("span", { className: "drun-outcmd", title: selectedRow === null ? undefined : selectedRow.command }, selectedRow === null ? "" : selectedRow.command),
                h("span", { className: "drun-outstatus" }, selectedRow === null ? "" : label(selectedRow) + portText(selectedRow)),
                h("div", { className: "drun-outtools" },
                  h("button", {
                    type: "button",
                    className: "drun-btn",
                    title: t("clearLogHint"),
                    disabled: output === "",
                    onClick: () => clearLog()
                  }, t("clearLog")))),
              h("pre", { className: "drun-pre", ref: preRef, onScroll: onPreScroll }, output === "" ? t("noOutput") : visible))),
          (notice === null && view.error === "" ? null : h("p", { className: "drun-note" },
            (notice !== null ? (notice.note === "" ? notice.error : notice.note) : (view.note === "" ? view.error : view.note)))));
      }

      /** The compact entry point: the session header carries one button per Session. */
      function RunChip() {
        useLang();
        return h("button", {
          type: "button",
          className: "drun-chip",
          title: t("openHint"),
          "aria-label": t("openHint"),
          onClick: () => toggleDock()
        },
        h("span", { className: "drun-chipico", "aria-hidden": true }, "▶"),
        t("title"));
      }

      ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register({
        name: "conversation.session.header.actions",
        id: PLUGIN,
        order: 40
      }, RunChip)), "dsh-run: header chip");

      // `run.toggle` is registered in the editor catalog (dsh.idea.keys). This
      // chunk only listens for it, so the 快捷键 page stays the single owner.
      const matchDefaultChord = (event) => (
        !!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "F12"
      );
      const runChordHeld = (event) => {
        try {
          const api = window.__dshIdeaKeys;
          if (api !== undefined && api !== null && typeof api.match === "function") {
            if (typeof api.has !== "function" || api.has("run.toggle") === true) {
              return api.match("run.toggle", event) === true;
            }
          }
        } catch {}
        return matchDefaultChord(event);
      };
      const onRunKey = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (!runChordHeld(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        toggleDock();
      };
      window.addEventListener("keydown", onRunKey, true);
      document.addEventListener("keydown", onRunKey, true);
      ctx.effect(() => () => {
        window.removeEventListener("keydown", onRunKey, true);
        document.removeEventListener("keydown", onRunKey, true);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
