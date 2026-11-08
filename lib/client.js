// dsh-idea — browser half. One loader factory, same constraint as
// dsh-database: the page can require react, nothing else. The marked region is
// the tokenizer from lib/highlight.js; the test checks the bytes match.
window.__ModuleLoader__.load({
  id: "dsh-idea",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let React = require("react");
    if (React === null || typeof React !== "object") throw new Error("dsh-idea: react is unavailable");
    if (React.useState === undefined && React.default !== undefined && typeof React.default === "object") React = React.default;

    let ui = null;
    try { ui = require("@deepseek-ai/dsh-client-ui-primitives"); } catch {}
    if (ui !== null && ui.FileTypeIcon === undefined && ui.default !== undefined) ui = ui.default;

    let createRoot;
    try {
      const rdc = require("react-dom/client");
      if (rdc !== null && typeof rdc === "object") createRoot = rdc.createRoot;
    } catch {}
    try {
      const rd = require("react-dom");
      if (rd !== null && typeof rd === "object" && typeof createRoot !== "function") {
        createRoot = (el) => ({
          render: (node) => rd.render(node, el),
          unmount: () => { try { rd.unmountComponentAtNode(el); } catch {} }
        });
      }
    } catch {}

    const h = React.createElement;
    const PLUGIN = "dsh-idea";
    // The page kind this plugin claims in the host's tab system. The type id is
    // the package name, so a body and a title register under it.
    const EDITOR_KIND = "editor";
    const API = "/plugins/dsh-idea";
    const TREE_W_KEY = "dsh.code-editor.treew";
    const GIT_H_KEY = "dsh.code-editor.gith";
    // Shared with dsh-database: "fullscreen" pins the column over the
    // conversation when the editor opens, "push" keeps the ordinary split
    // width. Default fullscreen = the behavior before this preference existed.
    const OPEN_MODE_KEY = "dsh.rightcolumn.openmode";
    const TREE_CLOSED_KEY = "dsh.code-editor.treeclosed";
    // "preview" (default) or "edit": how a .md tab opens. One preference for
    // every tab, so flipping one Markdown file teaches the rest of them.
    const MD_VIEW_KEY = "dsh.code-editor.mdview";
    // The dock is a companion to the editor, not a workspace of its own: Git
    // lives under the editor now, so its state rides on a document attribute
    // the Git panel owns.
    const GIT_DOCK_ATTR = "dshGitDock";
    const MAX_DIFF_TABS = 8;

    const detectMac = () => {
      try {
        if (window.navigator.userAgentData !== undefined && window.navigator.userAgentData.platform === "macOS") return true;
      } catch {}
      try { return /Macintosh|Mac OS X/i.test(window.navigator.userAgent); } catch {}
      return false;
    };
    const IS_MAC = detectMac();
    const chord = (mods) => ({
      ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift, meta: !!mods.meta, code: mods.code
    });
    const TOGGLE = chord(IS_MAC ? { meta: true, code: "Digit1" } : { ctrl: true, code: "Digit1" });
    // ⌘B is the host's left-sidebar chord, so definition uses ⌥ as well.
    const DEFINITION = chord(IS_MAC ? { meta: true, alt: true, code: "KeyB" } : { ctrl: true, alt: true, code: "KeyB" });
    const REFERENCES = chord({ alt: true, code: "F7" });
    // ⌘[ / ⌘] mirror IDEA's navigate back/forward. ⌥← stays as a legacy
    // alias for back.
    const BACK = chord(IS_MAC ? { meta: true, code: "BracketLeft" } : { ctrl: true, code: "BracketLeft" });
    const FORWARD = chord(IS_MAC ? { meta: true, code: "BracketRight" } : { ctrl: true, code: "BracketRight" });
    const IMPLEMENTATION = chord(IS_MAC ? { meta: true, shift: true, code: "KeyB" } : { ctrl: true, shift: true, code: "KeyB" });
    const LEGACY_BACK = chord({ alt: true, code: "ArrowLeft" });
    const COMMANDS = [
      {
        id: "editor.toggle",
        group: "editor",
        order: 5,
        labels: { zh: "进入全屏/收起右栏", en: "Fullscreen, or collapse the right column" },
        default: TOGGLE
      },
      {
        id: "editor.definition",
        group: "editor",
        order: 10,
        labels: { zh: "跳转到定义", en: "Go to definition" },
        default: DEFINITION
      },
      {
        id: "editor.references",
        group: "editor",
        order: 20,
        labels: { zh: "查找引用", en: "Find references" },
        default: REFERENCES
      },
      {
        id: "editor.back",
        group: "editor",
        order: 30,
        labels: { zh: "后退到跳转前的位置", en: "Back to the previous location" },
        default: BACK
      },
      {
        id: "editor.forward",
        group: "editor",
        order: 31,
        labels: { zh: "前进到下一个位置", en: "Forward to the next location" },
        default: FORWARD
      },
      {
        id: "editor.implementation",
        group: "editor",
        order: 25,
        labels: { zh: "跳转到实现", en: "Go to implementation" },
        default: IMPLEMENTATION
      }
    ];

    // Own catalog. nav and git register into the same store; nothing here reads
    // dsh-keyboard-shortcuts. A missing own record is copied once from that
    // plugin's old blob so a rebound chord survives the split.
    const IDEA_KEYS_KEY = "dsh.idea.keys";
    const LEGACY_KEYS_KEY = "dsh.keyboard-shortcuts.keys";
    const cloneKeySpec = (spec) => {
      if (spec === null || spec === undefined) return null;
      if (typeof spec.code !== "string" || spec.code === "") return null;
      return { ctrl: !!spec.ctrl, alt: !!spec.alt, shift: !!spec.shift, meta: !!spec.meta, code: spec.code };
    };
    const readKeyObject = (key) => {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw === "") return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed;
      } catch { return null; }
    };
    const storedKeySpec = (value) => {
      if (value === null) return null;
      if (value !== null && typeof value === "object" && typeof value.code === "string") return cloneKeySpec(value);
      return undefined;
    };
    const createIdeaKeys = () => {
      const providers = new Map();
      const listeners = new Set();
      let nextToken = 1;
      let commands = [];
      let bindings = {};
      const persist = () => {
        try { window.localStorage.setItem(IDEA_KEYS_KEY, JSON.stringify(bindings)); } catch {}
      };
      const notify = () => {
        for (const fn of listeners) { try { fn(); } catch {} }
      };
      const rebuild = () => {
        const merged = [];
        for (const provider of providers.values()) {
          for (const cmd of provider.commands) {
            if (merged.some((row) => row.id === cmd.id)) continue;
            merged.push(cmd);
          }
        }
        merged.sort((a, b) => a.order - b.order);
        commands = merged;
        const own = readKeyObject(IDEA_KEYS_KEY) || {};
        const legacy = readKeyObject(LEGACY_KEYS_KEY) || {};
        const next = {};
        let dirty = false;
        for (const cmd of commands) {
          if (Object.prototype.hasOwnProperty.call(bindings, cmd.id)) {
            next[cmd.id] = bindings[cmd.id];
            continue;
          }
          const fromOwn = Object.prototype.hasOwnProperty.call(own, cmd.id) ? storedKeySpec(own[cmd.id]) : undefined;
          if (fromOwn !== undefined) { next[cmd.id] = fromOwn; continue; }
          const fromLegacy = Object.prototype.hasOwnProperty.call(legacy, cmd.id) ? storedKeySpec(legacy[cmd.id]) : undefined;
          if (fromLegacy !== undefined) { next[cmd.id] = fromLegacy; dirty = true; continue; }
          next[cmd.id] = cloneKeySpec(cmd.default);
          dirty = true;
        }
        bindings = next;
        if (dirty) persist();
      };
      const api = {
        commands: () => commands.slice(),
        has: (id) => commands.some((cmd) => cmd.id === id),
        binding: (id) => (commands.some((cmd) => cmd.id === id) ? bindings[id] : undefined),
        set: (id, spec) => {
          if (!commands.some((cmd) => cmd.id === id)) return;
          bindings = { ...bindings, [id]: spec === null ? null : cloneKeySpec(spec) };
          persist();
          notify();
        },
        reset: (id) => {
          const cmd = commands.find((row) => row.id === id);
          if (cmd === undefined) return;
          bindings = { ...bindings, [id]: cloneKeySpec(cmd.default) };
          persist();
          notify();
        },
        match: (id, event, codes) => {
          const spec = bindings[id];
          if (spec === null || spec === undefined || typeof spec.code !== "string") return false;
          const aliases = Array.isArray(codes) ? codes : [];
          if (spec.code !== event.code && (aliases.indexOf(event.code) < 0 || aliases.indexOf(spec.code) < 0)) return false;
          return !!spec.ctrl === !!event.ctrlKey && !!spec.alt === !!event.altKey && !!spec.shift === !!event.shiftKey && !!spec.meta === !!event.metaKey;
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
        register: (provider) => {
          if (provider === null || typeof provider !== "object") return () => {};
          const list = Array.isArray(provider.commands) ? provider.commands : [];
          const normalized = [];
          for (const cmd of list) {
            if (cmd === null || typeof cmd !== "object" || typeof cmd.id !== "string" || cmd.id === "") continue;
            normalized.push({
              id: cmd.id,
              group: typeof cmd.group === "string" && cmd.group !== "" ? cmd.group : "editor",
              order: typeof cmd.order === "number" ? cmd.order : 1000,
              labels: cmd.labels !== null && typeof cmd.labels === "object" ? cmd.labels : null,
              default: cloneKeySpec(cmd.default)
            });
          }
          if (normalized.length === 0) return () => {};
          const token = nextToken;
          nextToken += 1;
          providers.set(token, { commands: normalized });
          rebuild();
          notify();
          return () => {
            if (providers.get(token) === undefined) return;
            providers.delete(token);
            const drop = {};
            for (const cmd of normalized) drop[cmd.id] = true;
            for (const other of providers.values()) {
              for (const cmd of other.commands) delete drop[cmd.id];
            }
            const kept = {};
            for (const id of Object.keys(bindings)) {
              if (drop[id] !== true) kept[id] = bindings[id];
            }
            bindings = kept;
            rebuild();
            notify();
          };
        }
      };
      return api;
    };
    const ideaKeys = createIdeaKeys();
    window.__dshIdeaKeys = ideaKeys;
    ideaKeys.register({ owner: "dsh-idea", commands: COMMANDS });
    try { window.dispatchEvent(new CustomEvent("dsh-idea-keys-ready")); } catch {}

    const chordMatches = (spec, event, codes) => {
      if (spec === null || spec === undefined) return false;
      if (spec.code !== event.code) {
        if (codes.indexOf(event.code) < 0 || codes.indexOf(spec.code) < 0) return false;
      }
      if (!!spec.ctrl !== !!event.ctrlKey) return false;
      if (!!spec.alt !== !!event.altKey) return false;
      if (!!spec.shift !== !!event.shiftKey) return false;
      if (!!spec.meta !== !!event.metaKey) return false;
      return true;
    };
    const chordHeld = (event) => {
      const codes = ["Digit1", "Numpad1"];
      try {
        if (ideaKeys.has("editor.toggle")) return ideaKeys.match("editor.toggle", event, codes) === true;
      } catch {}
      return chordMatches(TOGGLE, event, codes);
    };
    // ⌘1 is the browser's "switch to tab 1", so the page often only hears the
    // keyup. While the binding is still Digit1, also accept the other of Ctrl/⌘
    // (⌃1 on macOS). Same contract as the database plugin's ⌘2 / ⌃2.
    const isOneEvent = (event) => event.code === "Digit1" || event.code === "Numpad1" || event.key === "1";
    // ⌥⌘Enter / Ctrl+Alt+Enter is the column's own fullscreen chord, not a
    // second chord for opening the editor: the database workspace claims the
    // same key for its panel. Answering it here would toggle this workspace
    // while the database is on screen, so the editor only reacts when it is the
    // visible workspace — see the forwarding handler in apply().
    const enterAliasHeld = (event) => {
      if (event.shiftKey) return false;
      if (event.code !== "Enter" && event.code !== "NumpadEnter" && event.key !== "Enter") return false;
      return IS_MAC
        ? event.metaKey && event.altKey && !event.ctrlKey
        : event.ctrlKey && event.altKey && !event.metaKey;
    };
    const toggleHeld = (event) => {
      if (chordHeld(event)) return true;
      if (event.altKey || event.shiftKey || event.repeat === true) return false;
      if (event.metaKey === event.ctrlKey) return false;
      if (!isOneEvent(event)) return false;
      let spec = TOGGLE;
      try {
        if (ideaKeys.has("editor.toggle")) {
          const bound = ideaKeys.binding("editor.toggle");
          if (bound !== undefined) spec = bound;
        }
      } catch {}
      if (spec === null || spec === undefined) return false;
      if (spec.code !== "Digit1" && spec.code !== "Numpad1") return false;
      if (spec.alt || spec.shift) return false;
      return !!spec.ctrl !== !!spec.meta;
    };
    const codeName = (code) => {
      if (typeof code !== "string" || code === "") return "";
      if (code === "Escape") return "Esc";
      if (code === "BracketLeft") return "[";
      if (code === "BracketRight") return "]";
      if (code === "Enter" || code === "NumpadEnter") return "Enter";
      if (code.indexOf("Key") === 0 && code.length === 4) return code.slice(3);
      if (code.indexOf("Digit") === 0) return code.slice(5);
      return code;
    };
    const chordText = (spec) => {
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
        if (spec.shift) parts.push("Shift");
        if (spec.meta) parts.push("Win");
      }
      const key = codeName(spec.code);
      if (key !== "") parts.push(key);
      return parts.join(IS_MAC ? "" : "+");
    };
    const boundText = (id, fallback) => {
      let spec = fallback;
      try {
        if (ideaKeys.has(id)) {
          const bound = ideaKeys.binding(id);
          if (bound !== undefined) spec = bound;
        }
      } catch {}
      return chordText(spec);
    };
    const withKey = (label, key) => (key ? label + " (" + key + ")" : label);
    const shortcutApi = () => ideaKeys;
    const isModifierCode = (code) => (
      code === "ShiftLeft" || code === "ShiftRight" ||
      code === "ControlLeft" || code === "ControlRight" ||
      code === "AltLeft" || code === "AltRight" ||
      code === "MetaLeft" || code === "MetaRight"
    );
    // Same rule as the shortcuts page: a bare typing key is refused, and so are
    // the chords the browser keeps (close tab, new tab, new window, address bar).
    const recordableShortcut = (event) => {
      if (typeof event.key === "string" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return "bare";
      if ((event.ctrlKey || event.metaKey) && (event.code === "KeyW" || event.code === "KeyT" || event.code === "KeyN" || event.code === "KeyL")) return "reserved";
      return "";
    };
    const KEY_GROUPS = ["files", "editor", "git"];

    const I18N = {
      zh: {
        files: "文件", editor: "IDEA", save: "保存", refresh: "刷新",
        empty: "从左侧选择文件", emptyDir: "空目录", loading: "正在读取…",
        noWorkspace: "当前会话没有工作区",
        discard: "放弃未保存的修改？", binary: "这是二进制文件，不能当文本编辑",
        "not-utf8": "不是 UTF-8，为避免写坏文件已拒绝打开", "too-large": "文件超过 1.5 MB",
        "image-too-large": "图片超过 8 MB", image: "图片",
        "is-directory": "这是目录", "not-found": "找不到文件", outside: "路径超出工作区",
        "bad-path": "路径不合法", "cwd-required": "当前会话没有工作区",
        line: "行", col: "列", chars: "字符", find: "查找", utf8: "UTF-8",
        saved: "已保存", noSymbol: "没有找到定义或引用",
        locate: "在文件树中定位", newFile: "新建文件", newDir: "新建文件夹", rename: "重命名", remove: "删除",
        namePrompt: "名称", confirmDelete: "删除 {name}？", exists: "已经存在",
        dirNotFound: "找不到目录", outsideWorkspace: "文件不属于当前工作区", fileNotFound: "找不到该文件",
        kindClass: "类", kindInterface: "接口", kindEnum: "枚举", kindCall: "调用",
        "lsp-unavailable": "没有可用的语言服务器", "lsp-failed": "语言服务器查询失败",
        jumpCode: "跳到代码", diffTab: "变更", noDiff: "这个文件没有可显示的差异",
        conflict: "文件已在磁盘上被修改，已取消覆盖；关闭标签重新打开可看最新内容",
        readOnly: "只读", gitDock: "Git 面板",
        preview: "预览", edit: "编辑", mdPreview: "预览 Markdown", mdSource: "编辑 Markdown 源码",
        copy: "复制", copied: "已复制", copyFailed: "复制失败，请手动选中代码",
        openModeFullscreen: "默认全屏打开", openModePush: "默认分栏打开",
        openModeHint: "打开编辑器或数据库时，右栏默认全屏还是保持分栏。点此切换，马上生效。",
        collapseTree: "收起文件树", expandTree: "展开文件树",
        eol: "换行符",
        keys: "快捷键",
        keysHint: "点击按键录制，Esc 取消。清除后该命令不再响应。",
        keysEmpty: "没有可改的快捷键。",
        keysRecording: "按下快捷键…",
        keysClear: "清除快捷键",
        keysReset: "恢复默认",
        keysBare: "请加上 Ctrl、⌘ 或 Alt",
        keysReserved: "这个组合被浏览器占用",
        keysConflict: "与「{name}」冲突",
        keysGroupSession: "对话与会话", keysGroupWorkspace: "工作区", keysGroupFiles: "文件",
        keysGroupEditor: "编辑器", keysGroupGit: "Git", keysGroupDatabase: "数据库", keysGroupOther: "其他"
      },
      en: {
        files: "Files", editor: "IDEA", save: "Save", refresh: "Refresh",
        empty: "Choose a file on the left", emptyDir: "Empty directory", loading: "Loading…",
        noWorkspace: "This conversation has no workspace",
        discard: "Discard unsaved changes?", binary: "Binary file, not opened as text",
        "not-utf8": "Not UTF-8, left unopened so it cannot be corrupted", "too-large": "File is larger than 1.5 MB",
        "image-too-large": "Image is larger than 8 MB", image: "Image",
        "is-directory": "This is a directory", "not-found": "File not found", outside: "Path is outside the workspace",
        "bad-path": "Invalid path", "cwd-required": "This conversation has no workspace",
        line: "Ln", col: "Col", chars: "chars", find: "Find", utf8: "UTF-8",
        saved: "Saved", noSymbol: "No definition or reference",
        locate: "Scroll to this file", newFile: "New file", newDir: "New folder", rename: "Rename", remove: "Delete",
        namePrompt: "Name", confirmDelete: "Delete {name}?", exists: "Already exists",
        dirNotFound: "Directory not found", outsideWorkspace: "File is not in this workspace", fileNotFound: "File not found",
        kindClass: "class", kindInterface: "interface", kindEnum: "enum", kindCall: "call",
        "lsp-unavailable": "No language server for this file", "lsp-failed": "Language server query failed",
        jumpCode: "Go to code", diffTab: "Changes", noDiff: "Nothing to show for this file",
        conflict: "Changed on disk; overwrite cancelled. Close and reopen the tab to load the latest content",
        readOnly: "read-only", gitDock: "Git panel",
        preview: "Preview", edit: "Edit", mdPreview: "Preview the rendered Markdown", mdSource: "Edit the Markdown source",
        copy: "Copy", copied: "Copied", copyFailed: "Copy failed; select the code manually",
        openModeFullscreen: "Fullscreen by default", openModePush: "Split by default",
        openModeHint: "Default width when the editor or database opens: fullscreen, or the split column. Click to switch; it applies now.",
        collapseTree: "Collapse the file tree", expandTree: "Expand the file tree",
        eol: "Line ending",
        keys: "Shortcuts",
        keysHint: "Click a binding to record it. Esc cancels. Clear unbinds the command.",
        keysEmpty: "No shortcuts to edit.",
        keysRecording: "Press a shortcut…",
        keysClear: "Clear shortcut",
        keysReset: "Restore default",
        keysBare: "Add Ctrl, ⌘, or Alt",
        keysReserved: "The browser reserves that chord",
        keysConflict: "Conflicts with “{name}”",
        keysGroupSession: "Conversations", keysGroupWorkspace: "Workspace", keysGroupFiles: "Files",
        keysGroupEditor: "Editor", keysGroupGit: "Git", keysGroupDatabase: "Database", keysGroupOther: "Other"
      }
    };

    // Matches dsh-database's tab chip: same blue, same 16px optical size, so the
    // two page tabs read as one set.
    function EditorGlyph() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M5.7 4.3L2.4 8l3.3 3.7", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M10.3 4.3L13.6 8l-3.3 3.7", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }),
      );
    }

    // One stroke weight and one box for the four tree-bar tools. Text glyphs
    // («, +) and the host refresh icon do not share an optical size.
    function ToolIcon({ name }) {
      const svg = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true };
      const pen = { stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" };
      if (name === "locate") {
        return h("svg", svg,
          h("circle", { cx: "8", cy: "8", r: "2.5", stroke: "currentColor", strokeWidth: "1.4" }),
          h("path", { d: "M8 1.8v2.3M8 11.9v2.3M1.8 8h2.3M11.9 8h2.3", ...pen }));
      }
      if (name === "collapse") return h("svg", svg, h("path", { d: "M10.2 3.4L5.6 8l4.6 4.6", ...pen }));
      if (name === "plus") return h("svg", svg, h("path", { d: "M8 3.2v9.6M3.2 8h9.6", ...pen }));
      return h("svg", svg,
        h("path", { d: "M13 8a5 5 0 1 1-1.2-3.3", ...pen }),
        h("path", { d: "M13 3.1V6.2H9.9", ...pen }));
    }

    const STYLE = [
      // The editor is an ordinary tab body now: the host owns the panel, the tab
      // strip, the background and the pointer events, so nothing here reaches
      // outside `.dce-root` and nothing competes for a layer above the dock.
      // Editor area on top, Git dock below. The dock is a sibling of the
      // editor body rather than another workspace mode, so a change list and
      // the file it describes can be on screen at the same time.
      ".dce-body{flex:auto;min-height:0;min-width:0;display:flex;flex-direction:column}",
      ".dce-gitsplit{display:none;flex:none;height:6px;cursor:ns-resize;background:transparent;border-top:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-gitsplit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dce-gitpane{display:none;flex:none;height:var(--dce-git-h,300px);min-height:120px;max-height:72%;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary)}",
      "html[data-dsh-git-dock=\"1\"] .dce-gitsplit{display:block}",
      "html[data-dsh-git-dock=\"1\"] .dce-gitpane{display:flex;flex-direction:column}",
      // The commit window (tree + diff + message) needs the column, not the
      // list's height; the Git chunk raises this while it is open.
      "html[data-dsh-git-tall=\"1\"] .dce-gitpane{height:68%!important}",
      ".dce-gitpane:empty{display:none!important}",
      ".dce-root{flex:auto;min-height:0;min-width:0;display:flex;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary)}",
      ".dce-tabico{display:inline-flex;align-items:center;margin-right:6px;color:#3d6fd9}",
      ".dce-tree{flex:none;min-height:0;min-width:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}",
      ".dce-treebar{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 16px;display:flex}",
      ".dce-treename{flex:auto;min-width:0;margin-right:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dce-tool{width:22px;height:22px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:transparent;border:0;flex:none;justify-content:center;align-items:center;padding:0;line-height:0;display:inline-flex}",
      ".dce-tool svg{width:14px;height:14px;display:block}",
      ".dce-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-tool:disabled{opacity:.4;cursor:default;background:transparent}",
      ".dce-iconbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);height:24px;padding:0 6px;border-radius:6px;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
      ".dce-iconbtn svg{width:14px;height:14px}",
      ".dce-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dce-iconbtn:disabled{opacity:.4;cursor:default}",
      ".dce-scroll{scrollbar-gutter:stable;flex:auto;min-height:0;margin-right:2px;padding:8px 0 8px 8px;overflow:auto}",
      ".dce-level{margin:0;padding:0;list-style:none}",
      ".dce-level .dce-level{padding-left:18px}",
      ".dce-item{margin:0;padding:0}",
      ".dce-row{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;border-radius:var(--dsw-radius-md);cursor:pointer;background:transparent;border:0;align-items:center;gap:6px;padding:5px 10px;display:flex}",
      ".dce-row:hover,.dce-row.dce-on{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-icon{color:var(--dsw-alias-label-tertiary);flex:none}",
      ".dce-fileicon{flex:none}",
      ".dce-name{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}",
      ".dce-note{color:var(--dsw-alias-label-tertiary);margin:0;padding:3px 10px;font-size:12px}",
      ".dce-split{flex:none;width:4px;cursor:col-resize}",
      // The 16px rail left behind by a collapsed tree; its button is the only
      // way back, so it must stay clickable at any column width.
      ".dce-treefold{flex:none;width:16px;display:flex;align-items:flex-start;justify-content:center;border-right:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff)}",
      ".dce-foldbtn{appearance:none;border:0;background:transparent;cursor:pointer;padding:10px 2px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1}",
      ".dce-foldbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dce-doc{flex:auto;min-width:0;min-height:0;display:flex;flex-direction:column}",
      ".dce-docbar{flex:none;height:32px;display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-path{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".dce-dirty{flex:none;width:7px;height:7px;border-radius:99px;background:#e0b040}",
      ".dce-find{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-find input{flex:auto;height:24px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:0 8px;outline:none}",
      ".dce-editor{flex:auto;min-height:0;min-width:0;display:flex}",
      ".dce-gutter{flex:none;overflow:hidden;margin:0;padding:6px 8px 16px;border-right:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);text-align:right;user-select:none}",
      ".dce-scroller{position:relative;flex:auto;min-width:0;overflow:auto}",
      ".dce-flashline{position:absolute;left:0;right:0;pointer-events:none;background:rgba(255,205,60,.26);animation:dce-flash 1.6s ease-out forwards}",
      "@keyframes dce-flash{0%{opacity:1}100%{opacity:0}}",
      ".dce-gutter,.dce-paint,.dce-input{font-family:var(--dsh-font-family-code,ui-monospace),ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:calc(var(--dsh-code-font-size,12px) - 1px);line-height:1.45;tab-size:4}",
      ".dce-tabs{flex:none;display:flex;align-items:center;gap:2px;height:32px;padding:0 6px;overflow:auto;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-tab{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:180px;height:24px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
      ".dce-tab.dce-on{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform,#eef3f8));color:var(--dsw-alias-label-primary)}",
      ".dce-tabname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dce-diffbadge{flex:none;font-size:10px;font-weight:700;color:#3d6fd9;line-height:1}",
      "body[data-ds-dark-theme] .dce-diffbadge{color:#7ba7f0}",
      ".dce-diffhash{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}",
      // A diff tab is read-only: one row per diff line, aligned numbers on the
      // left, the new-side number when there is one.
      ".dce-diffview{flex:auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".dce-diffscroll{flex:auto;min-height:0;overflow:auto;padding:6px 0}",
      ".dce-diffpre{margin:0;font-family:var(--dsh-font-family-code,ui-monospace),ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:calc(var(--dsh-code-font-size,12px) - 1px);line-height:1.5;white-space:pre;min-width:100%}",
      ".dce-diffplain{padding:0 12px}",
      ".dce-dlrow{display:flex;gap:0;white-space:pre;padding:0 12px 0 0}",
      ".dce-dlnum{flex:none;width:52px;padding-right:10px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}",
      ".dce-dltxt{flex:auto;min-width:0;white-space:pre}",
      ".dce-dlrow[data-k=\"+\"]{background:rgba(89,179,90,.12)}",
      ".dce-dlrow[data-k=\"+\"] .dce-dltxt{color:#2f8f45}",
      ".dce-dlrow[data-k=\"-\"]{background:rgba(224,122,95,.14)}",
      ".dce-dlrow[data-k=\"-\"] .dce-dltxt{color:#c0655f}",
      ".dce-dlrow[data-k=\"@\"] .dce-dltxt{color:#5b9bd5}",
      ".dce-dlrow[data-k=\"h\"] .dce-dltxt{color:var(--dsw-alias-label-tertiary)}",
      "body[data-ds-dark-theme] .dce-dlrow[data-k=\"+\"] .dce-dltxt{color:#8fd48f}",
      "body[data-ds-dark-theme] .dce-dlrow[data-k=\"-\"] .dce-dltxt{color:#e07a5f}",
      ".dce-menu{position:fixed;z-index:80;min-width:140px;padding:4px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 8px 24px rgba(0,0,0,.12)}",
      ".dce-menu button{display:block;width:100%;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;padding:5px 8px;border-radius:6px;cursor:pointer}",
      ".dce-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-paint,.dce-input{margin:0;padding:6px 12px 16px;border:0;white-space:pre;min-width:100%}",
      ".dce-paint{pointer-events:none;color:var(--dsw-alias-label-primary)}",
      ".dce-input{position:absolute;top:0;left:0;overflow:hidden;resize:none;color:transparent;caret-color:var(--dsw-alias-label-primary);background:transparent;outline:none}",
      ".dce-input::selection{background:rgba(60,110,220,.28)}",
      ".dce-k{color:#9b2393}.dce-s{color:#c41a16}.dce-c{color:#007400}.dce-n{color:#1c00cf}.dce-f{color:#326d74}",
      "body[data-ds-dark-theme] .dce-k{color:#fc5fa3}body[data-ds-dark-theme] .dce-s{color:#fc6a5d}body[data-ds-dark-theme] .dce-c{color:#8b9bab}body[data-ds-dark-theme] .dce-n{color:#d0bf69}body[data-ds-dark-theme] .dce-f{color:#67b7a4}",
      ".dce-blank{flex:auto;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:24px;text-align:center}",
      ".dce-imgscroll{flex:auto;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:24px;background:var(--dsw-alias-bg-base,#fff)}",
      ".dce-img{max-width:100%;height:auto;display:block}",
      // Markdown preview. Same surface and text colour as the editor so the
      // toggle does not look like a change of context.
      ".dce-mdscroll{flex:auto;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base,#fff)}",
      ".dce-md{max-width:820px;margin:0 auto;padding:16px 24px 48px;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.75;word-break:break-word}",
      ".dce-md-h{margin:1.2em 0 .5em;font-weight:600;line-height:1.35}",
      ".dce-md h1{font-size:1.6em;padding-bottom:.25em;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-md h2{font-size:1.35em}.dce-md h3{font-size:1.16em}.dce-md h4,.dce-md h5,.dce-md h6{font-size:1em}",
      ".dce-md-p{margin:.6em 0}",
      ".dce-md-a{color:var(--dsw-alias-link,#3d6fd9);text-decoration:none}",
      ".dce-md-a:hover{text-decoration:underline}",
      ".dce-md-ic{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#eef1f5);font-family:var(--dsh-font-family-code,ui-monospace),monospace;font-size:.92em}",
      ".dce-md-pre{margin:.7em 0;padding:10px 12px;border-radius:8px;overflow:auto;background:var(--dsw-alias-bg-layer-2,#eef1f5);font-family:var(--dsh-font-family-code,ui-monospace),ui-monospace,Menlo,monospace;font-size:calc(var(--dsh-code-font-size,12px) - 1px);line-height:1.5;white-space:pre}",
      ".dce-md-code{margin:.7em 0}",
      ".dce-md-codebar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 6px 3px 12px;border-radius:8px 8px 0 0;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#eef1f5));border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-md-codelang{font-family:var(--dsh-font-family-code,ui-monospace),ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:lowercase;user-select:none}",
      ".dce-md-codelang:empty{display:none}",
      ".dce-md-copy{flex:none;padding:1px 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer;opacity:.55}",
      ".dce-md-code:hover .dce-md-copy,.dce-md-copy:focus-visible{opacity:1}",
      ".dce-md-copy:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary)}",
      ".dce-md-copy[data-copied=\"true\"]{opacity:1;color:var(--dsw-alias-label-primary)}",
      ".dce-md-code>.dce-md-pre{margin:0;border-radius:0 0 8px 8px}",
      ".dce-md-list{margin:.5em 0;padding-left:1.5em}",
      ".dce-md-list li{margin:.15em 0}",
      ".dce-md-quote{margin:.7em 0;padding:.1em 0 .1em 12px;border-left:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}",
      ".dce-md-table{margin:.8em 0;border-collapse:collapse;display:block;overflow:auto;font-size:.96em}",
      ".dce-md-table th,.dce-md-table td{border:.5px solid var(--dsw-alias-border-l3);padding:5px 10px}",
      ".dce-md-table th{background:var(--dsw-alias-bg-layer-2,#eef1f5);font-weight:600}",
      ".dce-md-hr{margin:1.1em 0;border:0;border-top:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-md-img{max-width:100%;border-radius:6px}",
      ".dce-md-img:not([src]){display:none}",
      ".dce-md-imgref,.dce-md-ref{color:var(--dsw-alias-label-tertiary)}",
      ".dce-md-check{margin-right:6px;color:var(--dsw-alias-label-secondary)}",
      ".dce-md-fm{margin:0 0 14px;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#eef1f5);font-size:12px;line-height:1.6}",
      ".dce-md-fmrow{display:flex;gap:8px}",
      ".dce-md-fmkey{flex:none;min-width:88px;color:var(--dsw-alias-label-tertiary)}",
      ".dce-md-fmval{min-width:0;overflow-wrap:anywhere}",
      ".dce-status{flex:none;height:26px;display:flex;align-items:center;gap:12px;padding:0 10px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".dce-status button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0}",
      // Git lives in the dock below, so its toggle sits here instead of as a
      // workspace tab in the strip at the top.
      ".dce-status .dce-modebtn{flex:none;height:18px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:600;line-height:18px;cursor:pointer}",
      ".dce-status .dce-modebtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-status .dce-keysbtn{flex:none;width:18px;height:18px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}",
      ".dce-status .dce-keysbtn svg{width:12px;height:12px;display:block}",
      ".dce-status .dce-keysbtn:hover,.dce-status .dce-keysbtn[data-on=\"true\"]{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-keys{position:fixed;z-index:80;width:min(360px,calc(100vw - 16px));max-height:min(420px,calc(100vh - 24px));display:flex;flex-direction:column;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden}",
      ".dce-keyshead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".dce-keyshead strong{flex:none;font-size:13px;font-weight:600}",
      ".dce-keyshead input{flex:auto;min-width:0;height:24px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:0 8px;outline:none}",
      ".dce-keyshint{flex:none;margin:0;padding:6px 12px 2px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}",
      ".dce-keyslist{flex:auto;min-height:0;overflow:auto;padding:2px 0 8px}",
      ".dce-keysgroup{padding:8px 12px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}",
      ".dce-keysrow{display:flex;align-items:center;gap:6px;min-height:28px;padding:2px 8px 2px 12px}",
      ".dce-keysrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-keysname{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;padding:0}",
      ".dce-keysbind{flex:none;max-width:140px;height:22px;padding:0 8px;border:0;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#eef1f5);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dce-keysbind[data-on=\"true\"]{color:var(--dsw-alias-label-primary);outline:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.28))}",
      ".dce-keysmini{flex:none;height:22px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}",
      ".dce-keysmini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dce-keysnote{flex:none;margin:0;padding:0 12px 8px;font-size:11px;color:#c41a16}",
      ".dce-keysempty{margin:0;padding:16px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".dce-gitbtn{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".dce-gitbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary)}",
      ".dce-gitbtn[data-on=\"true\"]{color:var(--dsw-alias-link,#3d6fd9);font-weight:600}",
      ".dce-gap{flex:auto}",
      ".dce-err{color:#c41a16}",
      ".dce-popup{position:fixed;z-index:90;min-width:240px;max-width:440px;max-height:240px;overflow:auto;padding:4px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 8px 24px rgba(0,0,0,.16)}",
      ".dce-popitem{display:flex;width:100%;gap:8px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;padding:5px 8px;border-radius:6px;cursor:pointer}",
      ".dce-popitem:hover,.dce-popitem.dce-on{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dce-popkind{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".dce-poptext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ].join("");

    /* @highlight-start */
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));
}

