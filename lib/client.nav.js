// dsh-files-navigator — browser half (module-loader bundle)

window.__ModuleLoader__.load({
  id: "dsh-idea",
  chunk: "client.nav.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let React = require("react");
    if (React === null || typeof React !== "object") throw new Error("dsh-files-navigator: react is unavailable");
    if (React.useState === undefined && React.default !== undefined && typeof React.default === "object") React = React.default;
    // The palette portals into the right panel's own pane, so react-dom is a
    // hard dependency rather than an optional one.
    let ReactDOM = require("react-dom");
    if (ReactDOM !== null && typeof ReactDOM === "object" && ReactDOM.createPortal === undefined && ReactDOM.default !== undefined) ReactDOM = ReactDOM.default;
    if (ReactDOM === null || typeof ReactDOM !== "object" || typeof ReactDOM.createPortal !== "function") throw new Error("dsh-files-navigator: react-dom is unavailable");

    const PLUGIN = "dsh-files-navigator";
    const CONTENT_OPTIONS_KEY = "dsh.files-navigator.content";
    const RECENT_KEY = "dsh.files-navigator.recent";
    const MAX_RECENT = 12;
    const FILE_PREFIX = "dsh-resource://file/";
    const FILES_KIND = "files";
    const GUIDE_KIND = "guide";
    /** DSH persists one right-sidebar layout per session under this prefix. */
    /** Global right-sidebar open/closed preference; the session layouts only mirror it. */
    const INDEX_PATH = "/plugins/dsh-idea/nav/index";
    const SEARCH_PATH = "/plugins/dsh-idea/nav/search";
    const MIN_MARK_QUERY = 2;
    const MAX_RESULTS = 80;
    const INDEX_TTL_MS = 30000;
    const MODE_ORDER = ["everywhere", "content"];
    const CONTENT_DEBOUNCE_MS = 220;
    /** Host placeholder title for the auto-created Workspace; the sidebar localizes it instead of showing it. */
    const DEFAULT_WORKSPACE_TITLE = "default-workspace";

    const I18N = {
      zh: {
        overlay: "文件搜索",
        everywhere: "搜索文件",
        content: "内容",
        placeholderEverywhere: "文件名模糊搜索，如 fnav、gitig",
        placeholderContent: "在工作区文件内容里查找",
        emptyEverywhere: "没有匹配的文件",
        emptyContent: "没有匹配的内容",
        emptyQuery: "输入文件名片段，支持模糊匹配",
        recent: "最近打开",
        emptyContentQuery: "输入要查找的文本；用 .* 等正则请打开「正则」",
        emptyContentRegex: "输入正则表达式",
        indexing: "正在索引工作区…",
        searching: "正在搜索内容…",
        invalidPattern: "正则表达式无效",
        searchFail: "搜索失败",
        truncated: "结果已截断，试试更精确的关键字",
        noWorkspace: "当前会话没有工作区",
        indexFail: "文件索引请求失败",
        noSession: "没有打开的会话",
        unauthorized: "页面未通过鉴权，请用 dsh web 打印的地址重新打开",
        hint: "{search} 文件    {content} 内容    Tab 切换    ↑↓ 选择    ⏎ 打开    Esc 关闭",
        hintContent: "右侧开关：正则 / 区分大小写    ↑↓ 选择    ⏎ 按行打开    Esc 关闭",
        regex: "正则",
        caseSensitive: "区分大小写",
        closeOthers: "关闭其他",
        closeAll: "全部关闭",
        workspace: "工作区"
      },
      en: {
        overlay: "File search",
        everywhere: "Search files",
        content: "Content",
        placeholderEverywhere: "Fuzzy filename search, e.g. fnav, gitig",
        placeholderContent: "Search inside workspace file contents",
        emptyEverywhere: "No matching files",
        emptyContent: "No matching content",
        emptyQuery: "Type a filename fragment — fuzzy match is on",
        recent: "Recent",
        emptyContentQuery: "Type text to find inside files; turn on Regex for .* and friends",
        emptyContentRegex: "Type a regular expression",
        indexing: "Indexing workspace…",
        searching: "Searching file contents…",
        invalidPattern: "Invalid regular expression",
        searchFail: "Search failed",
        truncated: "Results truncated — try a more specific query",
        noWorkspace: "This session has no workspace",
        indexFail: "File index request failed",
        noSession: "No session is open",
        unauthorized: "Not authenticated — reopen the URL printed by dsh web",
        hint: "{search} Files    {content} Content    Tab switch    ↑↓ Select    ⏎ Open    Esc Close",
        hintContent: "Toggle Regex / Case on the right    ↑↓ Select    ⏎ Open at line    Esc Close",
        regex: "Regex",
        caseSensitive: "Case sensitive",
        closeOthers: "Close others",
        closeAll: "Close all",
        workspace: "Workspace"
      }
    };

    const STYLE = [
      /**
       * The palette's host, parked on the right panel's root. The panel keeps
       * `inset:0` even in fullscreen, where it is pinned over the column at a
       * higher layer than the shell's overlay slot, so a palette left in that
       * slot opens underneath it; hosted here it inherits the panel's stacking
       * context instead. The anchor is `display:contents`, so it adds nothing to
       * layout and stays unpositioned — which is what keeps the fixed overlay
       * below a floating pane's panel rather than covering it.
       */
      ".dfn-deck-host{display:contents}",
      /**
       * The panel root sits outside the subtree the host slides away, so a
       * collapsed column would leave this anchor painted over the conversation.
       * The gate is CSS rather than a JS check so it also covers a collapse
       * *while* the palette is open. See plugins/test/panel-mount-guard.
       */
      "[data-sidebar-right-panel]:not([data-sidebar-right-open]) .dfn-deck-host{display:none!important}",
      /**
       * `pointer-events:auto` is load-bearing, not decoration: the panel root is
       * `pointer-events:none` and restores `auto` only on its dock subtree, so a
       * palette hosted on the root would paint but take no click or hover.
       */
      ".dfn-overlay{position:fixed;inset:0;z-index:240;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;background:rgba(16,18,22,.28);pointer-events:auto}",
      ".dfn-card{width:min(640px,100%);max-height:min(72vh,640px);display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 18px 60px rgba(0,0,0,.22);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));overflow:hidden}",
      ".dfn-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06))}",
      ".dfn-tabs{flex:none;display:flex;gap:2px;padding:1px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover)}",
      ".dfn-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;font-weight:500;padding:3px 8px;border-radius:999px;cursor:pointer}",
      ".dfn-tab[data-on=true]{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 0 0 1px var(--dsw-alias-border-l4,rgba(0,0,0,.06))}",
      ".dfn-input{flex:1;min-width:0;height:32px;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:14px}",
      ".dfn-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".dfn-list{flex:1;min-height:0;overflow:auto;padding:6px}",
      ".dfn-recent{padding:4px 10px 2px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
      ".dfn-row{width:100%;display:flex;align-items:center;gap:10px;text-align:left;border:0;background:transparent;color:inherit;font:inherit;border-radius:10px;padding:8px 10px;cursor:pointer}",
      ".dfn-row:hover,.dfn-row.dfn-active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}",
      ".dfn-glyph{flex:none;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-module-platform,#eef3f8);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}",
      ".dfn-meta{min-width:0;flex:1}",
      ".dfn-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dfn-path{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}",
      ".dfn-code{display:flex;align-items:baseline;gap:8px;min-width:0}",
      ".dfn-code-text{flex:1;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}",
      ".dfn-code-where{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dfn-row.dfn-row-code{align-items:flex-start}",
      ".dfn-opts{flex:none;display:flex;gap:2px}",
      ".dfn-opt{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;font-weight:500;padding:3px 7px;border-radius:999px;cursor:pointer;white-space:nowrap}",
      ".dfn-opt:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dfn-opt[data-on=true]{background:var(--dsw-alias-bg-multi-select,rgba(61,111,217,.16));color:var(--dsw-alias-link,#3d6fd9)}",
      ".dfn-warn{color:var(--dsw-alias-state-error-primary,#c45)}",
      ".dfn-empty,.dfn-status{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}",
      ".dfn-foot{padding:8px 12px 10px;border-top:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.01em}",
      ".dfn-mark{background:var(--dsw-alias-bg-multi-select,rgba(61,111,217,.16));color:inherit;border-radius:3px;padding:0 1px}",
      "li[data-files-entry=file][data-dfn-active]>button{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}",
      ".dfn-menu-item{display:flex;width:100%;border:0;background:transparent;text-align:left;padding:7px 12px;font:inherit;font-size:13px;color:inherit;cursor:pointer}",
      ".dfn-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dfn-ws{flex:none;display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:500}",
      ".dfn-ws:hover{color:var(--dsw-alias-label-secondary)}",
      ".dfn-ws-icon{flex:none;opacity:.85}",
      ".dfn-ws-name{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
    ].join("\n");

    const detectMac = () => {
      try {
        if (window.navigator.userAgentData !== undefined && window.navigator.userAgentData.platform === "macOS") return true;
      } catch {}
      try { return /Macintosh|Mac OS X/i.test(window.navigator.userAgent); } catch {}
      return false;
    };
    const IS_MAC = detectMac();

    const FILE_CHORDS = IS_MAC
      ? {
        "files.searchEverywhere": { meta: true, code: "KeyO" },
        "files.searchContent": { meta: true, shift: true, code: "KeyF" },
        "files.closeFileTab": { meta: true, code: "KeyW" }
      }
      : {
        "files.searchEverywhere": { ctrl: true, code: "KeyO" },
        "files.searchContent": { ctrl: true, shift: true, code: "KeyF" },
        "files.closeFileTab": { ctrl: true, code: "KeyW" }
      };

    const hotkeyBridge = () => {
      try {
        const api = window.__dshKeyboardShortcuts;
        return api !== undefined && api !== null && typeof api.match === "function" ? api : null;
      } catch { return null; }
    };

    const matchSpec = (spec, event, codes) => {
      if (spec === null || spec === undefined) return false;
      const aliases = Array.isArray(codes) ? codes : [];
      if (spec.code !== event.code) {
        if (aliases.indexOf(event.code) < 0 || aliases.indexOf(spec.code) < 0) return false;
      }
      if (!!spec.ctrl !== !!event.ctrlKey) return false;
      if (!!spec.alt !== !!event.altKey) return false;
      if (!!spec.shift !== !!event.shiftKey) return false;
      if (!!spec.meta !== !!event.metaKey) return false;
      return true;
    };

    const chordHeld = (id, event, codes) => {
      const api = hotkeyBridge();
      if (api !== null) {
        try {
          const known = typeof api.has !== "function" ? true : api.has(id) === true;
          if (known) return api.match(id, event, codes) === true;
        } catch {}
      }
      return matchSpec(FILE_CHORDS[id], event, codes);
    };

    const codeLabelOf = (code) => {
      if (code === "Backslash" || code === "IntlBackslash") return "\\";
      if (typeof code === "string" && code.indexOf("Key") === 0) return code.slice(3);
      return code;
    };
    const chordLabelOf = (id) => {
      const api = hotkeyBridge();
      if (api !== null && typeof api.chordLabel === "function") {
        try {
          const known = typeof api.has !== "function" ? true : api.has(id) === true;
          if (known) {
            const label = api.chordLabel(id);
            if (typeof label === "string" && label !== "") return label;
          }
        } catch {}
      }
      const spec = FILE_CHORDS[id];
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
      if (spec.code) parts.push(codeLabelOf(spec.code));
      return parts.join(IS_MAC ? "" : "+");
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

    // Both pages are host tabs now, so "which view is showing" is a question each
    // owner answers about itself. This chunk only needs it to decide who handles
    // ⌘W; there is no view bus to consult.
    const editorPageOpen = () => {
      const panel = window.__dshEditorPanel;
      if (panel === undefined || panel === null || typeof panel.isOpen !== "function") return false;
      try { return panel.isOpen() === true; } catch { return false; }
    };
    const databasePageOpen = () => {
      const db = window.__dshDatabaseHotkeys;
      if (db === undefined || db === null || typeof db.isOpen !== "function") return false;
      try { return db.isOpen() === true; } catch { return false; }
    };

    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ":");
    const encodePath = (path) => path.split("/").map(encodeSegment).join("/");
    const fileAddressFor = (sessionId, cwd, path) => {
      const normalized = String(path || "").replace(/\\/g, "/");
      const root = cwd === undefined || cwd === null || cwd === "" ? "" : String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
      let rel = normalized;
      if (root !== "" && (normalized === root || normalized === root + "/")) rel = "";
      else if (root !== "" && normalized.startsWith(root + "/")) rel = normalized.slice(root.length + 1);
      rel = rel.replace(/^(?:\.\/)+/, "");
      return FILE_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(rel);
    };

    const parseFileAddress = (address) => {
      if (typeof address !== "string" || address.indexOf(FILE_PREFIX + "session/") !== 0) return null;
      const rest = address.slice((FILE_PREFIX + "session/").length);
      const slash = rest.indexOf("/");
      if (slash < 0) return { sessionId: decodeURIComponent(rest), rel: "" };
      let sessionId = rest.slice(0, slash);
      let rel = rest.slice(slash + 1);
      try { sessionId = decodeURIComponent(sessionId); } catch {}
      try {
        rel = rel.split("/").map((part) => {
          try { return decodeURIComponent(part); } catch { return part; }
        }).join("/");
      } catch {}
      return { sessionId, rel };
    };

    const basename = (path) => {
      const trimmed = String(path || "").replace(/[/\\]+$/, "");
      const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      return cut < 0 ? trimmed : trimmed.slice(cut + 1);
    };

    const joinWorkspace = (cwd, rel) => {
      if (rel === "") return cwd;
      if (cwd === "" || rel.charAt(0) === "/") return rel;
      return String(cwd).replace(/\/+$/, "") + "/" + rel;
    };

    const extGlyph = (name) => {
      const dot = name.lastIndexOf(".");
      if (dot <= 0 || dot === name.length - 1) return "•";
      const ext = name.slice(dot + 1).toLowerCase();
      if (ext.length <= 3) return ext;
      return ext.slice(0, 2);
    };

    const NO_MATCH = -Infinity;

    const fuzzyMatch = (query, text) => {
      if (!query) return 1;
      if (!text) return NO_MATCH;
      const q = query.toLowerCase();
      const raw = String(text);
      const t = raw.toLowerCase();
      if (t === q) return 100000;
      if (t.startsWith(q)) return 80000 - t.length;
      const idx = t.indexOf(q);
      if (idx >= 0) return 60000 - idx * 25 - t.length;
      let qi = 0;
      let score = 0;
      let last = -2;
      for (let i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] !== q[qi]) continue;
        let add = 8;
        if (i === last + 1) add += 18;
        if (i === 0) add += 14;
        else {
          const prev = raw[i - 1];
          if (prev === "/" || prev === "-" || prev === "_" || prev === ".") add += 14;
          else if (prev >= "a" && prev <= "z" && raw[i] >= "A" && raw[i] <= "Z") add += 12;
        }
        score += add;
        last = i;
        qi += 1;
      }
      if (qi < q.length) return NO_MATCH;
      return score - (t.length - q.length);
    };

    const scoreFile = (query, file) => {
      const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return 1;
      const name = file.name || "";
      const rel = file.rel || "";
      const stem = name.replace(/\.[^.]+$/, "");
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const ns = Math.max(fuzzyMatch(tok, name), fuzzyMatch(tok, stem));
        const rs = fuzzyMatch(tok, rel);
        const best = Math.max(ns, rs === NO_MATCH ? NO_MATCH : Math.floor(rs * 0.55));
        if (best === NO_MATCH) return NO_MATCH;
        total += best;
      }
      return total;
    };

    const highlight = (text, query) => {
      if (!query || !text) return text;
      const tok = query.trim().split(/\s+/)[0] || "";
      if (tok.length < MIN_MARK_QUERY) return text;
      const lower = text.toLowerCase();
      const q = tok.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) return text;
      return React.createElement(React.Fragment, null,
        text.slice(0, at),
        React.createElement("mark", { className: "dfn-mark" }, text.slice(at, at + tok.length)),
        text.slice(at + tok.length)
      );
    };

    const highlightRanges = (text, ranges) => {
      const body = String(text == null ? "" : text);
      if (body === "" || !Array.isArray(ranges) || ranges.length === 0) return body;
      const parts = [];
      let at = 0;
      for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        if (!Array.isArray(range) || range.length < 2) continue;
        const start = Math.max(at, Math.min(Math.floor(range[0]), body.length));
        const end = Math.max(start, Math.min(Math.floor(range[1]), body.length));
        if (end <= start) continue;
        if (start > at) parts.push(body.slice(at, start));
        parts.push(React.createElement("mark", { key: "m" + i, className: "dfn-mark" }, body.slice(start, end)));
        at = end;
      }
      if (parts.length === 0) return body;
      if (at < body.length) parts.push(body.slice(at));
      return React.createElement(React.Fragment, null, parts);
    };

    const scrollRowIntoView = (row) => {
      if (row === null || typeof row.scrollIntoView !== "function") return;
      const run = () => {
        try { row.scrollIntoView({ block: "nearest" }); } catch {}
      };
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
      else run();
    };

    const readContentOptions = () => {
      const out = { regex: false, caseSensitive: false };
      try {
        const raw = window.localStorage.getItem(CONTENT_OPTIONS_KEY);
        if (raw === null || raw === "") return out;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return out;
        out.regex = parsed.regex === true;
        out.caseSensitive = parsed.caseSensitive === true;
      } catch {}
      return out;
    };

    const writeContentOptions = (opts) => {
      try {
        window.localStorage.setItem(CONTENT_OPTIONS_KEY, JSON.stringify({
          regex: opts.regex === true,
          caseSensitive: opts.caseSensitive === true
        }));
      } catch {}
    };

    const normCwd = (cwd) => String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");

    const readRecent = () => {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        if (raw === null || raw === "") return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((row) => row && typeof row.path === "string" && row.path !== "" && typeof row.cwd === "string");
      } catch {
        return [];
      }
    };

    const writeRecent = (rows) => {
      try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(rows)); } catch {}
    };

    /** Remember one opened file for this workspace, most recent first. */
    const rememberRecent = (session, file) => {
      if (session === null || session === undefined) return;
      const cwd = normCwd(session.cwd);
      const path = typeof file.path === "string" ? file.path.replace(/\\/g, "/") : "";
      if (cwd === "" || path === "" || path === cwd) return;
      const rel = typeof file.rel === "string" && file.rel !== "" ? file.rel.replace(/\\/g, "/") : path;
      const name = typeof file.name === "string" && file.name !== "" ? file.name : basename(path);
      const next = [{ path, rel, name, cwd }];
      const prev = readRecent();
      for (let i = 0; i < prev.length && next.length < MAX_RECENT; i++) {
        if (prev[i].path === path && normCwd(prev[i].cwd) === cwd) continue;
        next.push(prev[i]);
      }
      writeRecent(next);
    };

    const recentFor = (session) => {
      if (session === null || session === undefined) return [];
      const cwd = normCwd(session.cwd);
      if (cwd === "") return [];
      const out = [];
      const rows = readRecent();
      for (let i = 0; i < rows.length; i++) {
        if (normCwd(rows[i].cwd) !== cwd) continue;
        out.push({
          path: rows[i].path,
          rel: typeof rows[i].rel === "string" && rows[i].rel !== "" ? rows[i].rel : rows[i].path,
          name: typeof rows[i].name === "string" && rows[i].name !== "" ? rows[i].name : basename(rows[i].path)
        });
      }
      return out;
    };

    try { window.localStorage.removeItem("dsh.files-navigator.last-query"); } catch {}

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
        const err = new Error((data && data.error) ? String(data.error) : ("HTTP " + response.status));
        err.status = response.status;
        throw err;
      }
      return data;
    };

    /**
     * The anchor `Palette` renders into, so the overlay can outrank the right
     * panel in both of its presentations.
     *
     * The frame's own overlay layer is a sibling of the right column, and a
     * fullscreen panel is pinned over that column at a higher layer — while its
     * dock is slid off screen it still paints an opaque `inset:0` box, so a
     * palette left in the shell layer opens *behind* it and looks like ⌘O did
     * nothing. Emptied, the palette falls back to the slot's own wrapper, which
     * is where it lived before.
     *
     * The panel root is the one element that can hold the anchor in both
     * presentations. A pane's tab strip would be the natural host — it already
     * carries an absolute position and the panel's own stacking context — but
     * the pane grid cell it sits in keeps the column's slide-out
     * `transform: translateX(100%)` while `data-sidebar-right-open` is absent,
     * and a transformed ancestor becomes the containing block of a
     * `position: fixed` child, which would shift the centred palette fully off
     * screen. The panel root never carries one.
     *
     * One anchor serves every open column: the studio draws a single panel for
     * the mounted Session, and the lookup is keyed on that Session's id rather
     * than on whichever pane happens to be focused.
     *
     * An open column is required, not merely preferred. A collapsed panel is the
     * same element and is still in the DOM, so parking the anchor there would
     * hand the palette to a subtree the gate below hides outright — the palette
     * then opens into a `display:none` host and the chord looks dead. Returning
     * `null` instead sends it back to the slot wrapper, which is where it lived
     * before the panel was ever involved.
     *
     * @param sidebar - the `sidebarRight` service, or undefined before it exists.
     * @returns the host element to render into, or `null` for the default.
     */
    // window.__dshFilesCloseOwned 的在册安装数（见 apply 中的说明）。
    let closeOwnedInstalls = 0;

    const deckHostFor = (sidebar) => {
      const mounted = sidebar === undefined ? undefined : sidebar.mounted;
      if (mounted === undefined || typeof mounted.getSnapshot !== "function") return null;
      let sessionId;
      try { sessionId = mounted.getSnapshot(); } catch { return null; }
      if (typeof sessionId !== "string" || sessionId === "") return null;
      const esc = (value) => (
        window.CSS !== undefined && typeof window.CSS.escape === "function"
          ? window.CSS.escape(value)
          : String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      );
      const panel = document.querySelector('[data-sidebar-right-session="' + esc(sessionId) + '"] [data-sidebar-right-panel]');
      if (panel === null || !panel.hasAttribute("data-sidebar-right-open")) return null;
      const existing = panel.querySelector(".dfn-deck-host");
      if (existing !== null) return existing;
      const host = document.createElement("div");
      host.className = "dfn-deck-host";
      host.setAttribute("data-dfn-deck", "");
      panel.appendChild(host);
      return host;
    };

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      const service = (name) => () => {
        try { return ctx.get(name); } catch { return undefined; }
      };

      const localeService = service("locale");
      const sessionsService = service("sessions");
      const workspacesService = service("workspaces");
      const uiSessionService = service("uiSession");
      const sidebarRightService = service("sidebarRight");
      const conversationService = service("conversation");

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
      const paletteBus = makeBus({
        open: false,
        mode: "everywhere",
        query: "",
        selected: 0,
        loading: false,
        status: "",
        statusKind: "",
        results: [],
        regex: readContentOptions().regex,
        caseSensitive: readContentOptions().caseSensitive
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
       * The session on the main stage.
       * `uiSession.adapter.current` is the host binding; its `key` is the session.
       * When that source is absent, the `mainView` retention count on the row is
       * the same fact the host itself falls back to.
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

      const mainSessionId = (snap) => {
        if (snap === undefined || snap === null) return undefined;
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
        const entry = snap === undefined || snap === null || snap.byId === undefined ? undefined : snap.byId[id];
        const cwd = entry !== undefined && typeof entry.cwd === "string" ? entry.cwd : "";
        return { id, cwd };
      };

      /**
       * The directory name a Chat header shows for one Session.
       *
       * Steps: read the Session's Workspace account (same membership rule the
       * sidebar's own `owningGroupKey` uses) and prefer its user-visible title;
       * an unaccounted Session falls back to the basename of its cwd, which is
       * what the sidebar would label its Ungrouped bucket with.
       * @param sessionId - Session whose workspace label is required.
       * @returns the label, or "" when the Session has neither account nor cwd.
       */
      const workspaceLabelOf = (sessionId) => {
        const sessions = sessionsService();
        const snap = sessions === undefined || sessions.list === undefined ? undefined : sessions.list.getSnapshot();
        const cwd = snap === undefined || snap === null || snap.byId === undefined
          ? ""
          : (typeof snap.byId[sessionId]?.cwd === "string" ? snap.byId[sessionId].cwd : "");
        const workspaces = workspacesService();
        if (workspaces !== undefined && workspaces.list !== undefined && typeof workspaces.list.getSnapshot === "function") {
          try {
            const items = workspaces.list.getSnapshot().items;
            if (Array.isArray(items)) {
              for (let i = 0; i < items.length; i++) {
                const row = items[i];
                if (row === undefined || row === null || !Array.isArray(row.sessionIds)) continue;
                if (row.sessionIds.indexOf(sessionId) < 0) continue;
                const title = typeof row.title === "string" ? row.title.trim() : "";
                if (title !== "" && title !== DEFAULT_WORKSPACE_TITLE) return title;
                break;
              }
            }
          } catch {}
        }
        return basename(cwd);
      };

      /**
       * Load the complete transcript without the reader clicking "加载更早".
       *
       * DSH opens a Session on a Turn-aligned page (the newest 500 messages and
       * at least two Turns); older history arrives only when the Chat header's
       * "加载更早" button is clicked. This pump watches the Session on the main
       * stage and keeps calling `loadOlder()` until the window reports
       * `hasMore: false`, so opening a Session yields its whole history.
       *
       * Every pass is driven by the controller's own snapshot notifications —
       * `loadingOlder` falling back to false is what schedules the next page —
       * so the pump never polls. `attempts` stops it if a call is accepted
       * without adding events, the only way this could spin.
       *
       * Opt-out switch: set `dsh.files.historyPump` in localStorage to
       * "off" / "0" / "false" to skip installation entirely (e.g. when the
       * whole-history pull is unwanted).
       * @returns Teardown for the list subscription and the Session subscription.
       */
      const installHistoryPump = () => {
        // 默认开启；localStorage 开关 dsh.files.historyPump 为 off/0/false 时
        // 跳过安装。try/catch：localStorage 在隐私模式等场景会抛异常。
        try {
          const flag = window.localStorage.getItem("dsh.files.historyPump");
          if (flag === "off" || flag === "0" || flag === "false") return () => {};
        } catch {}
        /** Consecutive accepted-but-empty pages tolerated before giving up. */
        const MAX_STALLED_ATTEMPTS = 8;
        let watched = null;
        let unsubscribe = null;
        let attempts = 0;
        let inFlight = false;

        const bindingOf = (id) => {
          const sessions = sessionsService();
          if (sessions === undefined || typeof sessions.binding !== "function") return undefined;
          try { return sessions.binding(id); } catch { return undefined; }
        };

        const revisionOf = (binding) => {
          try { return binding.eventSource.getSnapshot().revision; } catch { return undefined; }
        };

        const detach = () => {
          if (unsubscribe !== null) { try { unsubscribe(); } catch {} }
          unsubscribe = null;
          watched = null;
          attempts = 0;
          inFlight = false;
        };

        const pump = (binding) => {
          if (inFlight) return;
          if (watched !== binding.sessionId) return;
          const snap = binding.session.getSnapshot();
          // `cold`/`loading` are in-flight opens; the open republishes on settle.
          if (snap.openState !== "open" || snap.hasMore !== true || snap.loadingOlder === true) {
            attempts = 0;
            return;
          }
          if (attempts >= MAX_STALLED_ATTEMPTS) return;
          attempts += 1;
          const before = revisionOf(binding);
          inFlight = true;
          // Deferred: this runs inside a snapshot notification, and `loadOlder`
          // mutates the very window that is publishing.
          Promise.resolve()
            .then(() => binding.session.loadOlder())
            .catch(() => {})
            .then(() => {
              inFlight = false;
              if (revisionOf(binding) !== before) attempts = 0;
              // `loadOlder` clears `loadingOlder` and notifies from its own `finally`,
              // which lands while `inFlight` is still set and is therefore dropped.
              // Re-check here so reaching `hasMore: false` never depends on some
              // later, unrelated notification arriving.
              pump(binding);
            });
        };

        const sync = () => {
          const session = currentSession();
          if (session === null) { detach(); return; }
          if (watched !== session.id) { detach(); watched = session.id; }
          const binding = bindingOf(session.id);
          // Not retained yet: the list subscription calls this again once it is.
          if (binding === undefined) return;
          if (unsubscribe === null) {
            try { unsubscribe = binding.session.subscribe(() => pump(binding)); } catch { unsubscribe = null; }
          }
          pump(binding);
        };

        const sessions = sessionsService();
        let offList = null;
        if (sessions !== undefined && sessions.list !== undefined && typeof sessions.list.subscribe === "function") {
          try { offList = sessions.list.subscribe(sync); } catch { offList = null; }
        }
        sync();
        return () => {
          if (offList !== null) { try { offList(); } catch {} }
          detach();
        };
      };

      const isFilesPage = (tab) => tab !== undefined && tab.kind === FILES_KIND;
      const isFileResource = (tab) => {
        if (tab === undefined) return false;
        if (tab.kind === "git-diff") return true;
        return typeof tab.contentId === "string" && (
          tab.contentId.indexOf(FILE_PREFIX) === 0 ||
          tab.contentId.indexOf("dsh-resource://git-diff/") === 0
        );
      };

      /** Open tabs of the on-screen session. `tabsIn` is the host's tab list; it has no pane tree. */
      const tabsOf = (sidebar) => {
        if (sidebar === undefined || sidebar === null || typeof sidebar.tabsIn !== "function") return [];
        let sessionId;
        const mounted = sidebar.mounted;
        if (mounted !== undefined && mounted !== null && typeof mounted.getSnapshot === "function") {
          const id = mounted.getSnapshot();
          if (typeof id === "string" && id !== "") sessionId = id;
        }
        if (sessionId === undefined) {
          const session = currentSession();
          sessionId = session === null ? undefined : session.id;
        }
        if (sessionId === undefined) return [];
        try {
          const records = sidebar.tabsIn(sessionId);
          return Array.isArray(records) ? records : [];
        } catch {
          return [];
        }
      };

      const closeKind = (sidebar, kind) => {
        const tabs = tabsOf(sidebar);
        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          if (tab === undefined || tab.kind !== kind) continue;
          try { sidebar.close(tab.id); } catch {}
        }
      };

      /**
       * Collapse the directory and the default guide once a file is actually open.
       * Steps: bail when no file tab exists; close directory tabs; close guide
       * tabs from a fresh read, because closing the directory can seed a guide.
       */
      const closeChromeTabs = (sidebar) => {
        if (sidebar === undefined || typeof sidebar.close !== "function") return;
        const tabs = tabsOf(sidebar);
        let hasFile = false;
        for (let i = 0; i < tabs.length; i++) {
          if (isFileResource(tabs[i]) && !isFilesPage(tabs[i])) { hasFile = true; break; }
        }
        if (!hasFile) return;
        closeKind(sidebar, FILES_KIND);
        closeKind(sidebar, GUIDE_KIND);
      };

      let chromeTimer = 0;
      const settleChrome = (sidebar) => {
        closeChromeTabs(sidebar);
        if (chromeTimer) window.clearTimeout(chromeTimer);
        chromeTimer = window.setTimeout(() => {
          chromeTimer = 0;
          closeChromeTabs(sidebarRightService());
        }, 50);
      };

      const markActivePath = (absPath) => {
        try {
          const prev = document.querySelectorAll("li[data-files-entry=file][data-dfn-active]");
          for (let i = 0; i < prev.length; i++) delete prev[i].dataset.dfnActive;
          if (!absPath) return;
          const esc = (window.CSS && typeof window.CSS.escape === "function") ? window.CSS.escape(absPath) : absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const hit = document.querySelector('li[data-files-entry="file"][data-files-path="' + esc + '"]');
          if (hit) hit.dataset.dfnActive = "";
        } catch {}
      };

      const rememberAddress = (address, session) => {
        const parsed = parseFileAddress(address);
        if (parsed === null) return;
        markActivePath(joinWorkspace(session !== null ? session.cwd : "", parsed.rel));
      };

      /**
       * Open a file preview in the column the user already sized.
       *
       * The presentation (fullscreen or split) is the user's choice and belongs
       * to the column, not to whatever is being opened: this used to force the
       * column back to the ordinary width so a database fullscreen would not
       * leak onto a file preview, which now reads as "picking a search result
       * knocks me out of fullscreen". A narrow viewport still presents fullscreen
       * on its own — that rule reads the frame width, not this stored mode.
       */
      const openFileAddress = (sidebar, address, options) => {
        try {
          if (typeof sidebar.isExpanded === "function" && !sidebar.isExpanded()) sidebar.toggleExpanded();
        } catch {}
        sidebar.__dfnOpenResource(address, options);
        const session = currentSession();
        const parsed = parseFileAddress(address);
        if (parsed !== null && parsed.rel !== "" && session !== null) {
          rememberRecent(session, {
            path: joinWorkspace(session.cwd, parsed.rel),
            rel: parsed.rel,
            name: basename(parsed.rel)
          });
        }
        rememberAddress(address, session);
        settleChrome(sidebar);
      };

      const wrapSidebar = (sidebar) => {
        if (sidebar === undefined || sidebar === null || sidebar.__dfnWrapped === true) return;
        if (typeof sidebar.openResource !== "function") return;
        sidebar.__dfnWrapped = true;
        sidebar.__dfnOpenResource = sidebar.openResource.bind(sidebar);
        sidebar.__dfnOpenResourceIn = typeof sidebar.openResourceIn === "function" ? sidebar.openResourceIn.bind(sidebar) : null;
        sidebar.openResource = function (address, options) {
          if (typeof address === "string" && address.indexOf(FILE_PREFIX) === 0) {
            openFileAddress(sidebar, address, options);
            return;
          }
          sidebar.__dfnOpenResource(address, options);
        };
        if (sidebar.__dfnOpenResourceIn !== null) {
          sidebar.openResourceIn = function (sessionId, address, options) {
            const session = currentSession();
            if (typeof address === "string" && address.indexOf(FILE_PREFIX) === 0 && session !== null && session.id === sessionId) {
              openFileAddress(sidebar, address, options);
              return;
            }
            sidebar.__dfnOpenResourceIn(sessionId, address, options);
          };
        }
      };

      const openPath = (file) => {
        const session = currentSession();
        if (session === null) return;
        let rel = file && typeof file.rel === "string" ? file.rel : "";
        if (rel === "" && file && typeof file.path === "string" && session.cwd) {
          const root = String(session.cwd).replace(/\\/g, "/").replace(/\/+$/, "");
          const abs = String(file.path).replace(/\\/g, "/");
          if (abs.startsWith(root + "/")) rel = abs.slice(root.length + 1);
        }
        const panel = window.__dshEditorPanel;
        if (rel !== "" && panel && typeof panel.openFile === "function") {
          panel.openFile(rel, file && typeof file.line === "number" ? file.line : 0);
          try {
            rememberRecent(session, {
              path: file.path || rel,
              rel,
              name: file.name || rel.split("/").pop()
            });
          } catch {}
          closePalette();
          return;
        }
        const sidebar = sidebarRightService();
        if (sidebar === undefined) return;
        wrapSidebar(sidebar);
        const address = file.address || fileAddressFor(session.id, session.cwd, file.path);
        const opts = {};
        if (typeof file.line === "number" && file.line > 0) opts.params = { line: file.line };
        try {
          openFileAddress(sidebar, address, opts);
          if (typeof file.path === "string" && file.path !== "") markActivePath(file.path);
        } finally {
          closePalette();
        }
      };

      const indexCache = { key: "", at: 0, files: [], truncated: false, inflight: null, generation: 0 };

      const filesForSession = async () => {
        const session = currentSession();
        if (session === null || session.cwd === "") return { session, files: [], truncated: false, error: session === null ? "noSession" : "noWorkspace" };
        const key = session.id + "\0" + session.cwd;
        const now = Date.now();
        if (indexCache.key === key && now - indexCache.at < INDEX_TTL_MS && Array.isArray(indexCache.files)) {
          return { session, files: indexCache.files, truncated: indexCache.truncated, error: "" };
        }
        if (indexCache.inflight !== null && indexCache.key === key) return indexCache.inflight;
        // Each walk owns a generation marker. A walk for another session that
        // is still in flight when this one starts must not, on finishing,
        // overwrite the cache key or clear this walk's inflight entry — so a
        // write is only honoured while this walk is still the newest.
        const generation = ++indexCache.generation;
        const superseded = () => indexCache.generation !== generation;
        const work = (async () => {
          let files = [];
          let truncated = false;
          try {
            const data = await postJson(INDEX_PATH, { cwd: session.cwd });
            files = Array.isArray(data.files) ? data.files : [];
            files = files.filter((row) => row && typeof row.path === "string" && typeof row.name === "string");
            truncated = data.truncated === true;
          } catch (err) {
            if (!superseded()) indexCache.inflight = null;
            console.warn("dsh-files-navigator host index:", err);
            // 非 401（网络断开、500、超时）不是"没有工作区"，单独分类，
            // 否则错误提示失真：有 cwd 但索引请求失败也会显示 noWorkspace。
            return { session, files: [], truncated: false, error: err && err.status === 401 ? "unauthorized" : "indexFail" };
          }
          if (!superseded()) {
            indexCache.key = key;
            indexCache.at = Date.now();
            indexCache.files = files;
            indexCache.truncated = truncated;
            indexCache.inflight = null;
          }
          if (files.length === 0) return { session, files, truncated, error: "emptyEverywhere" };
          return { session, files, truncated, error: "" };
        })().catch((err) => {
          if (!superseded()) indexCache.inflight = null;
          console.error("dsh-files-navigator index:", err);
          // 同上：请求失败 ≠ 没有工作区，与上面 catch 保持同一分类。
          return { session, files: [], truncated: false, error: err && err.status === 401 ? "unauthorized" : "indexFail" };
        });
        indexCache.key = key;
        indexCache.inflight = work;
        return work;
      };

      const filterFiles = (files, query) => {
        const q = query.trim();
        if (q === "") return [];
        const scored = [];
        for (let i = 0; i < files.length; i++) {
          const s = scoreFile(q, files[i]);
          if (s === NO_MATCH) continue;
          scored.push({ file: files[i], s });
        }
        scored.sort((a, b) => (b.s - a.s) || a.file.rel.length - b.file.rel.length || a.file.name.localeCompare(b.file.name));
        const best = scored.length <= MAX_RESULTS ? scored : scored.slice(0, MAX_RESULTS);
        return best.map((row) => row.file);
      };

      const searchContent = async (session, query, regex, caseSensitive) => {
        if (session === null || session.cwd === "") {
          return { matches: [], truncated: false, error: session === null ? "noSession" : "noWorkspace" };
        }
        try {
          const data = await postJson(SEARCH_PATH, { cwd: session.cwd, query, regex, caseSensitive });
          if (data === null || typeof data !== "object") return { matches: [], truncated: false, error: "searchFail" };
          if (data.invalidPattern === true) return { matches: [], truncated: false, error: "invalidPattern" };
          const rows = Array.isArray(data.matches) ? data.matches : [];
          const matches = rows.filter((row) => row !== null && typeof row === "object" && typeof row.path === "string").map((row) => ({
            kind: "content",
            path: row.path,
            rel: typeof row.rel === "string" && row.rel !== "" ? row.rel : row.path,
            name: typeof row.name === "string" && row.name !== "" ? row.name : basename(row.path),
            line: typeof row.line === "number" && row.line > 0 ? row.line : 0,
            text: typeof row.text === "string" ? row.text : "",
            ranges: Array.isArray(row.ranges) ? row.ranges : []
          }));
          return { matches, truncated: data.truncated === true, error: "" };
        } catch (err) {
          console.warn("dsh-files-navigator search:", err);
          return { matches: [], truncated: false, error: err && err.status === 401 ? "unauthorized" : "searchFail" };
        }
      };

      let computeTimer = 0;
      let openToken = 0;
      const setPalette = (patch) => {
        paletteBus.set({ ...paletteBus.getSnapshot(), ...patch });
      };

      const computeResults = async (mode, query) => {
        const session = currentSession();
        const token = openToken;
        if (mode === "content") {
          const snap = paletteBus.getSnapshot();
          const q = query.trim();
          if (q === "") {
            setPalette({ loading: false, status: t(snap.regex ? "emptyContentRegex" : "emptyContentQuery"), statusKind: snap.regex ? "emptyContentRegex" : "emptyContentQuery", results: [], selected: 0 });
            return;
          }
          setPalette({ loading: true, status: t("searching"), statusKind: "", results: [], selected: 0 });
          const found = await searchContent(session, query, snap.regex === true, snap.caseSensitive === true);
          if (token !== openToken) return;
          const current = paletteBus.getSnapshot();
          if (!current.open || current.mode !== mode || current.query !== query) return;
          if (current.regex !== snap.regex || current.caseSensitive !== snap.caseSensitive) return;
          if (found.error !== "") {
            setPalette({ loading: false, status: t(found.error), statusKind: found.error, results: [], selected: 0 });
            return;
          }
          let status = "";
          let statusKind = "";
          if (found.matches.length === 0) { status = t("emptyContent"); statusKind = "emptyContent"; }
          else if (found.truncated) { status = t("truncated"); statusKind = "truncated"; }
          setPalette({ loading: false, status, statusKind, results: found.matches, selected: 0 });
          return;
        }
        const q = query.trim();
        if (q === "") {
          if (session === null || session.cwd === "") {
            setPalette({ loading: false, status: t(session === null ? "noSession" : "noWorkspace"), statusKind: session === null ? "noSession" : "noWorkspace", results: [], selected: 0 });
            return;
          }
          const recent = recentFor(session);
          setPalette({
            loading: false,
            status: recent.length === 0 ? t("emptyQuery") : "",
            statusKind: recent.length === 0 ? "emptyQuery" : "",
            results: recent,
            selected: 0
          });
          void filesForSession();
          return;
        }
        setPalette({ loading: true, status: t("indexing"), statusKind: "", results: [], selected: 0 });
        const indexed = await filesForSession();
        if (token !== openToken) return;
        const current = paletteBus.getSnapshot();
        if (!current.open || current.mode !== mode || current.query !== query) return;
        if (indexed.files.length === 0 && indexed.error !== "") {
          setPalette({ loading: false, status: t(indexed.error), statusKind: indexed.error, results: [], selected: 0 });
          return;
        }
        const files = filterFiles(indexed.files, query);
        setPalette({
          loading: false,
          status: indexed.truncated ? t("truncated") : (files.length === 0 ? t("emptyEverywhere") : ""),
          statusKind: indexed.truncated ? "truncated" : (files.length === 0 ? "emptyEverywhere" : ""),
          results: files,
          selected: 0
        });
      };

      const scheduleCompute = (mode, query) => {
        if (computeTimer) window.clearTimeout(computeTimer);
        const wait = query.trim() === "" ? 0 : (mode === "content" ? CONTENT_DEBOUNCE_MS : 40);
        const token = openToken;
        computeTimer = window.setTimeout(() => {
          if (token !== openToken) return;
          computeResults(mode, query);
        }, wait);
      };

      const freshPalette = (mode) => {
        const results = mode === "everywhere" ? recentFor(currentSession()) : [];
        let status = "";
        let statusKind = "";
        if (mode === "content") { status = t("emptyContentQuery"); statusKind = "emptyContentQuery"; }
        else if (results.length === 0) { status = t("emptyQuery"); statusKind = "emptyQuery"; }
        return { query: "", selected: 0, loading: false, status, statusKind, results };
      };

      const openPalette = (mode) => {
        wrapSidebar(sidebarRightService());
        openToken += 1;
        setPalette({ open: true, mode, ...freshPalette(mode) });
        scheduleCompute(mode, "");
      };

      const switchPaletteMode = (mode) => {
        const snap = paletteBus.getSnapshot();
        if (!snap.open || snap.mode === mode) return;
        setPalette({ mode, ...freshPalette(mode) });
        scheduleCompute(mode, "");
      };

      const nextPaletteMode = (mode) => {
        const at = MODE_ORDER.indexOf(mode);
        if (at < 0) return MODE_ORDER[0];
        return MODE_ORDER[(at + 1) % MODE_ORDER.length];
      };

      const toggleContentOption = (key) => {
        const snap = paletteBus.getSnapshot();
        if (snap.mode !== "content" || !snap.open) return;
        const next = !(snap[key] === true);
        const options = { regex: snap.regex === true, caseSensitive: snap.caseSensitive === true };
        options[key] = next;
        writeContentOptions(options);
        setPalette({ [key]: next, selected: 0 });
        scheduleCompute("content", snap.query);
      };

      const closePalette = () => {
        setPalette({ open: false, query: "", results: [], loading: false, status: "", statusKind: "" });
      };

      const moveSelection = (delta) => {
        const snap = paletteBus.getSnapshot();
        if (snap.results.length === 0) return;
        const next = (snap.selected + delta + snap.results.length * 8) % snap.results.length;
        setPalette({ selected: next });
      };

      const confirmSelection = () => {
        const snap = paletteBus.getSnapshot();
        const file = snap.results[snap.selected];
        if (file === undefined) return;
        openPath(file);
      };

      const closeOthers = (tab) => {
        const sidebar = sidebarRightService();
        if (sidebar === undefined || tab === undefined) return;
        const tabs = tabsOf(sidebar);
        for (let i = 0; i < tabs.length; i++) {
          const other = tabs[i];
          if (other === undefined || other.id === tab.id || isFilesPage(other)) continue;
          try { sidebar.close(other.id); } catch {}
        }
      };

      const closeAllFiles = () => {
        const sidebar = sidebarRightService();
        if (sidebar === undefined) return;
        const tabs = tabsOf(sidebar);
        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          if (!isFileResource(tab) || isFilesPage(tab)) continue;
          try { sidebar.close(tab.id); } catch {}
        }
      };

      const closeCurrentFileTab = () => {
        const sidebar = sidebarRightService();
        if (sidebar === undefined) return false;
        const pick = (tab) => isFileResource(tab) && !isFilesPage(tab);
        let target;
        try { target = sidebar.active(); } catch { target = undefined; }
        if (!pick(target)) {
          const tabs = tabsOf(sidebar);
          for (let i = tabs.length - 1; i >= 0; i--) {
            if (pick(tabs[i])) { target = tabs[i]; break; }
          }
        }
        if (target === undefined) return false;
        try { sidebar.close(target.id); return true; } catch { return false; }
      };

      const stopKey = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      };

      const onKeydown = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (chordHeld("files.closeFileTab", event)) {
          stopKey(event);
          // A page tab in front of the file tab owns ⌘W: the database closes its
          // console, the editor its document. Closing the file underneath would
          // surprise.
          if (databasePageOpen()) {
            const db = window.__dshDatabaseHotkeys;
            if (db && typeof db.closeTab === "function") db.closeTab();
            return;
          }
          if (editorPageOpen()) {
            const ed = window.__dshEditorHotkeys;
            if (ed && typeof ed.closeDoc === "function") ed.closeDoc();
            return;
          }
          const snap = paletteBus.getSnapshot();
          if (snap.open) closePalette();
          else closeCurrentFileTab();
          return;
        }
        const snap = paletteBus.getSnapshot();
        if (snap.open) {
          if (event.key === "Escape") { stopKey(event); closePalette(); return; }
          if (event.key === "ArrowDown") { stopKey(event); moveSelection(1); return; }
          if (event.key === "ArrowUp") { stopKey(event); moveSelection(-1); return; }
          if (event.key === "Enter") { stopKey(event); confirmSelection(); return; }
          if (event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey) {
            stopKey(event);
            switchPaletteMode(nextPaletteMode(snap.mode));
            return;
          }
          return;
        }
        if (chordHeld("files.searchEverywhere", event)) {
          stopKey(event);
          openPalette("everywhere");
          return;
        }
        if (chordHeld("files.searchContent", event)) {
          stopKey(event);
          openPalette("content");
        }
      };
      // 客户端 shell（client.js）以 `=== true` 判断该标志，值不能换成实例
      // token；用安装计数代替：热重载等场景下多个实例共存时，只有最后一个
      // 实例的 teardown 才 delete，避免拆掉其他实例仍在用的标志。
      closeOwnedInstalls += 1;
      window.__dshFilesCloseOwned = true;
      window.addEventListener("keydown", onKeydown, true);

      const lineNumberOfNode = (node) => {
        let el = node;
        if (el !== null && el !== undefined && el.nodeType !== 1) el = el.parentElement;
        if (el === null || el === undefined || typeof el.closest !== "function") return 0;
        const marked = el.closest("[data-textpreview-line]");
        if (marked === null) return 0;
        const n = Number(marked.getAttribute("data-textpreview-line"));
        return n > 0 ? n : 0;
      };

      const linesInPreview = (root) => {
        const sel = window.getSelection();
        if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
        const range = sel.getRangeAt(0);
        const host = range.commonAncestorContainer;
        const hostEl = host !== null && host.nodeType === 1 ? host : (host && host.parentElement);
        if (hostEl === null || hostEl === undefined || !root.contains(hostEl)) return null;
        let startLine = lineNumberOfNode(range.startContainer);
        let endLine = lineNumberOfNode(range.endContainer);
        if (startLine <= 0 && endLine <= 0) return null;
        if (startLine <= 0) startLine = endLine;
        if (endLine <= 0) endLine = startLine;
        if (endLine < startLine) { const tmp = startLine; startLine = endLine; endLine = tmp; }
        if (range.endOffset === 0 && endLine > startLine) endLine -= 1;
        if (endLine < startLine) endLine = startLine;
        return { start: startLine, end: endLine };
      };

      const previewIsVisible = (el) => {
        try {
          const box = el.getBoundingClientRect();
          return box.width >= 1 && box.height >= 1;
        } catch {
          return false;
        }
      };

      const activePreviewRoot = () => {
        const previews = document.querySelectorAll("[data-textpreview-state=text]");
        for (let i = previews.length - 1; i >= 0; i--) {
          if (previewIsVisible(previews[i])) return previews[i];
        }
        return previews.length > 0 ? previews[previews.length - 1] : null;
      };

      const absPathOfPreview = (root) => {
        const address = root.getAttribute("data-textpreview-url") || "";
        const parsed = parseFileAddress(address);
        const session = currentSession();
        if (parsed === null || session === null) return null;
        return {
          path: joinWorkspace(session.cwd, parsed.rel),
          rel: parsed.rel,
          address,
          session,
          sessionId: parsed.sessionId || session.id
        };
      };

      const activeFileInfo = () => {
        const session = currentSession();
        if (session === null || session.cwd === "") return null;
        const root = activePreviewRoot();
        if (root !== null) {
          const info = absPathOfPreview(root);
          if (info !== null && info.rel !== "") return { ...info, root };
        }
        const sidebar = sidebarRightService();
        let tab;
        try { tab = sidebar === undefined ? undefined : sidebar.active(); } catch { tab = undefined; }
        if (!isFileResource(tab) || isFilesPage(tab)) {
          const tabs = tabsOf(sidebar);
          tab = undefined;
          for (let i = tabs.length - 1; i >= 0; i--) {
            if (isFileResource(tabs[i]) && !isFilesPage(tabs[i])) { tab = tabs[i]; break; }
          }
        }
        if (tab !== undefined && typeof tab.contentId === "string") {
          const parsed = parseFileAddress(tab.contentId);
          if (parsed !== null && parsed.rel !== "") {
            return {
              path: joinWorkspace(session.cwd, parsed.rel),
              rel: parsed.rel,
              address: tab.contentId,
              session,
              sessionId: parsed.sessionId || session.id,
              root: null
            };
          }
        }
        return null;
      };

      const formatFileMention = (rel, lines) => {
        const path = String(rel || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
        if (path === "") return "";
        let extra = "";
        if (lines !== null && lines !== undefined && lines.start > 0) {
          extra = lines.start === lines.end ? (":" + lines.start) : (":" + lines.start + "-" + lines.end);
        }
        if (/[\u0000-\u001f\u007f-\u009f"]/.test(path)) return "";
        if (/\s/.test(path)) return '@"' + path + '"' + extra;
        return "@" + path + extra;
      };

      const mentionLabel = (rel, lines) => {
        const name = basename(rel);
        if (lines === null || lines === undefined || lines.start <= 0) return name;
        return lines.start === lines.end ? (name + ":" + lines.start) : (name + ":" + lines.start + "-" + lines.end);
      };

      /**
       * Insert the current file as a composer reference chip.
       * Steps: resolve the session shell, read the caret, insert one chip, focus.
       */
      const insertMention = (mention, label) => {
        if (mention === "") return false;
        const session = currentSession();
        if (session === null) return false;
        const conversation = conversationService();
        const input = conversation === undefined ? undefined : conversation.input;
        if (input === undefined || typeof input.shell !== "function") return false;
        let shell;
        try { shell = input.shell(session.id); } catch (err) {
          console.warn("dsh-files-navigator input.shell:", err);
          return false;
        }
        if (shell === null || shell === undefined || typeof shell.insertReference !== "function") return false;
        if (shell.state === undefined || typeof shell.state.getSnapshot !== "function") return false;
        try {
          const snap = shell.state.getSnapshot();
          let start = typeof snap.draft === "string" ? snap.draft.length : 0;
          let end = start;
          if (typeof shell.caretSpan === "function") {
            const caret = shell.caretSpan();
            if (caret !== null && caret !== undefined && typeof caret.start === "number") {
              start = caret.start;
              end = typeof caret.end === "number" ? caret.end : caret.start;
            }
          }
          const ok = shell.insertReference({
            source: "reference",
            ref: mention,
            label: label || basename(mention),
            appearance: "file",
            clipboardText: mention
          }, { start, end, draftRev: snap.draftRev });
          if (ok && typeof shell.focus === "function") shell.focus();
          return ok === true;
        } catch (err) {
          console.warn("dsh-files-navigator insertReference:", err);
          return false;
        }
      };

      const mentionActiveFile = () => {
        const ed = window.__dshEditorHotkeys;
        if (ed && typeof ed.currentFile === "function") {
          const file = ed.currentFile();
          if (file !== null && file !== undefined && file.rel) {
            const lines = file.collapsed === true ? null : { start: file.start, end: file.end };
            const mention = formatFileMention(file.rel, lines);
            if (mention !== "") {
              const ok = insertMention(mention, mentionLabel(file.rel, lines));
              if (ok && window.__dshEditorPanel && typeof window.__dshEditorPanel.backToChat === "function") {
                window.__dshEditorPanel.backToChat();
              }
              return ok;
            }
          }
        }
        const info = activeFileInfo();
        if (info === null || info.rel === "") return false;
        const lines = info.root !== null ? linesInPreview(info.root) : null;
        const mention = formatFileMention(info.rel, lines);
        if (mention === "") return false;
        const ok = insertMention(mention, mentionLabel(info.rel, lines));
        if (ok && window.__dshEditorPanel && typeof window.__dshEditorPanel.backToChat === "function") {
          window.__dshEditorPanel.backToChat();
        }
        return ok;
      };

      wrapSidebar(sidebarRightService());
      const armTimer = window.setTimeout(() => wrapSidebar(sidebarRightService()), 50);
      ctx.effect(() => () => {
        window.removeEventListener("keydown", onKeydown, true);
        // 只有本实例是最后一个安装者时才撤掉标志；否则其他实例仍在依赖它。
        if (closeOwnedInstalls > 0) closeOwnedInstalls -= 1;
        if (closeOwnedInstalls === 0) { try { delete window.__dshFilesCloseOwned; } catch {} }
        if (computeTimer) window.clearTimeout(computeTimer);
        if (chromeTimer) window.clearTimeout(chromeTimer);
        window.clearTimeout(armTimer);
      });

      const useBus = (bus) => {
        const [value, setValue] = React.useState(bus.getSnapshot);
        React.useEffect(() => {
          const update = () => setValue(bus.getSnapshot());
          update();
          return bus.subscribe(update);
        }, [bus]);
        return value;
      };

      function Palette() {
        const snap = useBus(paletteBus);
        useBus(langBus);
        const inputRef = React.useRef(null);
        React.useEffect(() => {
          if (!snap.open) return undefined;
          const id = window.setTimeout(() => {
            try { if (inputRef.current !== null) inputRef.current.focus(); } catch {}
          }, 20);
          return () => window.clearTimeout(id);
        }, [snap.open, snap.mode]);
        React.useEffect(() => {
          scrollRowIntoView(document.querySelector(".dfn-row.dfn-active"));
        }, [snap.selected]);
        // Park the anchor before this commit paints and drop it after, so no
        // frame is drawn without a root and nothing leaks on unmount. The first
        // half has to be a layout effect: the focus timer above starts ticking
        // in this same commit, and a `Portal` needs its container in the DOM by
        // then.
        const [host, setHost] = React.useState(null);
        React.useLayoutEffect(() => {
          if (!snap.open) return undefined;
          const target = deckHostFor(sidebarRightService());
          setHost(target);
          return () => {
            if (target !== null && target.classList.contains("dfn-deck-host")) target.replaceChildren();
            setHost((current) => (current === target ? null : current));
          };
        }, [snap.open]);
        // 宿主面板可能在我们不知情时被卸载/重建：portal 仍挂在脱离文档的
        // 节点上，调色板不可见但 snap.open 还是 true，快捷键会被它吞掉。
        // 打开期间周期校验 host.isConnected，失联就换新 host；找不到新宿主
        // 时直接关闭，宁可关掉也不留一个看不见的调色板。
        React.useEffect(() => {
          if (!snap.open || host === null) return undefined;
          const id = window.setInterval(() => {
            if (host.isConnected) return;
            const next = deckHostFor(sidebarRightService());
            if (next !== null) setHost(next);
            else closePalette();
          }, 300);
          return () => window.clearInterval(id);
        }, [snap.open, host]);
        if (!snap.open) return null;
        const onChange = (event) => {
          const query = event.target.value;
          // results 必须随 query 一起清空：computeResults 是防抖的（220ms），
          // 若保留旧 results，窗口内按 Enter 的 confirmSelection 会打开与
          // 新输入不匹配的过期结果。清空后确认路径在 loading 期间无数据可开。
          setPalette({ query, selected: 0, results: [] });
          scheduleCompute(snap.mode, query);
        };
        const rows = snap.results.map((file, i) => {
          const isContent = file.kind === "content";
          const className = i === snap.selected
            ? (isContent ? "dfn-row dfn-active dfn-row-code" : "dfn-row dfn-active")
            : (isContent ? "dfn-row dfn-row-code" : "dfn-row");
          if (isContent) {
            const where = (file.rel || file.path) + (file.line ? ":" + file.line : "");
            return React.createElement("button", {
              key: "c:" + file.path + ":" + file.line + ":" + i,
              type: "button",
              className,
              title: where,
              onMouseEnter: () => setPalette({ selected: i }),
              onClick: () => openPath(file)
            },
              React.createElement("span", { className: "dfn-glyph" }, extGlyph(file.name)),
              React.createElement("span", { className: "dfn-meta" },
                React.createElement("div", { className: "dfn-code" },
                  React.createElement("span", { className: "dfn-code-text" }, highlightRanges(file.text, file.ranges)),
                  React.createElement("span", { className: "dfn-code-where" }, where)
                )
              )
            );
          }
          return React.createElement("button", {
            key: file.path,
            type: "button",
            className,
            title: file.rel || file.path,
            onMouseEnter: () => setPalette({ selected: i }),
            onClick: () => openPath(file)
          },
            React.createElement("span", { className: "dfn-glyph" }, extGlyph(file.name)),
            React.createElement("span", { className: "dfn-meta" },
              React.createElement("div", { className: "dfn-name" }, highlight(file.name, snap.query)),
              React.createElement("div", { className: "dfn-path" }, highlight(file.rel || file.path, snap.query))
            )
          );
        });
        let body;
        if (snap.loading) {
          body = React.createElement("div", { className: "dfn-status" }, snap.status || (snap.mode === "content" ? t("searching") : t("indexing")));
        } else if (rows.length === 0) {
          let empty;
          if (snap.mode === "content") {
            // Control flow reads the structured statusKind; the translated
            // status text is only ever displayed.
            const failed = snap.statusKind === "invalidPattern" || snap.statusKind === "searchFail";
            if (failed) empty = React.createElement("span", { className: "dfn-warn" }, snap.status);
            else if (snap.statusKind === "emptyContent" || snap.statusKind === "truncated") empty = snap.status;
            else empty = snap.status || (snap.query ? t("emptyContent") : (snap.regex ? t("emptyContentRegex") : t("emptyContentQuery")));
          } else empty = snap.status || (snap.query ? t("emptyEverywhere") : t("emptyQuery"));
          body = React.createElement("div", { className: "dfn-empty" }, empty);
        } else {
          const showingRecent = snap.mode !== "content" && snap.query.trim() === "" && rows.length > 0;
          body = React.createElement("div", { className: "dfn-list" },
            showingRecent ? React.createElement("div", { className: "dfn-recent" }, t("recent")) : null,
            rows
          );
        }
        const placeholder = snap.mode === "content" ? t("placeholderContent") : t("placeholderEverywhere");
        const withKeyMode = (mode) => {
          const key = chordLabelOf(mode === "content" ? "files.searchContent" : "files.searchEverywhere");
          const label = t(mode);
          return key === "" ? label : label + " (" + key + ")";
        };
        const tabs = React.createElement("div", { className: "dfn-tabs" },
          ...MODE_ORDER.map((mode) =>
            React.createElement("button", {
              key: mode,
              type: "button",
              className: "dfn-tab",
              "data-on": snap.mode === mode ? "true" : undefined,
              title: withKeyMode(mode),
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => switchPaletteMode(mode)
            }, t(mode))
          )
        );
        const options = snap.mode === "content"
          ? React.createElement("div", { className: "dfn-opts" },
              ...[["regex", "regex"], ["caseSensitive", "caseSensitive"]].map(([key, label]) =>
                React.createElement("button", {
                  key,
                  type: "button",
                  className: "dfn-opt",
                  "data-on": snap[key] === true ? "true" : undefined,
                  "aria-pressed": snap[key] === true ? "true" : "false",
                  title: t(label),
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => toggleContentOption(key)
                }, t(label))
              )
            )
          : null;
        const foot = snap.mode === "content"
          ? t("hintContent")
          : t("hint", {
              search: chordLabelOf("files.searchEverywhere"),
              content: chordLabelOf("files.searchContent")
            });
        const surface = React.createElement("div", {
          className: "dfn-overlay",
          onMouseDown: (event) => { if (event.target === event.currentTarget) closePalette(); }
        },
          React.createElement("div", { className: "dfn-card", role: "dialog", "aria-label": t("overlay") },
            React.createElement("div", { className: "dfn-head" },
              tabs,
              React.createElement("input", {
                ref: inputRef,
                className: "dfn-input",
                value: snap.query,
                placeholder,
                onChange
              }),
              options
            ),
            body,
            React.createElement("div", { className: "dfn-foot" }, foot)
          )
        );
        return host === null ? surface : ReactDOM.createPortal(surface, host);
      }

      function CloseOthersItem(props) {
        useBus(langBus);
        const tab = props.tab;
        if (tab === undefined || isFilesPage(tab) || !isFileResource(tab)) return null;
        return React.createElement("button", {
          type: "button",
          className: "dfn-menu-item",
          title: t("closeOthers"),
          onClick: () => {
            closeOthers(tab);
            if (typeof props.dismiss === "function") props.dismiss();
          }
        }, t("closeOthers"));
      }

      function CloseAllItem(props) {
        useBus(langBus);
        const tab = props.tab;
        if (tab === undefined || isFilesPage(tab) || !isFileResource(tab)) return null;
        return React.createElement("button", {
          type: "button",
          className: "dfn-menu-item",
          title: t("closeAll"),
          onClick: () => {
            closeAllFiles();
            if (typeof props.dismiss === "function") props.dismiss();
          }
        }, t("closeAll"));
      }

      /**
       * The Chat header's Workspace badge.
       *
       * The flat sidebar list drops the per-Workspace group header, so a row's
       * own folder is not visible anywhere once the Session is open. This shows
       * it beside the title: the Workspace's user-visible title, or the cwd's
       * basename for an unaccounted Session. Renders nothing without a label.
       *
       * Re-reads on every `sessions`/`workspaces` list revision, so a rename or
       * a Workspace move lands without remounting the header.
       */
      function WorkspaceBadge(props) {
        // Every Hook runs before any early return: this entry is mounted by a
        // `session` scope seat whose `sessionId` can vanish on a switch, and a
        // conditional Hook count would break the render.
        const [, bump] = React.useState(0);
        useBus(langBus);
        React.useEffect(() => {
          const sources = [];
          const sessions = sessionsService();
          const workspaces = workspacesService();
          if (sessions !== undefined && sessions.list !== undefined && typeof sessions.list.subscribe === "function") {
            sources.push(sessions.list);
          }
          if (workspaces !== undefined && workspaces.list !== undefined && typeof workspaces.list.subscribe === "function") {
            sources.push(workspaces.list);
          }
          const offs = sources.map((source) => {
            try { return source.subscribe(() => bump((n) => n + 1)); } catch { return null; }
          });
          return () => {
            for (let i = 0; i < offs.length; i++) {
              if (offs[i] !== null) { try { offs[i](); } catch {} }
            }
          };
        }, []);
        const sessionId = props !== null && props !== undefined && typeof props.sessionId === "string" ? props.sessionId : "";
        if (sessionId === "") return null;
        const label = workspaceLabelOf(sessionId);
        if (label === "") return null;
        const sessions = sessionsService();
        const snap = sessions === undefined || sessions.list === undefined ? undefined : sessions.list.getSnapshot();
        const cwd = snap === undefined || snap === null || snap.byId === undefined ? "" : (snap.byId[sessionId]?.cwd ?? "");
        return React.createElement("span", {
          className: "dfn-ws",
          title: cwd !== "" && cwd !== label ? t("workspace") + ": " + cwd : t("workspace")
        },
          React.createElement("svg", {
            className: "dfn-ws-icon", width: 12, height: 12, viewBox: "0 0 16 16",
            fill: "none", "aria-hidden": "true"
          },
            React.createElement("path", {
              d: "M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.4a1 1 0 0 1-1-1z",
              stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round"
            })
          ),
          React.createElement("span", { className: "dfn-ws-name" }, label)
        );
      }

      slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "files-navigator-overlay", order: 8, label: () => t("overlay") },
        Palette
      ));
      slots.inject("conversation.session.header.actions", () => slots.register(
        { name: "conversation.session.header.actions", id: "files-navigator-workspace", order: 30, label: () => t("workspace") },
        WorkspaceBadge
      ));
      slots.inject("sidebar.right.tab.menu.item", () => slots.register(
        { name: "sidebar.right.tab.menu.item", id: "files-navigator-close-others", order: 40, label: () => t("closeOthers") },
        CloseOthersItem
      ));
      slots.inject("sidebar.right.tab.menu.item", () => slots.register(
        { name: "sidebar.right.tab.menu.item", id: "files-navigator-close-all", order: 41, label: () => t("closeAll") },
        CloseAllItem
      ));

      // Whole-history transcripts: the Chat header's "加载更早" button stays
      // available, but the pump usually satisfies it before the reader gets there.
      ctx.effect(() => installHistoryPump());

      // 记录本实例写入的引用：teardown 时只有 window 上仍是这个对象才
      // delete，避免热重载后把新实例刚挂上的 API 一并拆掉。
      const navigatorApi = {
        search: () => openPalette("everywhere"),
        content: () => openPalette("content"),
        mentionFile: () => mentionActiveFile()
      };
      window.__dshFilesNavigator = navigatorApi;
      ctx.effect(() => () => {
        if (window.__dshFilesNavigator === navigatorApi) {
          try { delete window.__dshFilesNavigator; } catch {}
        }
      });

      const registerCommands = () => {
        const api = hotkeyBridge();
        if (api === null || typeof api.register !== "function") return null;
        try {
          return api.register({
            owner: PLUGIN,
            commands: [
              {
                id: "files.searchEverywhere",
                group: "files",
                order: 10,
                labels: { zh: "搜索文件（Search Everywhere）", en: "Search files (Search Everywhere)" },
                default: FILE_CHORDS["files.searchEverywhere"]
              },
              {
                id: "files.searchContent",
                group: "files",
                order: 15,
                labels: { zh: "搜索文件内容（Find in Files）", en: "Search file contents (Find in Files)" },
                default: FILE_CHORDS["files.searchContent"]
              },
              {
                id: "files.closeFileTab",
                group: "files",
                order: 40,
                labels: { zh: "关闭当前文件标签", en: "Close current file tab" },
                default: FILE_CHORDS["files.closeFileTab"]
              }
            ]
          });
        } catch (err) {
          console.error("dsh-files-navigator: shortcut registration failed", err);
          return null;
        }
      };
      let unregisterCommands = null;
      const onCatalogReady = () => {
        // 闭包里的 unregisterCommands 只可能是本实例上次 register 的返回值，
        // 注销的永远是"自己注册的"；ready 事件重放时也不会动别的实例的注册。
        if (typeof unregisterCommands === "function") {
          try { unregisterCommands(); } catch {}
        }
        unregisterCommands = registerCommands();
      };
      onCatalogReady();
      window.addEventListener("dsh-keyboard-shortcuts-ready", onCatalogReady);
      ctx.effect(() => () => {
        window.removeEventListener("dsh-keyboard-shortcuts-ready", onCatalogReady);
        if (typeof unregisterCommands === "function") {
          try { unregisterCommands(); } catch {}
        }
        unregisterCommands = null;
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