function wordSet(text) {
  return new Set(text.split(" "));
}

const JS_KW = wordSet("async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield");
const PY_KW = wordSet("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield");
const GO_KW = wordSet("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const JAVA_KW = wordSet("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while");
const C_KW = wordSet("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while");
const RS_KW = wordSet("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while");
const SH_KW = wordSet("if then else elif fi for while do done case esac function in");
const SQL_KW = wordSet("select from where and or insert into values update set delete create table drop alter join left right inner outer on group by order limit offset as null not is in like between distinct union all having primary key");
const JSON_KW = wordSet("true false null");

const SPECS = {
  js: { line: "//", block: ["/*", "*/"], quotes: ["'", "\"", "`"], keywords: JS_KW },
  c: { line: "//", block: ["/*", "*/"], quotes: ["'", "\""], keywords: C_KW },
  java: { line: "//", block: ["/*", "*/"], quotes: ["\""], keywords: JAVA_KW },
  go: { line: "//", block: ["/*", "*/"], quotes: ["\"", "`"], keywords: GO_KW },
  rs: { line: "//", block: ["/*", "*/"], quotes: ["\""], keywords: RS_KW },
  py: { line: "#", quotes: ["'", "\""], keywords: PY_KW, triples: true },
  sh: { line: "#", quotes: ["'", "\""], keywords: SH_KW },
  yml: { line: "#", quotes: ["'", "\""], keywords: null },
  css: { block: ["/*", "*/"], quotes: ["'", "\""], keywords: null },
  sql: { line: "--", block: ["/*", "*/"], quotes: ["'"], keywords: SQL_KW },
  json: { quotes: ["\""], keywords: JSON_KW },
  html: { kind: "html" },
  md: { kind: "md" },
  plain: { kind: "plain" }
};

const EXT = {
  js: ["js", "JavaScript"], jsx: ["js", "JSX"], mjs: ["js", "JavaScript"], cjs: ["js", "JavaScript"],
  ts: ["js", "TypeScript"], tsx: ["js", "TSX"], mts: ["js", "TypeScript"], cts: ["js", "TypeScript"],
  json: ["json", "JSON"], md: ["md", "Markdown"], markdown: ["md", "Markdown"],
  py: ["py", "Python"], go: ["go", "Go"], rs: ["rs", "Rust"],
  java: ["java", "Java"], kt: ["java", "Kotlin"], kts: ["java", "Kotlin"],
  c: ["c", "C"], h: ["c", "C"], cc: ["c", "C++"], cpp: ["c", "C++"], hpp: ["c", "C++"],
  cs: ["c", "C#"], swift: ["c", "Swift"],
  css: ["css", "CSS"], scss: ["css", "SCSS"],
  html: ["html", "HTML"], htm: ["html", "HTML"], xml: ["html", "XML"], svg: ["html", "SVG"],
  sql: ["sql", "SQL"], sh: ["sh", "Shell"], bash: ["sh", "Shell"], zsh: ["sh", "Shell"],
  yml: ["yml", "YAML"], yaml: ["yml", "YAML"], toml: ["yml", "TOML"], rb: ["py", "Ruby"]
};

const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon"
};
function imageMimeOf(rel) {
  const base = String(rel || "").toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return IMAGE_MIME[base.slice(dot + 1)] || "";
}

/** Workspace-relative path of an image linked from a Markdown file, or "". */
function joinMdRel(docRel, src) {
  let clean = String(src || "").replace(/\\/g, "/");
  const hash = clean.search(/[?#]/);
  if (hash >= 0) clean = clean.slice(0, hash);
  if (clean === "" || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.indexOf("\0") >= 0) return "";
  const slash = String(docRel || "").lastIndexOf("/");
  const dir = slash < 0 ? "" : String(docRel).slice(0, slash);
  const parts = (dir === "" ? [] : dir.split("/")).concat(clean.split("/"));
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return "";
      out.pop();
      continue;
    }
    out.push(part);
  }
  const rel = out.join("/");
  return imageMimeOf(rel) === "" ? "" : rel;
}

function languageOf(name) {
  const base = String(name || "").toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot < 0 ? "" : base.slice(dot + 1);
  const hit = EXT[ext];
  if (hit) return { id: hit[0], label: hit[1] };
  return { id: "plain", label: "Plain Text" };
}

function span(cls, text) {
  const esc = escapeHtml(text);
  if (!cls || text === "") return esc;
  return '<span class="' + cls + '">' + esc + "</span>";
}

function scanString(line, from, quote) {
  let i = from;
  while (i < line.length) {
    if (line.startsWith(quote, i)) {
      if (countSlash(line, i) % 2 === 1) { i += 1; continue; }
      return i + quote.length;
    }
    i += 1;
  }
  return -1;
}

function paintLine(line, spec, state, quote) {
  let i = 0;
  let html = "";
  let at = 0;
  const flush = (cls, to) => { html += span(cls, line.slice(at, to)); at = to; };
  if (state === "block") {
    const end = spec.block ? line.indexOf(spec.block[1]) : -1;
    if (end < 0) return { html: span("dce-c", line), state: "block", quote: "" };
    flush("dce-c", end + spec.block[1].length);
    i = at;
    state = "code";
  } else if (state === "str") {
    const closed = scanString(line, 0, quote);
    if (closed < 0) return { html: span("dce-s", line), state: "str", quote };
    flush("dce-s", closed);
    i = at;
    state = "code";
    quote = "";
  }
  while (i < line.length) {
    if (spec.line && line.startsWith(spec.line, i)) {
      flush(null, i);
      flush("dce-c", line.length);
      return { html, state: "code", quote: "" };
    }
    if (spec.block && line.startsWith(spec.block[0], i)) {
      flush(null, i);
      const end = line.indexOf(spec.block[1], i + spec.block[0].length);
      if (end < 0) {
        flush("dce-c", line.length);
        return { html, state: "block", quote: "" };
      }
      flush("dce-c", end + spec.block[1].length);
      i = at;
      continue;
    }
    const q = quoteAt(line, i, spec);
    if (q !== "") {
      flush(null, i);
      const closed = scanString(line, i + q.length, q);
      if (closed < 0) {
        flush("dce-s", line.length);
        return { html, state: "str", quote: q };
      }
      flush("dce-s", closed);
      i = at;
      continue;
    }
    const ch = line[i];
    if ((ch >= "0" && ch <= "9") || (ch === "." && line[i + 1] >= "0" && line[i + 1] <= "9")) {
      let j = i + 1;
      // Hex letters continue a number only behind a 0x prefix; without that
      // gate "1abc" paints as one number.
      let digits = /[0-9._]/;
      if (ch === "0") {
        const mark = line[j];
        if (mark === "x" || mark === "X") { digits = /[0-9a-fA-F._]/; j += 1; }
        else if (mark === "b" || mark === "B" || mark === "o" || mark === "O") j += 1;
      }
      while (j < line.length && digits.test(line[j])) j += 1;
      flush(null, i);
      flush("dce-n", j);
      i = at;
      continue;
    }
    if (isWord(ch)) {
      let j = i + 1;
      while (j < line.length && isWord(line[j])) j += 1;
      flush(null, i);
      flush(spec.keywords && spec.keywords.has(line.slice(i, j)) ? "dce-k" : null, j);
      i = at;
      continue;
    }
    i += 1;
  }
  flush(null, line.length);
  return { html, state: "code", quote: "" };
}

function countSlash(line, i) {
  let n = 0;
  let k = i - 1;
  while (k >= 0 && line[k] === "\\") { n += 1; k -= 1; }
  return n;
}

function quoteAt(line, i, spec) {
  if (!spec.quotes) return "";
  if (spec.triples) {
    if (line.startsWith('"""', i)) return '"""';
    if (line.startsWith("'''", i)) return "'''";
  }
  const ch = line[i];
  if (spec.quotes.indexOf(ch) < 0) return "";
  if (countSlash(line, i) % 2 === 1) return "";
  return ch;
}

function isWord(ch) {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$";
}

function paintHtml(text) {
  const lines = String(text).split("\n");
  let comment = false;
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    let html = "";
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) { out.push(span("dce-c", line)); continue; }
      html += span("dce-c", line.slice(0, end + 3));
      line = line.slice(end + 3);
      comment = false;
    }
    let i = 0;
    while (i < line.length) {
      const open = line.indexOf("<!--", i);
      const tag = line.indexOf("<", i);
      if (open >= 0 && (tag < 0 || open <= tag)) {
        html += escapeHtml(line.slice(i, open));
        const end = line.indexOf("-->", open + 4);
        if (end < 0) { html += span("dce-c", line.slice(open)); comment = true; i = line.length; break; }
        html += span("dce-c", line.slice(open, end + 3));
        i = end + 3;
        continue;
      }
      if (tag < 0) { html += escapeHtml(line.slice(i)); break; }
      html += escapeHtml(line.slice(i, tag));
      const close = line.indexOf(">", tag + 1);
      if (close < 0) { html += span("dce-f", line.slice(tag)); i = line.length; break; }
      html += span("dce-f", line.slice(tag, close + 1));
      i = close + 1;
    }
    out.push(html);
  }
  return { html: out.join("\n"), cache: null };
}

function paintMd(text) {
  const lines = String(text).split("\n");
  let fence = false;
  const out = lines.map((line) => {
    if (line.startsWith("```")) { fence = !fence; return span("dce-c", line); }
    if (fence) return span("dce-s", line);
    if (/^#{1,6}( |$)/.test(line)) return span("dce-k", line);
    return escapeHtml(line);
  });
  return { html: out.join("\n"), cache: null };
}

function paintDocument(text, lang, cache) {
  const spec = SPECS[lang] || SPECS.plain;
  if (spec.kind === "plain") return { html: escapeHtml(text), cache: null };
  if (spec.kind === "html") return paintHtml(text);
  if (spec.kind === "md") return paintMd(text);
  const lines = String(text).split("\n");
  const reuse = cache && cache.lang === lang ? cache.lines : null;
  const next = new Array(lines.length);
  const parts = new Array(lines.length);
  let state = "code";
  let quote = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = reuse ? reuse[i] : undefined;
    if (prev && prev.line === line && prev.stateIn === state && prev.quoteIn === quote) next[i] = prev;
    else {
      const painted = paintLine(line, spec, state, quote);
      next[i] = { line, html: painted.html, stateIn: state, quoteIn: quote, stateOut: painted.state, quoteOut: painted.quote };
    }
    state = next[i].stateOut;
    quote = next[i].quoteOut;
    parts[i] = next[i].html;
  }
  return { html: parts.join("\n"), cache: { lang, lines: next } };
}

/*
 * Markdown preview. Rendering is local on purpose: no dependency, no sanitizer
 * pass, no raw HTML. Every tag below is one this file writes, and all document
 * text goes through escapeHtml first, so a .md file cannot inject markup —
 * HTML written in the source shows up as text.
 */
const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)/;
const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "\"" ? "&quot;" : "&#39;");
}

function mdIndent(line) {
  let n = 0;
  while (n < line.length) {
    const ch = line.charAt(n);
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

function mdEmphasis(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  return s;
}

/** One line (or one table cell) of inline markup. */
function mdInline(raw) {
  const s = String(raw);
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf !== "") { out.push(mdEmphasis(buf)); buf = ""; } };
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === "\\" && i + 1 < s.length && "\\`*_{}[]()#+-.!>~|".indexOf(s.charAt(i + 1)) >= 0) {
      buf += s.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (s.charAt(i + run) === "`") run += 1;
      const fence = s.slice(i, i + run);
      const close = s.indexOf(fence, i + run);
      if (close < 0) { buf += fence; i += run; continue; }
      flush();
      out.push('<code class="dce-md-ic">' + escapeHtml(s.slice(i + run, close).replace(/^ (.+) $/, "$1")) + "</code>");
      i = close + run;
      continue;
    }
    if (ch === "!" && s.charAt(i + 1) === "[") {
      const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m !== null) {
        flush();
        // Remote images load directly. A workspace-relative image is filled in
        // after render from the /image route; anything else stays as alt text.
        if (MD_SAFE_URL.test(m[2])) {
          out.push('<img class="dce-md-img" src="' + escapeAttr(m[2]) + '" alt="' + escapeAttr(m[1]) + '" loading="lazy" referrerpolicy="no-referrer">');
        } else if (imageMimeOf(m[2].split(/[?#]/)[0]) !== "") {
          out.push('<img class="dce-md-img" alt="' + escapeAttr(m[1]) + '" data-dce-img="' + escapeAttr(m[2]) + '">');
        } else {
          out.push('<span class="dce-md-imgref">' + escapeHtml(m[1] !== "" ? m[1] : m[2]) + "</span>");
        }
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m !== null) {
        flush();
        if (MD_SAFE_URL.test(m[2])) {
          out.push('<a class="dce-md-a" href="' + escapeAttr(m[2]) + '" target="_blank" rel="noreferrer noopener">' + mdInline(m[1]) + "</a>");
        } else {
          out.push('<span class="dce-md-ref">' + mdInline(m[1]) + "</span>");
        }
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(s.slice(i));
      if (m !== null) {
        flush();
        out.push('<a class="dce-md-a" href="' + escapeAttr(m[1]) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(m[1]) + "</a>");
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out.join("");
}

function mdCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed.charAt(i);
    if (ch === "\\" && trimmed.charAt(i + 1) === "|") { buf += "|"; i += 1; continue; }
    if (ch === "|") { cells.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function mdTable(lines, start) {
  const rule = lines[start + 1];
  if (rule === undefined || rule.indexOf("|") < 0 || !/^[\s:|-]*-[\s:|-]*$/.test(rule)) return null;
  const head = mdCells(lines[start]);
  const spec = mdCells(rule).map((cell) => {
    const left = cell.charAt(0) === ":";
    const right = cell.charAt(cell.length - 1) === ":";
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].indexOf("|") >= 0) {
    rows.push(mdCells(lines[i]));
    i += 1;
  }
  const cell = (tag, text, at) => {
    const align = spec[at] || "";
    return "<" + tag + (align === "" ? "" : ' style="text-align:' + align + '"') + ">" + mdInline(text) + "</" + tag + ">";
  };
  const body = rows.length === 0 ? "" : "<tbody>" + rows.map((row) => "<tr>" + row.map((text, at) => cell("td", text, at)).join("") + "</tr>").join("") + "</tbody>";
  return {
    html: '<table class="dce-md-table"><thead><tr>' + head.map((text, at) => cell("th", text, at)).join("") + "</tr></thead>" + body + "</table>",
    next: i
  };
}

/** A list at `start`, including its indented continuations. */
function mdList(lines, start, copyLabel) {
  const first = MD_ITEM.exec(lines[start]);
  const base = mdIndent(lines[start]);
  const ordered = /^\d/.test(first[2]);
  // A list ends where its marker kind changes: "1." after "- " is a second
  // list, not more of the first one.
  const keeps = (text) => {
    const hit = MD_ITEM.exec(text);
    return hit !== null && /^\d/.test(hit[2]) === ordered;
  };
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      let k = i + 1;
      while (k < lines.length && /^\s*$/.test(lines[k])) k += 1;
      if (k >= lines.length) { i = k; break; }
      if (mdIndent(lines[k]) <= base && keeps(lines[k]) === false) { i = k; break; }
      if (mdIndent(lines[k]) < base) { i = k; break; }
      i = k;
      continue;
    }
    const item = MD_ITEM.exec(line);
    const indent = mdIndent(line);
    if (indent < base) break;
    if (item !== null && indent <= base + 1) {
      if (indent === base && /^\d/.test(item[2]) !== ordered) break;
      items.push({ text: item[3].replace(/\s+$/, ""), rest: [] });
      i += 1;
      continue;
    }
    if (items.length === 0) break;
    // Anything indented past the marker belongs to the item above: a nested
    // list, a fenced block, a table. Dedent by its own margin and let the
    // recursive pass read it as a block of its own.
    const chunk = [];
    while (i < lines.length) {
      const inner = lines[i];
      if (/^\s*$/.test(inner)) {
        const next = lines[i + 1];
        if (next !== undefined && mdIndent(next) > base) { chunk.push(""); i += 1; continue; }
        break;
      }
      if (mdIndent(inner) <= base) break;
      chunk.push(inner);
      i += 1;
    }
    let cut = Infinity;
    chunk.forEach((inner) => { if (!/^\s*$/.test(inner)) cut = Math.min(cut, mdIndent(inner)); });
    // Nothing indented followed, so the list is over; without this the outer
    // loop would retry the same line forever.
    if (chunk.length === 0) break;
    if (!Number.isFinite(cut)) cut = 0;
    const text = chunk.map((inner) => (/^\s*$/.test(inner) ? "" : inner.slice(cut))).join("\n").replace(/^\n+|\n+$/g, "");
    if (text !== "") items[items.length - 1].rest.push(text);
  }
  const body = items.map((item) => {
    let text = item.text;
    let box = "";
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task !== null) {
      box = '<span class="dce-md-check">' + (task[1] === " " ? "☐" : "☑") + "</span>";
      text = task[2];
    }
    return "<li>" + box + mdInline(text) + item.rest.map((rest) => renderMarkdown(rest, copyLabel)).join("") + "</li>";
  }).join("");
  const tag = ordered ? "ol" : "ul";
  return { html: "<" + tag + ' class="dce-md-list">' + body + "</" + tag + ">", next: i };
}

function mdFrontmatter(lines) {
  if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return null;
  let end = -1;
  for (let i = 1; i < lines.length && i <= 200; i += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return null;
  const rows = [];
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    const at = line.indexOf(":");
    if (at <= 0 || /^\s/.test(line)) continue;
    rows.push('<div class="dce-md-fmrow"><span class="dce-md-fmkey">' + escapeHtml(line.slice(0, at).trim()) + '</span><span class="dce-md-fmval">' + escapeHtml(line.slice(at + 1).trim()) + "</span></div>");
  }
  if (rows.length === 0) return { html: "", next: end + 1 };
  return { html: '<div class="dce-md-fm">' + rows.join("") + "</div>", next: end + 1 };
}

/** Markdown source to HTML for the preview pane. */
function renderMarkdown(src, copyLabel) {
  const copyText = typeof copyLabel === "string" && copyLabel !== "" ? copyLabel : "Copy";
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const fm = mdFrontmatter(lines);
  if (fm !== null) { if (fm.html !== "") out.push(fm.html); i = fm.next; }
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i += 1; continue; }
    const fence = MD_FENCE.exec(line);
    if (fence !== null) {
      const close = new RegExp("^\\s{0,3}" + (fence[1].charAt(0) === "`" ? "`" : "~") + "{3,}\\s*$");
      const body = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      // A known fence language gets the same painter as the editor; anything
      // else stays escaped plain text inside the block.
      const name = String(fence[2] || "").toLowerCase();
      const spec = EXT[name];
      const code = spec === undefined
        ? escapeHtml(body.join("\n"))
        : paintDocument(body.join("\n"), spec[0], null).html;
      // The copy button reads the rendered <code> textContent, so the block
      // never carries a second escaped copy of the source. Highlighting only
      // wraps characters in spans, so textContent is the original code.
      out.push('<div class="dce-md-code"><div class="dce-md-codebar">'
        + '<span class="dce-md-codelang">' + escapeHtml(spec === undefined ? name : spec[1]) + "</span>"
        + '<button type="button" class="dce-md-copy" title="' + escapeHtml(copyText) + '">' + escapeHtml(copyText) + "</button>"
        + '</div><pre class="dce-md-pre"><code>' + code + "</code></pre></div>");
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      out.push("<h" + level + ' class="dce-md-h">' + mdInline(heading[2]) + "</h" + level + ">");
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr class="dce-md-hr">'); i += 1; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push('<blockquote class="dce-md-quote">' + renderMarkdown(quoted.join("\n"), copyLabel) + "</blockquote>");
      continue;
    }
    const table = mdTable(lines, i);
    if (table !== null) { out.push(table.html); i = table.next; continue; }
    if (MD_ITEM.test(line)) {
      const list = mdList(lines, i, copyLabel);
      out.push(list.html);
      i = list.next;
      continue;
    }
    const para = [];
    while (i < lines.length) {
      const current = lines[i];
      if (/^\s*$/.test(current)) break;
      if (para.length > 0 && (MD_FENCE.test(current) || MD_ITEM.test(current) || /^\s{0,3}(#{1,6})\s+/.test(current) || /^\s{0,3}>/.test(current) || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(current))) break;
      para.push(current.replace(/^ {0,3}/, "").replace(/\\$/, ""));
      i += 1;
    }
    out.push('<p class="dce-md-p">' + para.map((text) => mdInline(text)).join("<br>") + "</p>");
  }
  return out.join("");
}
/* @highlight-end */

    const positionOf = (text, offset) => {
      const cut = String(text).slice(0, offset);
      return { line: cut.split("\n").length - 1, character: offset - cut.lastIndexOf("\n") - 1 };
    };
    const offsetOf = (text, line, character) => {
      let at = 0;
      for (let n = 0; n < line; n++) {
        const nl = text.indexOf("\n", at);
        if (nl < 0) return text.length;
        at = nl + 1;
      }
      return Math.min(text.length, at + Math.max(0, character));
    };
    const held = (id, fallback, event) => {
      try {
        if (ideaKeys.has(id)) return ideaKeys.match(id, event) === true;
      } catch {}
      return chordMatches(fallback, event, []);
    };

    const readNum = (key, fallback) => {
      try {
        const n = Number(window.localStorage.getItem(key));
        return Number.isFinite(n) ? n : fallback;
      } catch { return fallback; }
    };
    const readMdView = () => {
      try { return window.localStorage.getItem(MD_VIEW_KEY) === "edit" ? "edit" : "preview"; } catch { return "preview"; }
    };

    /**
     * The right column's view (files / editor / database / git) belongs to the
     * Session the column is drawing, not to the page. One singleton still owns
     * the bus — whichever plugin mounts first publishes it — but every mode and
     * pause it holds is keyed by that Session, so switching Sessions repaints
     * with the arriving Session's own view instead of inheriting the one the
     * user left. The owner injects how to read the on-screen Session through
     * `bindSession` and calls `refresh` when the Session changes.
     */
    function apply(ctx) {
      const slots = ctx.get("slots") || ctx.slots;
      if (slots === undefined) return;
      const service = (serviceName) => { try { return ctx.get(serviceName); } catch { return undefined; } };
      const langOf = () => {
        try {
          const loc = service("locale");
          const snap = loc && loc.getSnapshot ? loc.getSnapshot() : undefined;
          const id = snap && (snap.id || snap.locale || snap.language);
          // A resolved locale wins outright. Falling through on anything that was
          // not `en` sent a "zh-CN" page to `navigator.language`, so an English
          // browser rendered this plugin in English next to a Chinese database
          // page — two tabs, two languages.
          if (typeof id === "string" && id.indexOf("zh") === 0) return "zh";
          if (typeof id === "string" && id.indexOf("en") === 0) return "en";
        } catch {}
        try { if (String(window.navigator.language || "").indexOf("zh") === 0) return "zh"; } catch {}
        return "zh";
      };
      let lang = langOf();
      const langListeners = new Set();
      const setLang = (next) => {
        if (next === lang) return;
        lang = next;
        for (const fn of langListeners) { try { fn(); } catch {} }
      };
      const loc = service("locale");
      if (loc && typeof loc.subscribe === "function") ctx.effect(() => loc.subscribe(() => setLang(langOf())));
      const t = (key) => (I18N[lang] || I18N.zh)[key] ?? I18N.en[key] ?? key;

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
          const msg = data && data.message ? String(data.message) : (data && data.error ? String(data.error) : "HTTP " + response.status);
          throw new Error(msg);
        }
        return data;
      };
      const currentSession = () => {
        let id;
        try {
          const ui = service("uiSession");
          const source = ui && ui.adapter ? ui.adapter.current : undefined;
          const key = source && source.getSnapshot ? source.getSnapshot()?.key : undefined;
          if (key !== undefined && key !== null && key !== "") id = key;
        } catch {}
        const sessions = service("sessions");
        const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : undefined;
        if (id === undefined && snap && snap.byId) {
          const rows = Object.values(snap.byId);
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row && row.retainedBy && row.retainedBy.mainView > 0) { id = row.id; break; }
          }
        }
        if (id === undefined || id === null || !snap || !snap.byId) return null;
        const entry = snap.byId[id];
        const cwd = entry && typeof entry.cwd === "string" ? entry.cwd : "";
        return { id, cwd };
      };
      const sidebarOf = () => service("sidebarRight");
      const columnSeat = () => {
        const sidebar = sidebarOf();
        if (!sidebar || sidebar.mounted === undefined || typeof sidebar.mounted.getSnapshot !== "function") return undefined;
        let sessionId;
        try { sessionId = sidebar.mounted.getSnapshot(); } catch { return undefined; }
        if (sessionId === undefined || sessionId === null) return undefined;
        let store;
        try {
          store = sidebar.adopted && typeof sidebar.adopted.get === "function" ? sidebar.adopted.get(sessionId).store : undefined;
        } catch { return undefined; }
        if (!store || !store.actions) return undefined;
        return { sessionId, actions: store.actions, store };
      };
      const showColumnFullscreen = () => {
        const seat = columnSeat();
        if (seat === undefined) return;
        try { if (typeof seat.actions.setExpanded === "function") seat.actions.setExpanded(seat.sessionId, true); } catch {}
        try { if (typeof seat.actions.setMode === "function") seat.actions.setMode(seat.sessionId, "fullscreen"); } catch {}
      };
      const storedColumnFullscreen = () => {
        const seat = columnSeat();
        if (seat === undefined || typeof seat.store.getSnapshot !== "function") return false;
        try { return seat.store.getSnapshot().bySession[seat.sessionId].layout.mode === "fullscreen"; } catch { return false; }
      };
      // User preference shared with dsh-database: fullscreen pins the column
      // over the conversation, push keeps the chat beside it. Push also writes
      // the mode explicitly, so a fullscreen left behind by Git or the chrome
      // button drops back to the ordinary width on this open.
      const openMode = () => {
        try { return window.localStorage.getItem(OPEN_MODE_KEY) === "push" ? "push" : "fullscreen"; } catch { return "fullscreen"; }
      };
      const showColumnOpen = () => {
        if (openMode() !== "push") { showColumnFullscreen(); return; }
        const seat = columnSeat();
        if (seat === undefined) return;
        try { if (typeof seat.actions.setMode === "function") seat.actions.setMode(seat.sessionId, "push"); } catch {}
        try { if (typeof seat.actions.setExpanded === "function") seat.actions.setExpanded(seat.sessionId, true); } catch {}
      };
      // The editor is a tab of the host's column now. Every Session keeps its
      // own, the tab strip is the entry point, and "visible" means the host's
      // active tab is this one — no second view switch to keep in step.
      const editorTabRecord = () => {
        const sidebar = sidebarOf();
        if (!sidebar || typeof sidebar.active !== "function") return undefined;
        try {
          const record = sidebar.active();
          return record !== undefined && record !== null && record.kind === EDITOR_KIND ? record : undefined;
        } catch { return undefined; }
      };
      const editorVisible = () => editorTabRecord() !== undefined;
      const openEditorPanel = () => {
        const sidebar = sidebarOf();
        if (!sidebar || typeof sidebar.openTab !== "function") return false;
        try { sidebar.openTab(EDITOR_KIND); } catch { return false; }
        showColumnOpen();
        return true;
      };
      /**
       * Bring the page up for content that picked itself: a file from search, a
       * diff from Git, the Git dock, a line reference from the conversation.
       *
       * This never touches the shape of the column. `openTab` expands a collapsed
       * one on its own, and the host already keeps the user's presentation
       * (fullscreen / split, and the splitter width). Inferring "is this a fresh
       * open?" from `isExpanded()` was wrong — that flag tracks `layout.expanded`,
       * which is not what fullscreen sets — so a heuristic here silently dropped
       * an expanded fullscreen column back to the split width. The explicit opens
       * (⌘1 / ⌘2) are the ones that apply the preference.
       */
      const revealEditorTab = () => {
        const sidebar = sidebarOf();
        if (!sidebar || typeof sidebar.openTab !== "function") return false;
        let wasFullscreen = false;
        try { wasFullscreen = storedColumnFullscreen(); } catch {}
        try { sidebar.openTab(EDITOR_KIND); } catch { return false; }
        // `openTab` owns expansion, and a tab it has to mint can come back with a
        // freshly seeded layout. Put the presentation back the way the user had
        // it: opening content is not a request to resize the column.
        if (wasFullscreen && !storedColumnFullscreen()) {
          const seat = columnSeat();
          if (seat !== undefined) {
            try { if (typeof seat.actions.setMode === "function") seat.actions.setMode(seat.sessionId, "fullscreen"); } catch {}
          }
        }
        return true;
      };
      // Collapse only. The stored shape is the user's (chrome button, ⌥⌘Enter,
      // splitter); folding the column away is not a request to change it.
      const leaveEditorPanel = () => {
        const seat = columnSeat();
        if (seat !== undefined) {
          try { if (typeof seat.actions.setExpanded === "function") seat.actions.setExpanded(seat.sessionId, false); } catch {}
        }
      };
      const toggleEditorPanel = () => {
        // Fullscreen mode: already fullscreen leaves; open but not fullscreen
        // is not "open" — the next press fullscreens it. Push mode: an expanded
        // column on this page is "open", so the next press collapses. The tab
        // stays either way, which is why the check is on expansion, not on the
        // tab's existence.
        const sidebar = sidebarOf();
        const expanded = sidebar !== undefined && sidebar !== null
          && typeof sidebar.isExpanded === "function" && sidebar.isExpanded() === true;
        if (editorVisible() && expanded && (openMode() === "push" || storedColumnFullscreen())) { leaveEditorPanel(); return false; }
        openEditorPanel();
        return true;
      };
      // Close the page outright, leaving the column to whatever sits beside it.
      const closeEditorPanel = () => {
        const record = editorTabRecord();
        const sidebar = sidebarOf();
        if (record === undefined || !sidebar || typeof sidebar.close !== "function") return false;
        try { sidebar.close(record.id); } catch { return false; }
        return true;
      };
      let queuedRel = "";
      let queuedDiff = null;
      let pendingSeek = null;
      const openEditorFile = (rel, line) => {
        if (typeof rel !== "string" || rel === "") return;
        pendingSeek = typeof line === "number" && line > 0 ? { line: line - 1, character: 0, rel } : null;
        queuedRel = rel;
        revealEditorTab();
        // The body may be between mounts here (a closed tab, a fresh Session), so
        // the call is best-effort: `queuedRel` above is what actually lands it.
        try { if (typeof docApi.openRel === "function") docApi.openRel(rel); } catch {}
      };
      /**
       * Show a diff handed over by the Git panel.
       *
       * The panel keeps its own dock at the bottom of this column, so the diff
       * lands here — in the editor area — instead of inside the change list.
       * `queuedDiff` covers the one call that can arrive before this overlay
       * has ever mounted.
       */
      const openEditorDiff = (meta) => {
        if (meta === null || typeof meta !== "object") return;
        if (!editorVisible()) revealEditorTab();
        try {
          if (typeof docApi.openDiff === "function") docApi.openDiff(meta);
          else queuedDiff = meta;
        } catch { queuedDiff = meta; }
      };
      window.__dshEditorPanel = {
        toggle: toggleEditorPanel,
        open: openEditorPanel,
        reveal: revealEditorTab,
        close: closeEditorPanel,
        isOpen: () => editorVisible(),
        openFile: openEditorFile,
        openDiff: openEditorDiff,
        activeDiff: () => (typeof docApi.activeDiff === "function" ? docApi.activeDiff() : null),
        diffLine: () => (typeof docApi.diffLine === "function" ? docApi.diffLine() : 0),
        gitDock: () => (typeof docApi.gitDock === "function" ? docApi.gitDock() : null),
        // @-mention flow: after the mention lands the user keeps typing in
        // the chat. In fullscreen the editor still covers the conversation,
        // so step out; in split mode the chat is already visible next to the
        // editor — leave the editor open.
        backToChat: () => { if (storedColumnFullscreen()) leaveEditorPanel(); }
      };
      try { window.dispatchEvent(new CustomEvent("dsh-editor-ready")); } catch {}

      // ── the host's tab system ──────────────────────────────────────────────
      // The page is a tab now, so the type only describes itself; the body
      // renders every tab of this kind, in every pane and every Session, with
      // the layout the host already keeps per Session.
      const editorDefinition = () => ({
        id: PLUGIN,
        kind: EDITOR_KIND,
        priority: "extension",
        title: () => t("editor"),
      });
      let registered = false;
      const registerType = () => {
        let tabs;
        try { tabs = ctx.get("sidebarRightTabs") || ctx.sidebarRightTabs; } catch { tabs = undefined; }
        if (registered || !tabs || typeof tabs.register !== "function") return false;
        registered = true;
        ctx.effect(() => tabs.register(editorDefinition()), "dsh-idea: editor type");
        ctx.effect(() => slots.inject("sidebar.right.pane.tab", () => slots.register({
          name: "sidebar.right.pane.tab",
          key: PLUGIN,
        }, EditorApp)), "dsh-idea: editor body");
        ctx.effect(() => slots.inject("sidebar.right.pane.tab.title", () => slots.register({
          name: "sidebar.right.pane.tab.title",
          key: PLUGIN,
        }, EditorTitle)), "dsh-idea: editor title");
        return true;
      };
      if (!registerType()) {
        const timer = window.setInterval(() => { if (registerType()) window.clearInterval(timer); }, 250);
        ctx.effect(() => () => window.clearInterval(timer));
      }

      let sawToggleDown = false;
      const onToggleKeyDown = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229 || event.repeat === true) return;
        if (!toggleHeld(event)) return;
        sawToggleDown = true;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        toggleEditorPanel();
      };
      const onToggleKeyUp = (event) => {
        if (!toggleHeld(event)) return;
        if (sawToggleDown) { sawToggleDown = false; return; }
        toggleEditorPanel();
      };
      window.addEventListener("keydown", onToggleKeyDown, true);
      window.addEventListener("keyup", onToggleKeyUp, true);
      ctx.effect(() => () => {
        window.removeEventListener("keydown", onToggleKeyDown, true);
        window.removeEventListener("keyup", onToggleKeyUp, true);
      });


      // The column's fullscreen chord (⌥⌘Enter) is `pane.fullscreen.toggle` in
      // the host, and the host only resolves it when focus sits inside a
      // `[data-dockkit-pane]`. The editor keeps focus in its own DOM, so the
      // chord never reached the host from here and the editor could not go
      // fullscreen from the keyboard. The database workspace solves this the
      // same way: hand focus to the pane, re-dispatch the chord, put the caret
      // back. Scope is deliberate — only while this workspace is the one on
      // screen, so the database panel keeps the chord for itself when it is
      // visible.
      const forwardFullscreenChord = () => {
        const pane = document.querySelector("[data-sidebar-right-panel] [data-dockkit-pane]");
        if (pane === null) return false;
        const active = document.activeElement;
        if (pane === active) return false;
        try {
          if (pane.getAttribute("tabindex") === null) pane.setAttribute("tabindex", "-1");
          pane.focus({ preventScroll: true });
        } catch { return false; }
        try {
          pane.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            metaKey: IS_MAC,
            ctrlKey: !IS_MAC,
            altKey: true,
            bubbles: true,
            cancelable: true,
            composed: true
          }));
        } catch { return false; }
        if (active !== null && active !== undefined && typeof active.focus === "function") {
          window.setTimeout(() => { try { active.focus({ preventScroll: true }); } catch {} }, 0);
        }
        return true;
      };
      // The host's active tab IS the page on screen; a collapsed column still has
      // one, which is exactly the case the chord must keep working in.
      const editorOnScreen = () => editorVisible();
      const onFullscreenKeyDown = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (!enterAliasHeld(event)) return;
        // Which workspace is on screen decides who owns the chord. The editor
        // keeps it without asking where focus is: the preview pane is not
        // focusable, so requiring focus inside would leave the chord dead for
        // every rendered Markdown tab. When the database is the visible
        // workspace this returns early and that plugin's own handler runs.
        if (!editorOnScreen()) return;
        if (!forwardFullscreenChord()) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      };
      window.addEventListener("keydown", onFullscreenKeyDown, true);
      ctx.effect(() => () => window.removeEventListener("keydown", onFullscreenKeyDown, true));
      const docApi = { closeDoc: () => {}, save: () => {}, find: () => {} };

      function useLang() {
        const [, bump] = React.useState(0);
        React.useEffect(() => {
          const fn = () => bump((n) => n + 1);
          langListeners.add(fn);
          return () => langListeners.delete(fn);
        }, []);
        // The current locale, so callers can rebuild strings that are baked
        // into HTML (the Markdown preview) when the user switches language.
        return lang;
      }

      function EditorTitle({ useTabInfo }) {
        const info = typeof useTabInfo === "function" ? useTabInfo() : undefined;
        const title = info && info.tab && info.tab.title ? info.tab.title : t("editor");
        return h(React.Fragment, null,
          h("span", { className: "dce-tabico" }, h(EditorGlyph)),
          title);
      }

      function EditorApp() {
        const uiLang = useLang();
        // The open preference (fullscreen vs split) used to live in the strip.
        // The strip is the host's now, so the switch moved to the status bar.
        const [openModeState, setOpenModeState] = React.useState(openMode());
        React.useEffect(() => {
          const sync = (event) => {
            const detail = event && event.detail;
            setOpenModeState(detail === "push" || detail === "fullscreen" ? detail : openMode());
          };
          const onStorage = (event) => {
            if (event.key && event.key !== OPEN_MODE_KEY) return;
            setOpenModeState(openMode());
          };
          window.addEventListener("dsh-open-mode", sync);
          window.addEventListener("storage", onStorage);
          return () => {
            window.removeEventListener("dsh-open-mode", sync);
            window.removeEventListener("storage", onStorage);
          };
        }, []);
        const [keysOpen, setKeysOpen] = React.useState(false);
        const [keysTick, setKeysTick] = React.useState(0);
        const [recordingId, setRecordingId] = React.useState(null);
        const [keysQuery, setKeysQuery] = React.useState("");
        const [keysNote, setKeysNote] = React.useState("");
        const keysBtnRef = React.useRef(null);
        const keysPanelRef = React.useRef(null);
        React.useEffect(() => {
          const api = shortcutApi();
          if (api === null || typeof api.subscribe !== "function") return undefined;
          return api.subscribe(() => setKeysTick((n) => n + 1));
        }, []);
        React.useEffect(() => {
          window.__dshShortcutCapture = recordingId !== null;
          if (recordingId === null) return undefined;
          const onKey = (event) => {
            if (event.isComposing === true || event.keyCode === 229) return;
            if (isModifierCode(event.code)) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            if (event.code === "Escape") { setRecordingId(null); setKeysNote(""); return; }
            const refused = recordableShortcut(event);
            if (refused !== "") {
              setKeysNote(t(refused === "bare" ? "keysBare" : "keysReserved"));
              return;
            }
            const api = shortcutApi();
            if (api !== null) {
              api.set(recordingId, {
                ctrl: event.ctrlKey === true,
                alt: event.altKey === true,
                shift: event.shiftKey === true,
                meta: event.metaKey === true,
                code: event.code
              });
            }
            setRecordingId(null);
            setKeysNote("");
          };
          window.addEventListener("keydown", onKey, true);
          return () => {
            window.__dshShortcutCapture = false;
            window.removeEventListener("keydown", onKey, true);
          };
        }, [recordingId]);
        React.useEffect(() => {
          if (!keysOpen) return undefined;
          const onPointer = (event) => {
            const panel = keysPanelRef.current;
            const btn = keysBtnRef.current;
            if (panel !== null && panel.contains(event.target)) return;
            if (btn !== null && btn.contains(event.target)) return;
            setKeysOpen(false);
            setRecordingId(null);
            setKeysNote("");
          };
          const onKey = (event) => {
            if (event.key !== "Escape" || recordingId !== null) return;
            setKeysOpen(false);
          };
          document.addEventListener("pointerdown", onPointer, true);
          window.addEventListener("keydown", onKey);
          return () => {
            document.removeEventListener("pointerdown", onPointer, true);
            window.removeEventListener("keydown", onKey);
          };
        }, [keysOpen, recordingId]);
        const [cwd, setCwd] = React.useState("");
        const [nodes, setNodes] = React.useState({});
        const [expanded, setExpanded] = React.useState({ "": true });
        const [treeW, setTreeW] = React.useState(() => Math.min(480, Math.max(160, readNum(TREE_W_KEY, 220))));
        // Hidden tree persists across reloads; "0"/absent means shown.
        const [treeOpen, setTreeOpen] = React.useState(() => {
          try { return window.localStorage.getItem(TREE_CLOSED_KEY) !== "1"; } catch { return true; }
        });
        const setTreeVisible = (open) => {
          setTreeOpen(open);
          try { window.localStorage.setItem(TREE_CLOSED_KEY, open ? "0" : "1"); } catch {}
        };
        const [gitH, setGitH] = React.useState(() => Math.min(900, Math.max(120, readNum(GIT_H_KEY, 300))));
        const [tabs, setTabs] = React.useState([]);
        // Diff tabs are file-shaped tabs whose content is a unified diff handed
        // over by the Git panel. `active` holds either a file rel or a diff
        // key, so both kinds share one strip and one "which tab is on screen".
        const [diffs, setDiffs] = React.useState([]);
        const [active, setActive] = React.useState("");
        const [menu, setMenu] = React.useState(null);
        const activeDiff = diffs.find((row) => row.key === active) || null;
        const doc = activeDiff === null ? (tabs.find((row) => row.rel === active && row.cwd === cwd) || null) : null;
        const [caret, setCaret] = React.useState({ line: 1, col: 1 });
        const [find, setFind] = React.useState({ open: false, query: "" });
        const [popup, setPopup] = React.useState(null);
        // Jump-target flash: { id, top, height } painted over the scroller.
        const [flash, setFlash] = React.useState(null);
        const flashSeq = React.useRef(0);
        const popupAt = React.useRef({ x: 80, y: 80 });
        const [status, setStatus] = React.useState("");
        // Status carries its own tone: "saved" is neutral, everything else is
        // an error. Comparing the translated string (as this used to do) breaks
        // the moment the wording or the language changes.
        const [statusOk, setStatusOk] = React.useState(false);
        const showStatus = (text, ok) => {
          setStatus(text);
          setStatusOk(ok === true);
        };
        // The Git dock's on/off state, so the status bar can offer the toggle
        // without the top strip growing a Git tab again.
        const [dockOn, setDockOn] = React.useState(() => document.documentElement.dataset[GIT_DOCK_ATTR] === "1");
        const [gitReady, setGitReady] = React.useState(() => window.__dshGitPanel !== undefined && window.__dshGitPanel !== null);
        React.useEffect(() => {
          const syncDock = () => setDockOn(document.documentElement.dataset[GIT_DOCK_ATTR] === "1");
          const syncGit = () => setGitReady(window.__dshGitPanel !== undefined && window.__dshGitPanel !== null);
          window.addEventListener("dsh-git-dock", syncDock);
          window.addEventListener("dsh-git-ready", syncGit);
          syncDock();
          syncGit();
          return () => {
            window.removeEventListener("dsh-git-dock", syncDock);
            window.removeEventListener("dsh-git-ready", syncGit);
          };
        }, []);
        const docRef = React.useRef(null);
        const tabsRef = React.useRef([]);
        const inputRef = React.useRef(null);
        const paintRef = React.useRef(null);
        const scrollerRef = React.useRef(null);
        const gutterRef = React.useRef(null);
        const caretRef = React.useRef(null);
        const seekRef = React.useRef(null);
        const backRef = React.useRef([]);
        const fwdRef = React.useRef([]);
        const cacheRef = React.useRef(null);
        const findRef = React.useRef(null);
        const mdScrollRef = React.useRef(null);
        const diffRef = React.useRef(null);
        const diffsRef = React.useRef([]);
        const diffScrollRef = React.useRef(null);
        const gitPaneRef = React.useRef(null);
        const activeRef = React.useRef("");
        const savingRef = React.useRef(false);
        // Generation of the last /read issued by openRel. Clicking A then B while
        // A is still in flight used to land A last, so the tab that opened was
        // whatever the network finished last rather than what was clicked.
        const openSeqRef = React.useRef(0);
        // Teardown of the window pointer listeners an active drag installed;
        // unmounting mid-drag must not leave them on window for good.
        const dragCleanupRef = React.useRef(null);
        React.useEffect(() => () => {
          if (dragCleanupRef.current !== null) dragCleanupRef.current();
        }, []);
        docRef.current = doc;
        activeRef.current = active;
        diffRef.current = activeDiff;
        diffsRef.current = diffs;

        // The Git chunk mounts its panel into `.dce-gitpane`; that element only
        // exists once this overlay has rendered, so tell it when to look again.
        React.useEffect(() => {
          try { window.dispatchEvent(new CustomEvent("dsh-editor-dock")); } catch {}
          return () => {
            try { window.dispatchEvent(new CustomEvent("dsh-editor-dock")); } catch {}
          };
        }, []);
        tabsRef.current = tabs;
        const setDoc = (next) => {
          if (typeof next === "function") {
            // Tabs are keyed by rel+cwd: two conversations can hold the same
            // rel, so matching rel alone would edit the other session's tab.
            const current = docRef.current;
            const rel = current && current.rel;
            const root = current && current.cwd;
            setTabs((prev) => prev.map((row) => {
              if (row.rel !== rel || row.cwd !== root) return row;
              const value = next(row);
              return value && value.rel === row.rel ? value : row;
            }));
            return;
          }
          if (next === null) return;
          setTabs((prev) => {
            const at = prev.findIndex((row) => row.rel === next.rel && row.cwd === next.cwd);
            if (at < 0) return prev.concat([next]);
            const copy = prev.slice();
            copy[at] = next;
            return copy;
          });
          setActive(next.rel);
        };
        const cwdRef = React.useRef("");
        cwdRef.current = cwd;

        const dirty = doc !== null && !doc.binary && (doc.text !== doc.saved || doc.eol !== doc.savedEol);
        const painted = React.useMemo(() => {
          if (doc === null || doc.binary) return "";
          const result = paintDocument(doc.text, doc.lang.id, cacheRef.current);
          cacheRef.current = result.cache;
          return result.html;
        }, [doc]);
        // Markdown opens rendered. The switch is a preference, not per-tab
        // state: a reader who prefers source keeps every .md file in source
        // until they say otherwise, and the choice survives a reload.
        const [mdView, setMdView] = React.useState(readMdView);
        const isMd = doc !== null && !doc.binary && doc.lang.id === "md";
        const mdPreview = isMd && mdView === "preview";
        const mdPreviewRef = React.useRef(false);
        mdPreviewRef.current = mdPreview;
        const mdHtml = React.useMemo(
          () => (mdPreview && doc !== null ? renderMarkdown(doc.text, t("copy")) : ""),
          [mdPreview, doc === null ? "" : doc.text, uiLang]
        );
        React.useEffect(() => {
          const host = mdScrollRef.current;
          if (!mdPreview || doc === null || host === null) return undefined;
          const imgs = host.querySelectorAll("img[data-dce-img]");
          let alive = true;
          imgs.forEach((img) => {
            const rel = joinMdRel(doc.rel, img.getAttribute("data-dce-img") || "");
            if (rel === "") return;
            post(API + "/image", { cwd: doc.cwd, rel }).then((data) => {
              if (!alive || !img.isConnected) return;
              const mime = typeof data.mime === "string" && data.mime !== "" ? data.mime : imageMimeOf(rel);
              const payload = typeof data.data === "string" ? data.data : "";
              if (payload === "") return;
              img.src = "data:" + mime + ";base64," + payload;
            }).catch(() => {});
          });
          return () => { alive = false; };
        }, [mdHtml, mdPreview, doc === null ? "" : doc.rel, doc === null ? "" : doc.cwd]);
        const setMdMode = (next) => {
          setMdView(next);
          try { window.localStorage.setItem(MD_VIEW_KEY, next); } catch {}
        };
        const toggleMdView = () => {
          const next = mdPreview ? "edit" : "preview";
          setMdMode(next);
          if (next === "edit") {
            window.setTimeout(() => { try { if (inputRef.current) inputRef.current.focus(); } catch {} }, 0);
          }
        };
        // Copy buttons are written by renderMarkdown, so one delegated click on
        // the scroll pane serves every block: no per-block handler, no second
        // copy of the source in the markup.
        const copyCode = (event) => {
          const target = event.target;
          if (target === null || typeof target.closest !== "function") return;
          const button = target.closest(".dce-md-copy");
          if (button === null) return;
          const block = button.closest(".dce-md-code");
          const code = block === null ? null : block.querySelector("code");
          if (code === null) return;
          const text = code.textContent || "";
          const done = () => {
            button.dataset.copied = "true";
            button.textContent = t("copied");
            window.setTimeout(() => {
              try { button.dataset.copied = "false"; button.textContent = t("copy"); } catch {}
            }, 1200);
          };
          const legacy = () => {
            try {
              const area = document.createElement("textarea");
              area.value = text;
              area.setAttribute("readonly", "");
              area.style.position = "fixed";
              area.style.top = "-1000px";
              document.body.appendChild(area);
              area.select();
              const ok = document.execCommand("copy");
              document.body.removeChild(area);
              if (ok) done();
              else showStatus(t("copyFailed"), false);
            } catch { showStatus(t("copyFailed"), false); }
          };
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(text).then(done, legacy);
          } else legacy();
        };

        const syncCaret = () => {
          const el = inputRef.current;
          const current = docRef.current;
          if (!el || current === null) return;
          const pos = el.selectionStart || 0;
          const cut = current.text.slice(0, pos);
          setCaret({ line: cut.split("\n").length, col: pos - cut.lastIndexOf("\n") });
        };
        const loadDir = (rel) => {
          const root = cwdRef.current;
          if (root === "") return Promise.resolve();
          return post(API + "/list", { cwd: root, rel }).then((data) => {
            if (cwdRef.current !== root) return;
            setNodes((prev) => ({ ...prev, [rel]: { entries: data.entries || [], error: "" } }));
          }).catch((err) => {
            if (cwdRef.current !== root) return;
            setNodes((prev) => ({ ...prev, [rel]: { entries: [], error: String(err.message || err) } }));
          });
        };
        React.useEffect(() => {
          const pull = () => {
            const session = currentSession();
            setCwd(session && session.cwd ? session.cwd : "");
          };
          pull();
          const sessions = service("sessions");
          if (!sessions || !sessions.list || typeof sessions.list.subscribe !== "function") return undefined;
          const stop = sessions.list.subscribe(pull);
          return () => { if (typeof stop === "function") stop(); };
        }, []);
        React.useEffect(() => {
          setTabs([]);
          setDiffs([]);
          setActive("");
          setPopup(null);
          setMenu(null);
          setNodes({});
          setExpanded({ "": true });
          showStatus("");
          if (cwd === "") return;
          loadDir("");
        }, [cwd]);
        React.useEffect(() => {
          if (popup === null) return undefined;
          const onKey = (event) => {
            if (event.key === "Escape") { setPopup(null); return; }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Enter") {
              const item = popup.items[popup.selected] || popup.items[0];
              setPopup(null);
              if (item) land(item);
              return;
            }
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setPopup((prev) => prev === null ? prev : {
              ...prev,
              selected: (prev.selected + delta + prev.items.length) % prev.items.length
            });
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, [popup]);
        React.useLayoutEffect(() => {
          const pre = paintRef.current;
          const input = inputRef.current;
          const scroller = scrollerRef.current;
          if (!pre || !input || !scroller) return;
          // Preview does not mount the textarea. Leaving it must size the box
          // even when the document itself did not change, or the input stays
          // at its default couple of rows and clicks on the source miss it.
          input.style.height = Math.max(pre.scrollHeight, scroller.clientHeight) + "px";
          input.style.width = Math.max(pre.scrollWidth, scroller.clientWidth) + "px";
          if (caretRef.current !== null) {
            const pos = caretRef.current;
            caretRef.current = null;
            try { input.setSelectionRange(pos, pos); } catch {}
          }
          if (seekRef.current !== null && doc !== null && !doc.binary) {
            const target = seekRef.current;
            seekRef.current = null;
            // A seek that names a file only lands on that file; otherwise one
            // left over from an earlier request would jump whatever opens next.
            if (target.rel !== undefined && target.rel !== null && target.rel !== doc.rel) return;
            const pos = offsetOf(doc.text, target.line, target.character);
            try { input.focus(); input.setSelectionRange(pos, pos); } catch {}
            const sample = paintRef.current || input;
            const lh = parseFloat(window.getComputedStyle(sample).lineHeight);
            if (Number.isFinite(lh)) scroller.scrollTop = Math.max(0, target.line * lh - scroller.clientHeight / 2);
            flashLine(target.line);
          }
        }, [painted, doc, mdPreview]);
        React.useEffect(() => {
          const onLeave = (event) => {
            if (tabsRef.current.some((row) => !row.binary && (row.text !== row.saved || row.eol !== row.savedEol))) {
              event.preventDefault();
              event.returnValue = "";
            }
          };
          window.addEventListener("beforeunload", onLeave);
          return () => window.removeEventListener("beforeunload", onLeave);
        }, []);
        // Pre-warm the language server for the open file so the first jump
        // does not pay the cold start. Fire and forget: the response is
        // ignored and failures (e.g. no server for the language) are fine.
        React.useEffect(() => {
          if (doc === null || doc.binary) return;
          const rel = doc.rel;
          const root = doc.cwd;
          post(API + "/symbol", { cwd: root, rel, operation: "warmup", line: 0, character: 0 }).catch(() => {});
        }, [doc && doc.rel, doc && doc.cwd]);

        const openRel = (rel) => {
          if (pendingSeek !== null) {
            seekRef.current = pendingSeek;
            pendingSeek = null;
          }
          // A seek names a line, and lines only exist in the source view:
          // jumping into a rendered .md file returns to the editor first.
          if (seekRef.current !== null && languageOf(rel).id === "md") setMdMode("edit");
          const held = tabsRef.current.find((row) => row.rel === rel && row.cwd === cwdRef.current);
          if (held) {
            setActive(rel);
            const target = seekRef.current;
            if (target && docRef.current && docRef.current.rel === rel) {
              seekRef.current = null;
              // The tab is already on screen, so no load will re-run the seek
              // effect: centre the line here, the way `place` does. Jumping
              // twice inside one file (two hunks of a diff) depends on it.
              window.setTimeout(() => {
                const el = inputRef.current;
                if (!el) return;
                const pos = offsetOf(held.text, target.line, target.character);
                try { el.focus(); el.setSelectionRange(pos, pos); } catch {}
                const scroller = scrollerRef.current;
                const sample = paintRef.current || el;
                const lh = sample ? parseFloat(window.getComputedStyle(sample).lineHeight) : 18;
                if (scroller && Number.isFinite(lh)) {
                  scroller.scrollTop = Math.max(0, target.line * lh - scroller.clientHeight / 2);
                }
                flashLine(target.line);
              }, 0);
            }
            return;
          }
          const imageMime = imageMimeOf(rel);
          if (imageMime !== "") {
            const root = cwdRef.current;
            const seq = openSeqRef.current + 1;
            openSeqRef.current = seq;
            post(API + "/image", { cwd: root, rel }).then((data) => {
              if (cwdRef.current !== root || openSeqRef.current !== seq) return;
              const mime = typeof data.mime === "string" && data.mime !== "" ? data.mime : imageMime;
              const payload = typeof data.data === "string" ? data.data : "";
              setDoc({
                cwd: root, rel, text: "", saved: "", eol: "lf", savedEol: "lf", bom: false,
                lang: { id: "image", label: t("image") }, binary: true, note: "",
                image: "data:" + mime + ";base64," + payload
              });
              showStatus("");
            }).catch((err) => {
              if (cwdRef.current !== root || openSeqRef.current !== seq) return;
              const code = String(err.message || err);
              setDoc({
                cwd: root, rel, text: "", saved: "", eol: "lf", savedEol: "lf", bom: false,
                lang: { id: "image", label: t("image") }, binary: true, note: t(code), image: ""
              });
              showStatus("");
            });
            return;
          }
          const root = cwdRef.current;
          const seq = openSeqRef.current + 1;
          openSeqRef.current = seq;
          post(API + "/read", { cwd: root, rel }).then((data) => {
            if (cwdRef.current !== root || openSeqRef.current !== seq) return;
            cacheRef.current = null;
            setDoc({
              cwd: root, rel, text: data.text, saved: data.text,
              eol: data.eol, savedEol: data.eol, bom: data.bom === true,
              lang: languageOf(rel), binary: false, note: ""
            });
            setCaret({ line: 1, col: 1 });
            showStatus("");
            window.setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch {} }, 0);
          }).catch((err) => {
            if (cwdRef.current !== root || openSeqRef.current !== seq) return;
            const code = String(err.message || err);
            if (code === "binary" || code === "not-utf8" || code === "too-large") {
              setDoc({
                cwd: root, rel, text: "", saved: "", eol: "lf", savedEol: "lf", bom: false,
                lang: languageOf(rel), binary: true, note: t(code)
              });
              showStatus("");
              return;
            }
            showStatus(t(code));
          });
        };
        const save = () => {
          const current = docRef.current;
          if (current === null || current.binary) return;
          if (current.text === current.saved && current.eol === current.savedEol) return;
          if (savingRef.current) return;
          savingRef.current = true;
          // `base` is a SHA-256 of the text this tab last loaded or wrote. The
          // server hashes what is on disk and refuses the overwrite when
          // someone else (an agent, another editor) changed the file in the
          // meantime, instead of silently clobbering their work. Hashing needs
          // crypto.subtle (secure context only); without it the check is
          // skipped and saving behaves as before.
          const shaOf = async (value) => {
            const subtle = window.crypto && window.crypto.subtle;
            if (!subtle) return undefined;
            try {
              const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
              return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
            } catch { return undefined; }
          };
          Promise.resolve(shaOf(current.saved)).then((base) => post(API + "/write", {
            cwd: current.cwd, rel: current.rel, text: current.text, eol: current.eol, bom: current.bom,
            base
          })).then(() => {
            setDoc((prev) => prev && prev.rel === current.rel && prev.cwd === current.cwd
              ? { ...prev, saved: current.text, savedEol: current.eol } : prev);
            showStatus(t("saved"), true);
          }).catch((err) => {
            showStatus(t(String(err.message || err)));
          }).finally(() => { savingRef.current = false; });
        };
        const closeDoc = () => {
          const shown = diffRef.current;
          if (shown !== null) {
            const rest = diffsRef.current.filter((row) => row.key !== shown.key);
            setDiffs(rest);
            const files = tabsRef.current;
            setActive(files.length ? files[files.length - 1].rel : (rest.length ? rest[rest.length - 1].key : ""));
            showStatus("");
            setPopup(null);
            return;
          }
          const current = docRef.current;
          if (current === null) return;
          if (!current.binary && (current.text !== current.saved || current.eol !== current.savedEol)) {
            if (!window.confirm(t("discard"))) return;
          }
          const rest = tabsRef.current.filter((row) => !(row.rel === current.rel && row.cwd === current.cwd));
          setTabs(rest);
          setActive(rest.length ? rest[rest.length - 1].rel : (diffsRef.current.length ? diffsRef.current[diffsRef.current.length - 1].key : ""));
          showStatus("");
          setPopup(null);
        };

        /**
         * Show a unified diff in the editor area.
         *
         * The Git panel owns the diff — it knows the revision and the working
         * tree — and hands over the text plus one row per line. This only
         * renders it, so no Git knowledge leaks into the editor.
         *
         * A diff opened while another diff is on screen replaces it: stepping
         * through a change list with ↑/↓ should move one preview, not leave a
         * tab behind for every file visited.
         */
        const openDiff = (meta) => {
          if (meta === null || typeof meta !== "object") return;
          const key = String(meta.key || "");
          if (key === "") return;
          const path = String(meta.path || "");
          const row = {
            key,
            path,
            hash: String(meta.hash || ""),
            title: String(meta.title || (path === "" ? t("diffTab") : path.split("/").pop())),
            line: Number(meta.line) > 0 ? Math.floor(Number(meta.line)) : 0,
            text: String(meta.text || ""),
            rows: Array.isArray(meta.rows) ? meta.rows : []
          };
          setDiffs((prev) => {
            const at = prev.findIndex((item) => item.key === key);
            if (at >= 0) {
              const copy = prev.slice();
              copy[at] = row;
              return copy;
            }
            const shown = prev.findIndex((item) => item.key === activeRef.current);
            if (shown >= 0 && meta.replace !== false) {
              const copy = prev.slice();
              copy[shown] = row;
              return copy;
            }
            const next = prev.concat([row]);
            return next.length > MAX_DIFF_TABS ? next.slice(next.length - MAX_DIFF_TABS) : next;
          });
          showStatus("");
          setPopup(null);
          setActive(key);
        };
        const openFind = () => {
          // Find works on the textarea, which the preview does not mount.
          // Rather than fail silently, ⌘F on a rendered Markdown file drops
          // back to the source — that is what the reader was about to do.
          if (mdPreviewRef.current) setMdMode("edit");
          setFind((prev) => ({ open: true, query: prev.query }));
          window.setTimeout(() => { try { findRef.current && findRef.current.focus(); findRef.current && findRef.current.select(); } catch {} }, 0);
        };
        // Blink a highlight band over the landed line. The caret alone is a
        // 1px sliver that is easy to miss in a long file after a jump.
        const flashLine = (line) => {
          const sample = paintRef.current || inputRef.current;
          const lh = sample ? parseFloat(window.getComputedStyle(sample).lineHeight) : 18;
          if (!Number.isFinite(lh) || lh <= 0) return;
          flashSeq.current += 1;
          // The paint block pads 6px above line 0.
          setFlash({ id: flashSeq.current, top: 6 + line * lh, height: lh });
        };
        const place = (line, character) => {
          // The caret lives in the textarea, which the preview does not mount.
          // Switch first, then land once the editor is on screen.
          if (mdPreviewRef.current) {
            mdPreviewRef.current = false;
            setMdMode("edit");
            window.setTimeout(() => place(line, character), 0);
            return;
          }
          const el = inputRef.current;
          const current = docRef.current;
          if (!el || current === null || current.binary) return;
          const pos = offsetOf(current.text, line, character);
          try { el.focus(); el.setSelectionRange(pos, pos); } catch {}
          const scroller = scrollerRef.current;
          const sample = paintRef.current || el;
          const lh = sample ? parseFloat(window.getComputedStyle(sample).lineHeight) : 18;
          if (scroller && Number.isFinite(lh)) scroller.scrollTop = Math.max(0, line * lh - scroller.clientHeight / 2);
          flashLine(line);
          syncCaret();
        };
        const remember = () => {
          const current = docRef.current;
          const el = inputRef.current;
          if (current === null || current.binary || !el) return;
          const at = positionOf(current.text, el.selectionStart || 0);
          backRef.current.push({ rel: current.rel, line: at.line, character: at.character });
          if (backRef.current.length > 40) backRef.current.shift();
          // A fresh jump closes every forward branch that started from an
          // older position, the way browsers and IDEA do.
          fwdRef.current.length = 0;
        };
        const land = (loc) => {
          remember();
          setPopup(null);
          const current = docRef.current;
          if (current !== null && current.rel === loc.rel && current.cwd === cwdRef.current && !current.binary) {
            place(loc.line, loc.character);
            return;
          }
          seekRef.current = { line: loc.line, character: loc.character, rel: loc.rel };
          openRel(loc.rel);
        };
        const gotoSymbol = (operation) => {
          const current = docRef.current;
          const el = inputRef.current;
          if (current === null || current.binary || !el) return;
          const at = positionOf(current.text, el.selectionStart || 0);
          showStatus("");
          setPopup(null);
          const row = current.text.split("\n")[at.line] || "";
          let start = Math.min(at.character, row.length);
          let end = start;
          while (start > 0 && /[\w$]/.test(row[start - 1])) start -= 1;
          while (end < row.length && /[\w$]/.test(row[end])) end += 1;
          const word = row.slice(start, end);
          if (!/^[A-Za-z_$][\w$]*$/.test(word)) { showStatus(t("noSymbol")); return; }
          const payload = {
            cwd: current.cwd, rel: current.rel, line: at.line, character: at.character,
            text: current.text
          };
          const landList = (locations) => {
            if (locations.length === 0) { showStatus(t("noSymbol")); return; }
            if (locations.length === 1) { land(locations[0]); return; }
            setPopup({ x: popupAt.current.x, y: popupAt.current.y + 6, items: locations, selected: 0 });
          };
          post(API + "/symbol", { ...payload, operation }).then((data) => {
            if (data && data.error === "lsp-unavailable") {
              showStatus(t("lsp-unavailable"));
              return;
            }
            const locations = data && Array.isArray(data.locations) ? data.locations : [];
            // On a declaration goToDefinition returns nothing or the
            // declaration itself. IDEA-style: offer its references instead,
            // so clicking the method name leads back to the usage.
            const selfOnly = locations.length === 1 && locations[0].rel === current.rel && locations[0].line === at.line;
            if (operation === "goToDefinition" && locations.length === 0 || selfOnly) {
              post(API + "/symbol", { ...payload, operation: "findReferences" }).then((data2) => {
                const refs = data2 && Array.isArray(data2.locations) ? data2.locations.filter((loc) => !(loc.rel === current.rel && loc.line === at.line)) : [];
                landList(refs);
              }).catch((err) => showStatus(t(String(err.message || err))));
              return;
            }
            landList(locations);
          }).catch((err) => showStatus(t(String(err.message || err))));
        };
        // Move the caret to a position, opening the file if needed. Shared by
        // back/forward: neither writes a history entry of its own.
        const seek = (target) => {
          const current = docRef.current;
          if (current !== null && current.rel === target.rel) { place(target.line, target.character); return; }
          seekRef.current = { line: target.line, character: target.character, rel: target.rel };
          openRel(target.rel);
        };
        const snapshot = () => {
          const current = docRef.current;
          const el = inputRef.current;
          if (current === null || current.binary || !el) return null;
          const at = positionOf(current.text, el.selectionStart || 0);
          return { rel: current.rel, line: at.line, character: at.character };
        };
        const goBack = () => {
          const prev = backRef.current.pop();
          if (prev === undefined) return;
          const now = snapshot();
          if (now !== null) fwdRef.current.push(now);
          seek(prev);
        };
        const goForward = () => {
          const next = fwdRef.current.pop();
          if (next === undefined) return;
          const now = snapshot();
          if (now !== null) backRef.current.push(now);
          seek(next);
        };
        docApi.closeDoc = closeDoc;
        docApi.save = save;
        docApi.find = openFind;
        docApi.goto = gotoSymbol;
        docApi.back = goBack;
        docApi.forward = goForward;
        docApi.revealLine = (line) => {
          const n = Number(line);
          if (!Number.isFinite(n) || n < 1) return;
          const current = docRef.current;
          if (current !== null && !current.binary) { place(n - 1, 0); return; }
          // No document is open, so there is nothing to reveal into. Parking
          // the line here used to leave a targetless seek that the next file
          // to open would consume as a mystery jump — callers that want a
          // specific file use openFile, which carries the rel with it.
        };
        docApi.currentFile = () => {
          const current = docRef.current;
          const el = inputRef.current;
          if (current === null || current.binary) return null;
          if (!el) return { rel: current.rel, start: 1, end: 1, collapsed: true };
          const a = positionOf(current.text, el.selectionStart || 0);
          const b = positionOf(current.text, el.selectionEnd || 0);
          return {
            rel: current.rel,
            start: a.line + 1,
            end: b.line + 1,
            collapsed: el.selectionStart === el.selectionEnd
          };
        };
        docApi.openRel = (rel) => {
          // The workspace cwd arrives asynchronously after mount. Opening now
          // would post an empty cwd and be refused, and clearing queuedRel
          // would lose the request — so leave it queued; the effect below
          // lands it once the cwd update re-renders.
          if (cwdRef.current === "") return;
          queuedRel = "";
          openRel(rel);
        };
        docApi.openDiff = (meta) => {
          queuedDiff = null;
          openDiff(meta);
        };
        docApi.activeDiff = () => {
          const shown = diffRef.current;
          return shown === null ? null : { key: shown.key, path: shown.path, hash: shown.hash };
        };
        /**
         * New-side line of the change at the middle of the diff on screen.
         *
         * Every row is one unwrapped line, so the row under the viewport centre
         * is arithmetic; the nearest changed row at or below it is the change
         * the reader is looking at. Falls back to the tab's own first change.
         */
        docApi.diffLine = () => {
          const shown = diffRef.current;
          if (shown === null) return 0;
          const fallback = shown.line > 0 ? shown.line : 0;
          const el = diffScrollRef.current;
          const rows = shown.rows;
          if (el === null || !Array.isArray(rows) || rows.length === 0) return fallback;
          // Row height comes from the text block, not the scroll box: the box
          // inherits the UI line-height and would map to the wrong row.
          const block = typeof el.querySelector === "function" ? el.querySelector(".dce-diffpre") : null;
          const lh = parseFloat(window.getComputedStyle(block === null ? el : block).lineHeight);
          if (!Number.isFinite(lh) || lh <= 0) return fallback;
          // `.dce-diffscroll` pads 6px above the first row.
          const at = Math.max(0, Math.min(rows.length - 1, Math.floor((el.scrollTop + el.clientHeight / 2 - 6) / lh)));
          const isChange = (row) => row.newLine > 0 && (row.kind === "+" || row.kind === "-");
          for (let i = at; i < rows.length; i++) if (isChange(rows[i])) return rows[i].newLine;
          for (let i = at - 1; i >= 0; i--) if (isChange(rows[i])) return rows[i].newLine;
          return fallback;
        };
        docApi.gitDock = () => gitPaneRef.current;
        React.useEffect(() => {
          if (queuedRel === "") return;
          // A request can name a file before this panel has ever mounted, and
          // the workspace arrives in the effect above. Opening now would post
          // an empty cwd and be refused, so keep the request queued — the cwd
          // update re-renders and lands it.
          if (cwdRef.current === "") return;
          const rel = queuedRel;
          queuedRel = "";
          openRel(rel);
        });
        React.useEffect(() => {
          if (queuedDiff === null) return;
          const meta = queuedDiff;
          queuedDiff = null;
          openDiff(meta);
        });

        const jump = (back) => {
          const el = inputRef.current;
          const current = docRef.current;
          if (!el || current === null || find.query === "") return;
          const needle = find.query.toLowerCase();
          const hay = current.text.toLowerCase();
          let from = el.selectionStart || 0;
          if (!back && current.text.slice(el.selectionStart, el.selectionEnd).toLowerCase() === needle) from = el.selectionEnd;
          let at = back ? hay.lastIndexOf(needle, Math.max(0, from - 1)) : hay.indexOf(needle, from);
          if (at < 0) at = back ? hay.lastIndexOf(needle) : hay.indexOf(needle);
          if (at < 0) return;
          el.focus();
          el.setSelectionRange(at, at + needle.length);
          const scroller = scrollerRef.current;
          if (scroller) {
            const line = current.text.slice(0, at).split("\n").length - 1;
            const sample = paintRef.current || el;
            const lh = sample ? parseFloat(window.getComputedStyle(sample).lineHeight) : 18;
            scroller.scrollTop = Math.max(0, line * (Number.isFinite(lh) ? lh : 18) - scroller.clientHeight / 2);
          }
          syncCaret();
        };
        const onTreeDrag = (event) => {
          const startX = event.clientX;
          const startW = treeW;
          const move = (ev) => setTreeW(Math.min(480, Math.max(160, startW + ev.clientX - startX)));
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            dragCleanupRef.current = null;
          };
          // pointercancel (touch gestures, overlay taken down mid-drag) must
          // tear the listeners down too, or they leak onto window for good.
          const up = (ev) => {
            stop();
            try { window.localStorage.setItem(TREE_W_KEY, String(Math.min(480, Math.max(160, startW + ev.clientX - startX)))); } catch {}
          };
          dragCleanupRef.current = stop;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
        };
        const toggleDir = (rel) => {
          setExpanded((prev) => ({ ...prev, [rel]: !prev[rel] }));
          if (!expanded[rel] && nodes[rel] === undefined) loadDir(rel);
        };
        const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        const orderEntries = (entries) => entries.slice().sort((a, b) => (a.dir === b.dir ? byName.compare(a.name, b.name) : a.dir ? -1 : 1));
        const folderIcon = (open) => {
          const Icon = ui && (open ? ui.IconFolderOpenRegular : ui.IconFolderCloseRegular);
          return typeof Icon === "function" ? h(Icon, { className: "dce-icon" }) : null;
        };
        const fileIcon = (name) => {
          if (!ui || typeof ui.FileTypeIcon !== "function") return null;
          const kind = typeof ui.classifyFileType === "function" ? ui.classifyFileType(name) : "other";
          return h(ui.FileTypeIcon, { kind, size: 16, className: "dce-fileicon" });
        };
        const renderLevel = (rel) => {
          const node = nodes[rel];
          if (node === undefined) return h("li", { className: "dce-note" }, t("loading"));
          if (node.error) return h("li", { className: "dce-note" }, node.error === "not-found" || node.error === "not-a-directory" ? t("dirNotFound") : t(node.error));
          const entries = orderEntries(node.entries || []);
          if (entries.length === 0) return h("li", { className: "dce-note" }, t("emptyDir"));
          return entries.map((entry) => {
            const open = entry.dir && expanded[entry.rel] === true;
            return h("li", { key: entry.rel, className: "dce-item" },
              h("button", {
                type: "button",
                className: "dce-row" + (!entry.dir && doc && doc.rel === entry.rel ? " dce-on" : ""),
                title: entry.rel,
                "data-dce-rel": entry.rel,
                "aria-expanded": entry.dir ? open : undefined,
                onClick: () => { if (entry.dir) toggleDir(entry.rel); else openRel(entry.rel); },
                onContextMenu: (event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, rel: entry.rel, dir: entry.dir, name: entry.name });
                }
              },
                entry.dir ? folderIcon(open) : fileIcon(entry.name),
                h("span", { className: "dce-name" }, entry.name)),
              open ? h("ul", { className: "dce-level" }, renderLevel(entry.rel)) : null);
          });
        };
        const parentOf = (rel) => {
          const cut = String(rel || "").lastIndexOf("/");
          return cut < 0 ? "" : rel.slice(0, cut);
        };
        const refreshParent = (rel) => loadDir(parentOf(rel));
        const askName = (title, value) => {
          const name = window.prompt(t("namePrompt"), value || "");
          if (name === null) return "";
          const trimmed = name.trim().replace(/\\/g, "/");
          if (trimmed === "" || trimmed.indexOf("/") >= 0 || trimmed === "." || trimmed === "..") return "";
          return trimmed;
        };
        const createAt = (dirRel, dir) => {
          const name = askName(t("namePrompt"), dir ? "folder" : "untitled.txt");
          if (name === "") return;
          const rel = dirRel === "" ? name : dirRel + "/" + name;
          post(API + "/create", { cwd: cwdRef.current, rel, dir }).then(() => {
            setExpanded((prev) => ({ ...prev, [dirRel]: true }));
            loadDir(dirRel);
            if (!dir) openRel(rel);
          }).catch((err) => showStatus(t(String(err.message || err))));
        };
        const renameAt = (rel, name) => {
          const next = askName(t("namePrompt"), name);
          if (next === "" || next === name) return;
          const dest = parentOf(rel) === "" ? next : parentOf(rel) + "/" + next;
          post(API + "/rename", { cwd: cwdRef.current, rel, to: dest }).then(() => {
            refreshParent(rel);
            setTabs((prev) => prev.map((row) => row.rel === rel && row.cwd === cwdRef.current ? { ...row, rel: dest } : row));
            if (active === rel) setActive(dest);
          }).catch((err) => showStatus(t(String(err.message || err))));
        };
        const deleteAt = (rel, name) => {
          if (!window.confirm(t("confirmDelete").replace("{name}", name))) return;
          post(API + "/delete", { cwd: cwdRef.current, rel }).then(() => {
            refreshParent(rel);
            const rest = tabsRef.current.filter((row) => !(row.cwd === cwdRef.current && (row.rel === rel || row.rel.indexOf(rel + "/") === 0)));
            setTabs(rest);
            if (!rest.some((row) => row.rel === active)) setActive(rest.length ? rest[rest.length - 1].rel : "");
          }).catch((err) => showStatus(t(String(err.message || err))));
        };
        const revealInTree = () => {
          if (doc === null) return;
          // Locate implies showing the tree first.
          if (!treeOpen) setTreeVisible(true);
          if (doc.rel.startsWith("/") || doc.rel.indexOf("..") >= 0 || (doc.cwd && doc.cwd !== cwdRef.current)) {
            showStatus(t("outsideWorkspace"));
            return;
          }
          const parts = doc.rel.split("/").filter((part) => part !== "");
          const dirs = [""];
          let acc = "";
          for (let i = 0; i < parts.length - 1; i++) {
            acc = acc === "" ? parts[i] : acc + "/" + parts[i];
            dirs.push(acc);
          }
          setExpanded((prev) => {
            const next = { ...prev, "": true };
            dirs.forEach((rel) => { next[rel] = true; });
            return next;
          });
          Promise.all(dirs.map((rel) => loadDir(rel))).then(() => {
            window.setTimeout(() => {
              const row = document.querySelector('[data-dce-rel="' + (window.CSS && CSS.escape ? CSS.escape(doc.rel) : doc.rel) + '"]');
              if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
              else showStatus(t("fileNotFound"));
            }, 40);
          });
        };
        // The header is ~150px wide. The host's PathLabel keeps the tail but drops
        // the head silently, which reads as a truncated string; two segments plus
        // an explicit ellipsis says "there is more to the left" on purpose.
        const shortCwd = (value) => {
          const parts = String(value || "").replace(/[/\\]+$/, "").split(/[/\\]/).filter((item) => item !== "");
          if (parts.length <= 2) return value;
          return "…/" + parts.slice(-2).join("/");
        };
        const fileTabs = tabs.filter((tab) => tab.cwd === cwd);
        const lines = doc === null || doc.binary ? 1 : doc.text.split("\n").length;
        const gutter = doc === null || doc.binary ? "" : Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n");
        const eolLabel = doc === null ? "" : doc.eol === "crlf" ? "CRLF" : doc.eol === "cr" ? "CR" : "LF";
        const cycleEol = () => {
          if (doc === null || doc.binary) return;
          const next = doc.eol === "lf" ? "crlf" : doc.eol === "crlf" ? "cr" : "lf";
          setDoc({ ...doc, eol: next });
        };
        /**
         * Hand the change on screen back to the Git panel, which owns the
         * repo-relative path and knows how to land the working-tree file on a
         * line. The editor only knows "this diff, this line".
         */
        const jumpDiff = () => {
          const shown = diffRef.current;
          if (shown === null) return;
          const bridge = window.__dshGitDiff;
          if (bridge === undefined || bridge === null || typeof bridge.jump !== "function") return;
          try { bridge.jump(shown.path, typeof docApi.diffLine === "function" ? docApi.diffLine() : 0); } catch (err) {
            console.error("dsh-idea jumpDiff:", err);
          }
        };
        /** Rows of the open diff, one per text line, coloured by their marker. */
        const renderDiff = (tab) => {
          const body = tab.text === "" ? [] : tab.text.replace(/\n$/, "").split("\n");
          if (body.length === 0 || tab.rows.length === 0) return h("div", { className: "dce-blank" }, t("noDiff"));
          const scroll = (children) => h("div", { className: "dce-diffview" },
            h("div", { className: "dce-diffscroll", ref: diffScrollRef }, children));
          // Thousands of rows are not worth thousands of vnodes; the plain
          // branch still scrolls, and the jump line still resolves from `rows`.
          if (body.length > 1500) {
            return scroll(h("div", { className: "dce-diffpre dce-diffplain" }, tab.text));
          }
          return scroll(h("div", { className: "dce-diffpre" }, body.map((line, i) => {
            const row = tab.rows[i] || { kind: " ", newLine: 0, oldLine: 0 };
            const num = row.newLine > 0 ? row.newLine : row.oldLine > 0 ? String(row.oldLine) : "";
            return h("div", { key: i, className: "dce-dlrow", "data-k": row.kind },
              h("span", { className: "dce-dlnum" }, String(num)),
              h("span", { className: "dce-dltxt" }, line === "" ? " " : line));
          })));
        };
        const groupLabel = (id) => {
          if (id === "session") return t("keysGroupSession");
          if (id === "workspace") return t("keysGroupWorkspace");
          if (id === "files") return t("keysGroupFiles");
          if (id === "editor") return t("keysGroupEditor");
          if (id === "git") return t("keysGroupGit");
          if (id === "database") return t("keysGroupDatabase");
          return t("keysGroupOther");
        };
        const commandName = (api, cmd) => {
          if (typeof api.labelText === "function") return api.labelText(cmd.id);
          const labels = cmd.labels;
          if (labels) return labels[uiLang] || labels.en || labels.zh || cmd.id;
          return cmd.label || cmd.id;
        };
        const renderKeys = () => {
          if (!keysOpen) return null;
          const api = shortcutApi();
          const btn = keysBtnRef.current;
          const rect = btn === null ? null : btn.getBoundingClientRect();
          const style = rect === null
            ? { right: 12, bottom: 40 }
            : { right: Math.max(8, window.innerWidth - rect.right), bottom: Math.max(8, window.innerHeight - rect.top + 6) };
          let body;
          if (api === null) body = h("p", { className: "dce-keysempty" }, t("keysEmpty"));
          else {
            const query = keysQuery.trim().toLowerCase();
            const labelOf = (cmd) => {
              const spec = api.binding(cmd.id);
              return spec === undefined ? chordText(cmd.default) : chordText(spec);
            };
            const rows = api.commands().filter((cmd) => {
              if (query === "") return true;
              const name = commandName(api, cmd).toLowerCase();
              const key = labelOf(cmd).toLowerCase();
              return name.indexOf(query) >= 0 || key.indexOf(query) >= 0 || cmd.id.toLowerCase().indexOf(query) >= 0;
            });
            if (rows.length === 0) body = h("p", { className: "dce-keysempty" }, t("keysEmpty"));
            else {
              const seen = {};
              const blocks = [];
              rows.forEach((cmd) => {
                const group = KEY_GROUPS.indexOf(cmd.group) >= 0 ? cmd.group : "__other";
                if (!seen[group]) { seen[group] = []; blocks.push(group); }
                seen[group].push(cmd);
              });
              const ordered = KEY_GROUPS.filter((id) => seen[id]).concat(seen.__other ? ["__other"] : []);
              body = h("div", { className: "dce-keyslist" }, ordered.map((group) => h("div", { key: group },
                h("div", { className: "dce-keysgroup" }, groupLabel(group === "__other" ? "" : group)),
                seen[group].map((cmd) => {
                  const bound = labelOf(cmd);
                  const fallback = chordText(cmd.default);
                  const recording = recordingId === cmd.id;
                  const conflict = bound === "" ? "" : (() => {
                    const other = api.commands().find((row) => row.id !== cmd.id && labelOf(row) === bound);
                    return other === undefined ? "" : commandName(api, other);
                  })();
                  return h("div", { key: cmd.id, className: "dce-keysrow" },
                    h("button", {
                      type: "button",
                      className: "dce-keysname",
                      title: conflict === "" ? commandName(api, cmd) : t("keysConflict").replace("{name}", conflict),
                      onClick: () => { setRecordingId(cmd.id); setKeysNote(""); }
                    }, commandName(api, cmd)),
                    h("button", {
                      type: "button",
                      className: "dce-keysbind",
                      "data-on": recording ? "true" : "false",
                      title: t("keysHint"),
                      onClick: () => { setRecordingId(cmd.id); setKeysNote(""); }
                    }, recording ? t("keysRecording") : (bound || "—")),
                    bound !== "" ? h("button", {
                      type: "button",
                      className: "dce-keysmini",
                      title: t("keysClear"),
                      "aria-label": t("keysClear"),
                      onClick: () => { api.set(cmd.id, null); setRecordingId(null); }
                    }, "×") : null,
                    bound !== fallback && typeof api.reset === "function" ? h("button", {
                      type: "button",
                      className: "dce-keysmini",
                      title: t("keysReset"),
                      onClick: () => { api.reset(cmd.id); setRecordingId(null); }
                    }, "↺") : null);
                })
              )));
            }
          }
          void keysTick;
          return h("div", {
            className: "dce-keys",
            ref: keysPanelRef,
            style: style,
            role: "dialog",
            "aria-label": t("keys")
          },
            h("div", { className: "dce-keyshead" },
              h("strong", null, t("keys")),
              h("input", {
                value: keysQuery,
                placeholder: t("find"),
                onChange: (event) => setKeysQuery(event.target.value)
              })),
            h("p", { className: "dce-keyshint" }, t("keysHint")),
            keysNote !== "" ? h("p", { className: "dce-keysnote" }, keysNote) : null,
            body);
        };
        const saveTip = withKey(t("save"), IS_MAC ? "⌘S" : "Ctrl+S");
        const gitTip = withKey(t("gitDock"), boundText("git.toggle", { ctrl: !IS_MAC, meta: IS_MAC, code: "Digit9" }));
        const onGitDrag = (event) => {
          const pane = gitPaneRef.current;
          if (pane === null) return;
          event.preventDefault();
          const startY = event.clientY;
          const startH = pane.getBoundingClientRect().height;
          const move = (ev) => {
            const next = Math.round(Math.min(window.innerHeight * 0.72, Math.max(120, startH - (ev.clientY - startY))));
            pane.style.height = next + "px";
          };
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            dragCleanupRef.current = null;
          };
          const up = () => {
            stop();
            const height = Math.round(pane.getBoundingClientRect().height);
            try { window.localStorage.setItem(GIT_H_KEY, String(height)); } catch {}
            setGitH(height);
          };
          dragCleanupRef.current = stop;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
        };
        return h("div", { className: "dce-body" },
          h("div", { className: "dce-root" },
          treeOpen ? h("aside", { className: "dce-tree", style: { width: treeW } },
            h("div", { className: "dce-treebar" },
              h("span", { className: "dce-treename", title: cwd }, cwd === "" ? t("files") : shortCwd(cwd)),
              h("button", {
                type: "button", className: "dce-tool", title: t("locate"), "aria-label": t("locate"),
                disabled: doc === null, onClick: revealInTree
              }, h(ToolIcon, { name: "locate" })),
              h("button", {
                type: "button", className: "dce-tool", title: t("collapseTree"), "aria-label": t("collapseTree"),
                onClick: () => setTreeVisible(false)
              }, h(ToolIcon, { name: "collapse" })),
              h("button", {
                type: "button", className: "dce-tool", title: t("newFile"), "aria-label": t("newFile"),
                onClick: () => createAt("", false)
              }, h(ToolIcon, { name: "plus" })),
              h("button", {
                type: "button", className: "dce-tool", title: t("refresh"), "aria-label": t("refresh"),
                onClick: () => { Object.keys(expanded).forEach((rel) => { if (expanded[rel]) loadDir(rel); }); }
              }, h(ToolIcon, { name: "refresh" }))),
            h("div", { className: "dce-scroll" },
              cwd === ""
                ? h("div", { className: "dce-note" }, t("noWorkspace"))
                : h("ul", { className: "dce-level" }, renderLevel(""))),
            menu ? h("div", {
              className: "dce-menu",
              style: { left: menu.x, top: menu.y },
              onMouseLeave: () => setMenu(null)
            },
              h("button", { type: "button", title: t("newFile"), onClick: () => { setMenu(null); createAt(menu.dir ? menu.rel : parentOf(menu.rel), false); } }, t("newFile")),
              h("button", { type: "button", title: t("newDir"), onClick: () => { setMenu(null); createAt(menu.dir ? menu.rel : parentOf(menu.rel), true); } }, t("newDir")),
              h("button", { type: "button", title: t("rename"), onClick: () => { const item = menu; setMenu(null); renameAt(item.rel, item.name); } }, t("rename")),
              h("button", { type: "button", title: t("remove"), onClick: () => { const item = menu; setMenu(null); deleteAt(item.rel, item.name); } }, t("remove"))) : null)
          : h("div", { className: "dce-treefold" },
            h("button", { type: "button", className: "dce-foldbtn", title: t("expandTree"), onClick: () => setTreeVisible(true) }, "»")),
          treeOpen ? h("div", { className: "dce-split", onPointerDown: onTreeDrag }) : null,
          h("section", { className: "dce-doc" },
            fileTabs.length > 0 || diffs.length > 0 ? h("div", { className: "dce-tabs" },
              fileTabs.map((tab) => h("button", {
                key: tab.rel,
                type: "button",
                className: "dce-tab" + (tab.rel === active ? " dce-on" : ""),
                title: tab.rel,
                onClick: () => setActive(tab.rel)
              },
                tab.text !== tab.saved ? h("span", { className: "dce-dirty" }) : null,
                h("span", { className: "dce-tabname" }, tab.rel.split("/").pop()))),
              diffs.map((row) => h("button", {
                key: row.key,
                type: "button",
                className: "dce-tab dce-difftab" + (row.key === active ? " dce-on" : ""),
                title: row.path + (row.hash === "WORKING" ? "" : "  " + row.hash.slice(0, 7)),
                onClick: () => setActive(row.key)
              },
                h("span", { className: "dce-diffbadge" }, "Δ"),
                h("span", { className: "dce-tabname" }, row.title)))) : null,
            activeDiff !== null
              ? h("div", { className: "dce-docbar" },
                h("span", { className: "dce-path", title: activeDiff.path }, activeDiff.path),
                h("span", { className: "dce-diffhash" }, activeDiff.hash === "WORKING" ? t("diffTab") : activeDiff.hash.slice(0, 7)),
                h("button", {
                  type: "button", className: "dce-iconbtn", title: withKey(t("jumpCode"), boundText("git.jumpToSource", { code: "F4" })), onClick: jumpDiff
                }, t("jumpCode")))
              : h("div", { className: "dce-docbar" },
                dirty ? h("span", { className: "dce-dirty" }) : null,
                h("span", { className: "dce-path" }, doc === null ? t("empty") : doc.rel),
                isMd ? h("button", {
                  type: "button", className: "dce-iconbtn", "data-mdview": mdPreview ? "preview" : "edit",
                  title: mdPreview ? t("mdSource") : t("mdPreview"), onClick: toggleMdView
                }, mdPreview ? t("edit") : t("preview")) : null,
                treeOpen ? null : h("button", {
                  type: "button", className: "dce-iconbtn", title: t("locate"), "aria-label": t("locate"),
                  disabled: doc === null, onClick: revealInTree
                }, h(ToolIcon, { name: "locate" })),
                h("button", {
                  type: "button", className: "dce-iconbtn", disabled: !dirty,
                  title: saveTip, "aria-label": saveTip, onClick: save
                }, t("save"))),
            find.open && activeDiff === null && !mdPreview ? h("div", { className: "dce-find" },
              h("input", {
                ref: findRef, value: find.query, placeholder: t("find"),
                onChange: (event) => setFind({ open: true, query: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === "Escape") { setFind((prev) => ({ ...prev, open: false })); return; }
                  if (event.key === "Enter") { event.preventDefault(); jump(event.shiftKey === true); }
                }
              })) : null,
            activeDiff !== null
              ? renderDiff(activeDiff)
              : doc !== null && doc.image
                ? h("div", { className: "dce-imgscroll" },
                  h("img", { className: "dce-img", src: doc.image, alt: doc.rel }))
              : doc === null || doc.binary
                ? h("div", { className: "dce-blank" }, doc === null ? t("empty") : doc.note)
                : mdPreview
                ? h("div", { className: "dce-mdscroll", ref: mdScrollRef, onClick: copyCode },
                  h("div", { className: "dce-md", dangerouslySetInnerHTML: { __html: mdHtml } }))
                : h("div", { className: "dce-editor" },
                h("pre", { ref: gutterRef, className: "dce-gutter", style: { width: Math.max(36, String(lines).length * 8 + 16) } }, gutter),
                h("div", {
                  className: "dce-scroller", ref: scrollerRef,
                  onScroll: () => { if (gutterRef.current && scrollerRef.current) gutterRef.current.scrollTop = scrollerRef.current.scrollTop; }
                },
                  h("pre", { ref: paintRef, className: "dce-paint", dangerouslySetInnerHTML: { __html: painted === "" ? "\n" : painted } }),
                  flash !== null ? h("div", { key: flash.id, className: "dce-flashline", style: { top: flash.top + "px", height: flash.height + "px" } }) : null,
                  h("textarea", {
                    ref: inputRef, className: "dce-input", value: doc.text, spellCheck: false,
                    autoCapitalize: "off", autoCorrect: "off", wrap: "off",
                    onChange: (event) => {
                      const pos = event.target.selectionStart;
                      caretRef.current = pos;
                      if (status !== "") showStatus("");
                      setDoc({ ...doc, text: event.target.value });
                    },
                    onKeyDown: (event) => {
                      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                        event.preventDefault();
                        const el = event.target;
                        const start = el.selectionStart;
                        const end = el.selectionEnd;
                        const next = doc.text.slice(0, start) + "\t" + doc.text.slice(end);
                        caretRef.current = start + 1;
                        setDoc({ ...doc, text: next });
                      }
                    },
                    onKeyUp: syncCaret, onSelect: syncCaret,
                    onClick: (event) => {
                      syncCaret();
                      const mod = IS_MAC ? event.metaKey === true : event.ctrlKey === true;
                      if (!mod || event.altKey || event.shiftKey) return;
                      event.preventDefault();
                      popupAt.current = { x: event.clientX, y: event.clientY };
                      gotoSymbol("goToDefinition");
                    }
                  }))),
            popup ? h("div", {
              className: "dce-popup",
              style: { left: Math.max(8, popup.x), top: Math.max(8, popup.y) }
            }, popup.items.map((loc, i) => h("button", {
              key: loc.rel + ":" + loc.line + ":" + i,
              type: "button",
              className: "dce-popitem" + (i === popup.selected ? " dce-on" : ""),
              onClick: () => { setPopup(null); land(loc); }
            },
              h("span", { className: "dce-popkind" }, loc.kind === "class" ? t("kindClass") : loc.kind === "interface" ? t("kindInterface") : loc.kind === "enum" ? t("kindEnum") : t("kindCall")),
              h("span", { className: "dce-poptext" }, (loc.text || loc.rel.split("/").pop()) + "  " + loc.rel + ":" + (loc.line + 1))))) : null)),
          h("div", { className: "dce-status" },
            activeDiff !== null
              ? h("span", null, t("diffTab"))
              : doc !== null && doc.image
                ? h("span", null, t("image"))
              : mdPreview
                ? h("span", null, t("preview"))
                : h("span", null, t("line") + " " + caret.line),
            activeDiff !== null || mdPreview || (doc !== null && doc.image) ? null : h("span", null, t("col") + " " + caret.col),
            doc !== null && !doc.binary ? h("span", null, doc.text.length + " " + t("chars")) : null,
            status !== "" ? h("span", { className: statusOk ? "" : "dce-err" }, status) : null,
            h("span", { className: "dce-gap" }),
            h("button", {
              type: "button",
              className: "dce-modebtn",
              title: t("openModeHint"),
              "aria-label": (openModeState === "push" ? t("openModePush") : t("openModeFullscreen")) + ". " + t("openModeHint"),
              onClick: () => {
                const next = openModeState === "push" ? "fullscreen" : "push";
                try { window.localStorage.setItem(OPEN_MODE_KEY, next); } catch {}
                try { window.dispatchEvent(new CustomEvent("dsh-open-mode", { detail: next })); } catch {}
                setOpenModeState(next);
                const seat = columnSeat();
                if (seat === undefined) return;
                try { if (typeof seat.actions.setMode === "function") seat.actions.setMode(seat.sessionId, next); } catch {}
                try { if (typeof seat.actions.setExpanded === "function") seat.actions.setExpanded(seat.sessionId, true); } catch {}
              }
            }, openModeState === "push" ? t("openModePush") : t("openModeFullscreen")),
            h("button", {
              type: "button",
              className: "dce-keysbtn",
              ref: keysBtnRef,
              "data-on": keysOpen ? "true" : "false",
              title: t("keys"),
              "aria-label": t("keys"),
              "aria-expanded": keysOpen ? "true" : "false",
              onClick: () => {
                setKeysOpen((open) => !open);
                setRecordingId(null);
                setKeysNote("");
              }
            }, h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
              h("rect", { x: "1.6", y: "3.2", width: "12.8", height: "9.6", rx: "1.6", stroke: "currentColor", strokeWidth: "1.3" }),
              h("path", { d: "M4 8.2h2.2M7 8.2h2M10 8.2h2M5 10.4h6", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }))),
            gitReady ? h("button", {
              type: "button",
              className: "dce-gitbtn",
              "data-on": dockOn ? "true" : "false",
              title: gitTip,
              "aria-label": gitTip,
              onClick: () => {
                const api = window.__dshGitPanel;
                if (api !== undefined && api !== null && typeof api.toggle === "function") api.toggle();
              }
            }, "Git") : null,
            activeDiff !== null ? h("span", null, t("readOnly")) : null,
            doc !== null && !doc.binary ? h("button", { type: "button", title: t("eol"), "aria-label": t("eol") + " " + eolLabel, onClick: cycleEol }, eolLabel) : null,
            doc !== null && !doc.image ? h("span", null, t("utf8")) : null,
            doc !== null ? h("span", null, doc.lang.label) : null),
          renderKeys(),
          h("div", { className: "dce-gitsplit", onPointerDown: onGitDrag, title: gitTip }),
          h("div", { className: "dce-gitpane", ref: gitPaneRef, style: { height: gitH } }));
      }

      const isSave = (event) => {
        if (event.code !== "KeyS" || event.altKey || event.shiftKey || event.repeat === true) return false;
        if (IS_MAC) return event.metaKey === true && event.ctrlKey !== true;
        return event.ctrlKey === true && event.metaKey !== true;
      };
      const isFind = (event) => {
        if (event.code !== "KeyF" || event.altKey || event.shiftKey || event.repeat === true) return false;
        if (IS_MAC) return event.metaKey === true && event.ctrlKey !== true;
        return event.ctrlKey === true && event.metaKey !== true;
      };
      const isClose = (event) => {
        if (event.code !== "KeyW" || event.altKey || event.shiftKey || event.repeat === true) return false;
        if (IS_MAC) return event.metaKey === true && event.ctrlKey !== true;
        return event.ctrlKey === true && event.metaKey !== true;
      };
      const foreignField = () => {
        const el = document.activeElement;
        if (el === null || el === undefined) return false;
        if (typeof el.closest === "function" && el.closest(".dce-root") !== null) return false;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
      };
      const onEditKey = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (!editorVisible() || event.isComposing === true) return;
        if (isSave(event) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.save();
          return;
        }
        if (isFind(event) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.find();
          return;
        }
        if (held("editor.definition", DEFINITION, event) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.goto("goToDefinition");
          return;
        }
        if (held("editor.references", REFERENCES, event) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.goto("findReferences");
          return;
        }
        if (held("editor.implementation", IMPLEMENTATION, event) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.goto("goToImplementation");
          return;
        }
        if ((held("editor.back", BACK, event) || chordMatches(LEGACY_BACK, event, [])) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.back();
          return;
        }
        if (held("editor.forward", FORWARD, event) && !foreignField()) {
          event.preventDefault();
          event.stopPropagation();
          docApi.forward();
          return;
        }
        if (isClose(event) && window.__dshFilesCloseOwned !== true) {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          docApi.closeDoc();
        }
      };
      window.addEventListener("keydown", onEditKey, true);
      window.__dshEditorHotkeys = {
        closeDoc: () => docApi.closeDoc(),
        save: () => docApi.save(),
        goto: (operation) => { if (typeof docApi.goto === "function") docApi.goto(operation); },
        back: () => { if (typeof docApi.back === "function") docApi.back(); },
        forward: () => { if (typeof docApi.forward === "function") docApi.forward(); },
        revealLine: (line) => { if (typeof docApi.revealLine === "function") docApi.revealLine(line); },
        currentFile: () => (typeof docApi.currentFile === "function" ? docApi.currentFile() : null)
      };
      const bootChunk = async (file) => {
        try {
          const mod = await require.async("./" + file);
          if (mod !== null && mod !== undefined && typeof mod.apply === "function") mod.apply(ctx);
        } catch (err) {
          console.error("dsh-idea: " + file, err);
        }
      };
      bootChunk("client.nav.js");
      bootChunk("client.git.js");

      ctx.effect(() => () => {
        window.removeEventListener("keydown", onEditKey, true);
        try { delete window.__dshEditorPanel; delete window.__dshEditorHotkeys; } catch {}
        if (window.__dshIdeaKeys === ideaKeys) {
          try { delete window.__dshIdeaKeys; } catch { window.__dshIdeaKeys = undefined; }
        }
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "dsh-idea-client";
    return module.exports;
  }
});
