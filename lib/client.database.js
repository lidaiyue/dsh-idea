// dsh-idea — database explorer (browser half).
//
// Merged from dsh-database and loaded as a boot chunk of dsh-idea. The page
// can require react, nothing else, so the workspace still lives in one loader
// factory. Tab id, API prefix, localStorage keys, and credential scope stay
// the dsh-database ones so an existing install keeps working. CodeMirror is
// loaded only for the SQL console via lib/database/vendor/codemirror.js and
// the isolated `__ddbCodeMirror` global — it does not replace the idea editor.
//
// This file is served to the page verbatim: there is no build step for a DSH
// plugin and the module whitelist only exposes react / react-dom, so the whole
// client lives inside one loader factory closure. It is therefore deliberately
// NOT split into modules — that would mean adding a bundler to a package whose
// install path is `npm install` + serve. The section index below is the
// navigational substitute; keep it in step when adding a section.
//
// Sections, in file order:
//   ~53      constants (ids, storage keys, bounds, type list)
//   ~91      keyboard chords: defaults, rebinding bridge, matchers
//   ~234     I18N (zh / en)
//   ~479     STYLE — every CSS rule for the workspace
//   ~807     icons and glyphs
//   ~910     connection-dialog defaults (per-type port/user/database)
//   ~941     small pure helpers (node keys, value compare, SQL literal quoting)
//   ~1129    apply(ctx) — the plugin entry point; everything below is inside it
//   ~1588    openTab(dsh-database|database) silently opens idea; no host tab/guide
//   ...      console store, tree cache, tabs, dialogs, schema picker
//   ~3016 GridRow — one memoised grid row
//   ~3093 EditableGrid — the result grid
//   ~3249 BottomPanel — result toolbar, search, pager, row menu
//   ~3803 CodeMirror loader, dialects, SqlEditor
//   ~4076 SqlPage — the console page
//   ~4229 StructurePopover — F1 table structure
//   ~4399 ExplorerBody — tree, dock, context menus, drag-to-reorder
window.__ModuleLoader__.load({
  id: "dsh-idea",
  chunk: "client.database.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let React = require("react");
    if (React === null || typeof React !== "object") throw new Error("dsh-idea: database client: react is unavailable");
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
            unmount: () => { try { rd.unmountComponentAtNode(el); } catch {} },
          });
        }
      }
    } catch {}
    const portalTo = (node, el) => {
      if (!el || node == null || typeof createPortal !== "function") return null;
      return createPortal(node, el);
    };

    const PLUGIN = "dsh-database";
    const EXPLORER_ID = "dsh-database";
    const EXPLORER_KIND = "database";
    const API = "/plugins/dsh-database";
    const TREE_W_KEY = "dsh.database.treew";
    const TREE_CLOSED_KEY = "dsh.database.treeclosed";
    const DOCK_H_KEY = "dsh.database.dockh";
    const CONSOLES_KEY = "dsh.database.consoles";
    const CLOSED_KEY = "dsh.database.closedconsoles";
    const ORDER_KEY = "dsh.database.connorder";
    // Shared with dsh-idea: "fullscreen" pins the column over the
    // conversation when the database opens, "push" keeps the ordinary split
    // width. Default fullscreen = the behavior before this preference existed.
    const OPEN_MODE_KEY = "dsh.rightcolumn.openmode";
    const DEFAULT_TREE_W = 260;
    const DEFAULT_DOCK_H = 0.58;
    const PAGE_SIZE = 50;
    const ROW_LIMITS = [50, 100, 200, 500, 1000, 5000];
    const MAX_ROWS_KEY = "dsh.database.maxrows";
    const DEFAULT_MAX_ROWS = 500;
    const CLOSED_MAX = 30;
    const TYPES = ["postgres", "mysql", "oracle", "redis"];

    // ---------------------------------------------------------------------
    // Rebindable chords. This plugin owns the catalog, the persistence and the
    // footer editor. Nothing here reads dsh-keyboard-shortcuts.
    // ---------------------------------------------------------------------
    const detectMac = () => {
      try {
        if (window.navigator.userAgentData !== undefined && window.navigator.userAgentData.platform === "macOS") return true;
      } catch {}
      try { return /Macintosh|Mac OS X/i.test(window.navigator.userAgent); } catch {}
      return false;
    };
    const IS_MAC = detectMac();

    const DB_CHORDS = IS_MAC
      ? {
        "database.toggle": { ctrl: false, alt: false, shift: false, meta: true, code: "Digit2" },
        "database.structure": { ctrl: false, alt: false, shift: false, meta: false, code: "F1" },
        "database.runSql": { ctrl: false, alt: false, shift: false, meta: true, code: "Enter" },
        // Same chord the host uses for the column's own fullscreen toggle. This
        // plugin registers it only on a runtime where the host did not, so the
        // editor and tree do not lose the shortcut (see the handler in apply()).
        // `alt` is part of the binding, not decoration: `match()` compares the
        // whole modifier set, so a spec without it never fires on ⌥.
        "database.fullscreen": { ctrl: false, alt: true, shift: false, meta: true, code: "Enter" },
        "database.close": { ctrl: false, alt: false, shift: false, meta: true, code: "KeyW" }
      }
      : {
        "database.toggle": { ctrl: true, alt: false, shift: false, meta: false, code: "Digit2" },
        "database.structure": { ctrl: false, alt: false, shift: false, meta: false, code: "F1" },
        "database.runSql": { ctrl: true, alt: false, shift: false, meta: false, code: "Enter" },
        "database.fullscreen": { ctrl: true, alt: true, shift: false, meta: false, code: "Enter" },
        "database.close": { ctrl: true, alt: false, shift: false, meta: false, code: "KeyW" }
      };

    const DB_COMMANDS = [
      {
        id: "database.toggle",
        group: "database",
        order: 5,
        labels: { zh: "显示或隐藏数据库工具窗口", en: "Show or hide the database tool window" },
        default: DB_CHORDS["database.toggle"]
      },
      {
        id: "database.structure",
        group: "database",
        order: 10,
        labels: { zh: "查看表结构", en: "Describe the selected table" },
        default: DB_CHORDS["database.structure"]
      },
      {
        id: "database.runSql",
        group: "database",
        order: 20,
        labels: { zh: "运行选中的 SQL / 提交表数据", en: "Run the selected SQL / commit table edits" },
        default: DB_CHORDS["database.runSql"]
      },
      {
        id: "database.fullscreen",
        group: "database",
        order: 30,
        labels: { zh: "全屏显示/还原右侧栏", en: "Fullscreen the right column" },
        default: DB_CHORDS["database.fullscreen"]
      },
      {
        id: "database.close",
        group: "database",
        order: 40,
        labels: { zh: "关闭当前控制台", en: "Close the current console" },
        default: DB_CHORDS["database.close"]
      }
    ];

    // Bindings live in dsh-idea's catalog (`dsh.idea.keys`). The idea chunk
    // also reads `dsh.database.keys` and `dsh.keyboard-shortcuts.keys` once so
    // a chord rebound in the standalone plugin still answers after the merge.
    const DB_KEYS_KEY = "dsh.database.keys";
    const ideaKeys = () => {
      try {
        const api = window.__dshIdeaKeys;
        return api !== undefined && api !== null && typeof api.match === "function" ? api : null;
      } catch { return null; }
    };
    const dbKeys = {
      commands: () => {
        const api = ideaKeys();
        if (api !== null && typeof api.commands === "function") {
          const rows = api.commands().filter((cmd) => cmd.group === "database" || (typeof cmd.id === "string" && cmd.id.indexOf("database.") === 0));
          if (rows.length) return rows;
        }
        return DB_COMMANDS.slice();
      },
      has: (id) => {
        const api = ideaKeys();
        if (api !== null && typeof api.has === "function") return api.has(id) === true;
        return DB_COMMANDS.some((cmd) => cmd.id === id);
      },
      binding: (id) => {
        const api = ideaKeys();
        if (api !== null && typeof api.binding === "function") {
          try {
            if (typeof api.has !== "function" || api.has(id) === true) {
              const bound = api.binding(id);
              if (bound !== undefined) return bound;
            }
          } catch {}
        }
        return DB_CHORDS[id];
      },
      set: (id, spec) => {
        const api = ideaKeys();
        if (api !== null && typeof api.set === "function") api.set(id, spec);
      },
      reset: (id) => {
        const api = ideaKeys();
        if (api !== null && typeof api.reset === "function") api.reset(id);
      },
      match: (id, event, codes) => {
        const api = ideaKeys();
        if (api !== null && typeof api.match === "function") {
          try {
            if (typeof api.has !== "function" || api.has(id) === true) {
              return api.match(id, event, Array.isArray(codes) ? codes : []) === true;
            }
          } catch {}
        }
        return dbChordMatches(DB_CHORDS[id], event, Array.isArray(codes) ? codes : []);
      },
      subscribe: (fn) => {
        const api = ideaKeys();
        if (api !== null && typeof api.subscribe === "function") return api.subscribe(fn);
        return () => {};
      }
    };

    // Whether `spec` describes the chord this event carries. `codes` lists every
    // other physical code the same keycap can produce — the numpad Enter beside
    // the main one. An alternate code counts only when the pressed key *and* the
    // bound key are both members of that list, so a chord bound to another key
    // never fires on the alias.
    const dbChordMatches = (spec, event, codes) => {
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

    // Whether the event carries the chord currently bound to `id`. `codes` lets a
    // caller accept alternate keycaps for the same physical key — the SQL
    // textarea sees `Enter` on both the main and the numpad key.
    //
    // Deliberately never probes by rewriting `event.code` while keeping the
    // event's own modifiers: a bare modifier press (`MetaLeft`, `ShiftLeft`) is a
    // keydown too, and would then satisfy every chord whose modifier flags line
    // up — simply holding ⌘ would run the console's SQL. The pressed code must
    // itself belong to the alias list.
    const dbChordHeld = (id, event, codes) => {
      const aliases = Array.isArray(codes) ? codes : [];
      try {
        if (dbKeys.has(id)) return dbKeys.match(id, event, aliases) === true;
      } catch {}
      return dbChordMatches(DB_CHORDS[id], event, aliases);
    };

    // A short keycap label. Tooltips append it in parentheses so a rebound chord
    // shows up on the button that runs it, not only on the settings page.
    const formatChord = (spec) => {
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
        parts.push(code === "Escape" ? "Esc" : code.indexOf("Key") === 0 ? code.slice(3) : code.indexOf("Digit") === 0 ? code.slice(5) : code);
      }
      return parts.join(IS_MAC ? "" : "+");
    };
    const boundChord = (id, fallback) => {
      let spec = fallback;
      try {
        if (dbKeys.has(id)) {
          const bound = dbKeys.binding(id);
          if (bound !== undefined) spec = bound;
        }
      } catch {}
      return formatChord(spec);
    };
    const dbChordLabel = (id) => boundChord(id, DB_CHORDS[id]);
    const withKey = (label, key) => (key ? label + " (" + key + ")" : label);
    const closeChord = () => dbChordLabel("database.close");
    const copyChord = () => (IS_MAC ? "⌘C" : "Ctrl+C");

    // ⌘F / Ctrl+F focuses the search box under the caret. Not a catalog chord:
    // it has to be the binding the browser already uses for find, and it only
    // claims the key while focus is inside the SQL editor or the result pane.
    const FIND_KEY = IS_MAC ? "⌘F" : "Ctrl+F";
    const isPlainFindKey = (event) => {
      if (!event || event.isComposing === true || event.repeat === true) return false;
      if (event.altKey || event.shiftKey) return false;
      if (event.code !== "KeyF") return false;
      if (IS_MAC) return event.metaKey === true && event.ctrlKey !== true;
      return event.ctrlKey === true && event.metaKey !== true;
    };
    const focusFindInput = (input) => {
      if (!input || typeof input.focus !== "function") return false;
      input.focus();
      try { input.select(); } catch {}
      return true;
    };

    const I18N = {
      zh: {
        typeLabel: "数据库",
        guideTitle: "数据库",
        guideDescription: "浏览连接、库表并执行查询",
        add: "新建连接",
        refresh: "刷新",
        filter: "筛选连接、库、表或注释",
        empty: "还没有数据库连接",
        emptyHint: "点击左上角 + 添加 PostgreSQL / MySQL / Oracle / Redis",
        loading: "加载中…",
        error: "加载失败",
        save: "保存",
        cancel: "取消",
        test: "测试连接",
        testing: "测试中…",
        edit: "编辑连接",
        remove: "删除连接",
        console: "SQL 控制台",
        run: "运行",
        stop: "停止",
        rowLimit: "行数上限",
        rowLimitN: "{n} 行",
        submitHint: "{run} 提交",
        sqlPlaceholder: "输入 SQL，或 Redis 命令（如 GET key）",
        sqlNoConn: "还没有数据库连接。先在数据库工具窗口里添加一个，再运行脚本。",
        sqlFileUnsaved: "{file} 还没有绑定连接：在控制台里选好连接再运行",
        sqlFileMissing: "找不到 {file}",
        sqlFileRunsSaved: "每次运行都先读取文件，执行的是已保存的内容",
        noRows: "没有返回行",
        updatedRows: "已更新 {n} 行",
        insertedRows: "已插入 {n} 行",
        deletedRows: "已删除 {n} 行",
        affectedRows: "影响 {n} 行",
        executed: "已执行",
        rows: "行",
        truncated: "结果已截断",
        cellCut: "这一格太长，没能读全，已取消编辑以免写回截断值",
        cellLoadFail: "读取完整内容失败，已取消编辑",
        cellNoPk: "这一格被截断了，但当前结果没有主键，无法定位并读取完整值",
        cellMissing: "没找到这一行的完整值，可能已被删除，或主键不唯一",
        name: "名称",
        kind: "类型",
        host: "主机",
        port: "端口",
        user: "用户",
        password: "密码",
        database: "数据库 / 服务名",
        ssl: "SSL",
        sslUntrusted: "不校验服务器证书（自签名证书才勾）",
        instantClient: "Instant Client 路径（Oracle 老版本需要）",
        instantClientHint: "留空走 Thin 模式；连 12.2 以下的库时填 Instant Client 解压目录",
        hideBuiltinDatabases: "隐藏内置/管理数据库（postgres、template1、rdsadmin）",
        schemas: "显示的 Schema",
        schemasHint: "留空显示全部；勾选后树里只显示选中的 schema / 库",
        schemasReload: "重新加载",
        schemasPick: "选择…",
        schemasNone: "清空",
        schemasEmpty: "没有可选的 schema",
        schemasFailed: "加载失败",
        schemasManual: "也可直接输入名称后回车添加",
        schemasAdd: "添加",
        schemasRemove: "移除",
        schemasCount: "已选 {n} 项",
        passwordKeep: "留空则保留原密码",
        confirmDelete: "删除这个连接？",
        viewKey: "查看值",
        copyKey: "复制键名",
        deleteKey: "删除键",
        confirmDeleteKey: "删除这个键？此操作不可恢复。",
        deleteKeyNeedsRestart: "这个键名含空格，当前进程还没有删除接口。重启 dsh web 后再试。",
        testOk: "连接成功",
        submit: "提交",
        noPk: "没有主键，不能编辑",
        readOnlyQuery: "该查询含 JOIN，结果只读（仅可导出）",
        saved: "已保存",
        pickTable: "双击表以在底部预览 50 行",
        collapseTree: "收起连接树", expandTree: "展开连接树",
        keys: "快捷键",
        keysHint: "点击按键录制，Esc 取消。清除后该命令不再响应。",
        keysRecording: "按下快捷键…",
        keysClear: "清除",
        keysReset: "默认",
        keysBare: "请加上 Ctrl、⌘ 或 Alt",
        keysReserved: "这个组合被浏览器占用",
        keysConflict: "与「{name}」冲突",
        openConsoleHint: "打开 SQL 控制台，或双击左侧表预览数据",
        exp: "导出",
        imp: "导入",
        confirmDestructive: "导入内容包含会删除数据或表的语句（DROP / TRUNCATE），确认执行？",
        addRow: "新增行",
        pageAll: "全部",
        pagePrev: "上一页",
        pageNext: "下一页",
        selRows: "已选 {n} 行",
        clearSel: "取消选择",
        copy: "复制",
        copyInsert: "复制 INSERT 语句",
        confirmSql: "确认执行",
        confirmSqlHint: "将执行以下 SQL，确认后再提交。",
        nothingToSubmit: "没有要提交的更改",
        closeTab: "关闭",
        closeAllTabs: "关闭全部",
        collapseDock: "收起结果面板",
        setNull: "设为 NULL",
        clear: "清空",
        pinResult: "固定，之后的查询不覆盖",
        unpinResult: "取消固定",
        delete: "删除",
        deleteConsole: "删除控制台",
        confirmDeleteConsole: "删除这个控制台？它会从「已关闭的控制台」记录里一并抹掉，无法再恢复。",
        refreshResult: "刷新结果",
        searchResultPlaceholder: "搜索结果…",
        searchMatches: "{n} 行匹配",
        searchNoMatch: "无匹配",
        searchSqlPlaceholder: "搜索 SQL…",
        searchSqlHint: "{key} 聚焦，回车定位下一处，Shift+回车上一处",
        searchResultHint: "{key} 聚焦，回车下一条，Shift+回车上一条",
        searchSqlHits: "{n} 处",
        searchSqlPos: "{i}/{n}",
        replaceToggle: "替换",
        replacePlaceholder: "替换为…",
        replaceOne: "替换",
        replaceAll: "全部替换",
        replaceDone: "已替换 {n} 处",
        replaceNone: "没有可替换的",
        replaceTooMany: "命中太多，先用更精确的搜索词",
        replaceHint: "回车替换当前一处并跳到下一处",
        pendingDel: "待删除，提交后生效",
        pickConn: "选择连接",
        pickDb: "选择数据库",
        pickDbOracle: "登录 Schema",
        newConsole: "新建 SQL 控制台",
        exportResult: "导出结果",
        rename: "重命名",
        closedConsoles: "已关闭的控制台",
        closedEmpty: "没有已关闭的控制台",
        closedClear: "清空记录",
        structure: "表结构",
        structureTable: "表",
        structureView: "视图",
        structureComment: "备注",
        structureEmpty: "没有列信息",
        structureClose: "关闭",
        openModeFullscreen: "默认全屏打开",
        openModePush: "默认分栏打开",
        openModeHint: "打开编辑器或数据库时，右栏默认全屏还是保持分栏。点此切换，马上生效。",
        errUnsupported: "不支持的数据库类型",
        errName: "请填写连接名称",
        errNotSql: "这个连接不能执行 SQL",
        errRedisTable: "Redis 没有表",
        errTable: "请指定表",
        errEmpty: "请输入命令",
        errNotRedis: "这不是 Redis 连接",
        errNothingExport: "没有可导出的内容",
        errImportLarge: "导入内容超过 4 MB",
        errEmptySql: "没有可执行的 SQL",
        errImportMany: "一次最多导入 2000 条语句",
        errEmptyKey: "键名不能为空",
        errBadDb: "Redis 库编号不合法",
        errIdent: "标识符不合法",
        errImportFailed: "导入失败",
        errDriver: "缺少 {label} 驱动（{spec}）：{detail}",
        errNotFound: "找不到",
        errConnection: "找不到这个连接",
        errBad: "请求不合法",
        errJson: "请求不是合法的 JSON",
        errTooLarge: "请求过大",
        errMedia: "不支持的请求类型",
        errTrusted: "请求未被信任",
        errMethod: "不支持的请求方法",
        fieldName: "字段",
        fieldType: "类型",
        fieldNullable: "可空",
        fieldDefault: "默认值",
        fieldComment: "注释",
        fieldPk: "主键",
        fieldNull: "是",
        fieldNotNull: "否",
      },
      en: {
        typeLabel: "Database",
        guideTitle: "Database",
        guideDescription: "Browse connections, tables, and run queries",
        add: "New connection",
        refresh: "Refresh",
        filter: "Filter connections, schemas, tables, or comments",
        empty: "No database connections yet",
        emptyHint: "Use + to add PostgreSQL / MySQL / Oracle / Redis",
        loading: "Loading…",
        error: "Failed to load",
        save: "Save",
        cancel: "Cancel",
        test: "Test connection",
        testing: "Testing…",
        edit: "Edit connection",
        remove: "Delete connection",
        console: "SQL console",
        run: "Run",
        stop: "Stop",
        rowLimit: "Row limit",
        rowLimitN: "{n} rows",
        submitHint: "{run} to Commit",
        sqlPlaceholder: "SQL, or a Redis command such as GET key",
        sqlNoConn: "No database connection yet. Add one in the database tool window, then run the script.",
        sqlFileUnsaved: "{file} has no connection yet: pick one in the console, then run",
        sqlFileMissing: "{file} not found",
        sqlFileRunsSaved: "Each run re-reads the file; the saved copy is what executes",
        noRows: "No rows returned",
        updatedRows: "Updated {n} rows",
        insertedRows: "Inserted {n} rows",
        deletedRows: "Deleted {n} rows",
        affectedRows: "{n} rows affected",
        executed: "Executed",
        rows: "rows",
        truncated: "Results truncated",
        cellCut: "This cell is too long to load in full, so it was not opened for editing",
        cellLoadFail: "Could not load the full value, so the cell was not opened",
        cellNoPk: "This cell was truncated, but the result has no primary key to locate the full value",
        cellMissing: "Could not find the full value for this row — it may have been deleted, or the key is not unique",
        name: "Name",
        kind: "Type",
        host: "Host",
        port: "Port",
        user: "User",
        password: "Password",
        database: "Database / service",
        ssl: "SSL",
        sslUntrusted: "Do not verify the server certificate (self-signed only)",
        instantClient: "Instant Client path (needed by older Oracle)",
        instantClientHint: "Blank uses Thin mode; set an Instant Client directory for servers below 12.2",
        hideBuiltinDatabases: "Hide built-in / management databases (postgres, template1, rdsadmin)",
        schemas: "Visible schemas",
        schemasHint: "Leave empty to show everything; pick schemas to limit the tree",
        schemasReload: "Reload",
        schemasPick: "Choose…",
        schemasNone: "Clear",
        schemasEmpty: "No schemas available",
        schemasFailed: "Failed to load",
        schemasManual: "Or type a name and press Enter",
        schemasAdd: "Add",
        schemasRemove: "Remove",
        schemasCount: "{n} selected",
        passwordKeep: "Leave blank to keep the current password",
        confirmDelete: "Delete this connection?",
        viewKey: "View value",
        copyKey: "Copy key name",
        deleteKey: "Delete key",
        confirmDeleteKey: "Delete this key? This cannot be undone.",
        deleteKeyNeedsRestart: "This key name contains a space, and the running process has no delete route yet. Restart dsh web and try again.",
        testOk: "Connected",
        submit: "Commit",
        noPk: "No primary key — editing disabled",
        readOnlyQuery: "This query joins tables — result is read-only (export only)",
        saved: "Saved",
        pickTable: "Double-click a table to preview 50 rows below",
        collapseTree: "Collapse the connection tree", expandTree: "Expand the connection tree",
        keys: "Shortcuts",
        keysHint: "Click a binding to record it. Esc cancels. Clear unbinds the command.",
        keysRecording: "Press a shortcut…",
        keysClear: "Clear",
        keysReset: "Default",
        keysBare: "Add Ctrl, ⌘, or Alt",
        keysReserved: "The browser reserves that chord",
        keysConflict: "Conflicts with “{name}”",
        openConsoleHint: "Open a SQL console, or double-click a table to preview its data",
        exp: "Export",
        imp: "Import",
        confirmDestructive: "This import contains statements that delete data or tables (DROP / TRUNCATE). Run them?",
        addRow: "Insert",
        pageAll: "All",
        pagePrev: "Previous page",
        pageNext: "Next page",
        selRows: "{n} row(s) selected",
        clearSel: "Clear selection",
        copy: "Copy",
        copyInsert: "Copy as INSERT",
        confirmSql: "Confirm",
        confirmSqlHint: "The following SQL will run after you confirm.",
        nothingToSubmit: "Nothing to submit",
        closeTab: "Close",
        closeAllTabs: "Close all",
        collapseDock: "Collapse results panel",
        setNull: "Set NULL",
        clear: "Clear",
        pinResult: "Pin — later queries won't replace this",
        unpinResult: "Unpin",
        delete: "Delete",
        deleteConsole: "Delete console",
        confirmDeleteConsole: "Delete this console? It is also removed from the closed-console history and cannot be restored.",
        refreshResult: "Refresh results",
        searchResultPlaceholder: "Search results…",
        searchMatches: "{n} matching rows",
        searchNoMatch: "No match",
        searchSqlPlaceholder: "Search SQL…",
        searchSqlHint: "{key} focuses this box. Enter jumps to the next match, Shift+Enter to the previous",
        searchResultHint: "{key} focuses this box. Enter next match, Shift+Enter previous",
        searchSqlHits: "{n}",
        searchSqlPos: "{i}/{n}",
        replaceToggle: "Replace",
        replacePlaceholder: "Replace with…",
        replaceOne: "Replace",
        replaceAll: "Replace all",
        replaceDone: "Replaced {n}",
        replaceNone: "Nothing to replace",
        replaceTooMany: "Too many matches — narrow the search first",
        replaceHint: "Enter replaces this match and moves to the next",
        pendingDel: "Pending delete — submit to apply",
        pickConn: "Connection",
        pickDb: "Database",
        pickDbOracle: "Login schema",
        newConsole: "New SQL console",
        exportResult: "Export results",
        rename: "Rename",
        closedConsoles: "Closed consoles",
        closedEmpty: "No closed consoles",
        closedClear: "Clear list",
        structure: "Table structure",
        structureTable: "Table",
        structureView: "View",
        structureComment: "Comment",
        structureEmpty: "No column information",
        structureClose: "Close",
        openModeFullscreen: "Fullscreen by default",
        openModePush: "Split by default",
        openModeHint: "Default width when the editor or database opens: fullscreen, or the split column. Click to switch; it applies now.",
        errUnsupported: "Unsupported database type",
        errName: "Connection name is required",
        errNotSql: "This connection cannot run SQL",
        errRedisTable: "Redis has no tables",
        errTable: "Table is required",
        errEmpty: "Enter a command",
        errNotRedis: "This is not a Redis connection",
        errNothingExport: "Nothing to export",
        errImportLarge: "Import is larger than 4 MB",
        errEmptySql: "No SQL to run",
        errImportMany: "At most 2000 statements per import",
        errEmptyKey: "Key name is required",
        errBadDb: "Invalid Redis database index",
        errIdent: "Invalid identifier",
        errImportFailed: "Import failed",
        errDriver: "Missing {label} driver ({spec}): {detail}",
        errNotFound: "Not found",
        errConnection: "Connection not found",
        errBad: "Invalid request",
        errJson: "Request is not valid JSON",
        errTooLarge: "Request is too large",
        errMedia: "Unsupported request type",
        errTrusted: "Request was not trusted",
        errMethod: "Method not allowed",
        fieldName: "Column",
        fieldType: "Type",
        fieldNullable: "Nullable",
        fieldDefault: "Default",
        fieldComment: "Comment",
        fieldPk: "Primary key",
        fieldNull: "Yes",
        fieldNotNull: "No",
      },
    };

    const STYLE = [
      // Hosted in idea slots (tree / editor tabs / console page). Unused
      // standalone-page chrome is not rendered.
      ".ddb-root{height:100%;min-height:0;overflow:hidden;color:inherit;font-size:13px;flex-direction:column;flex:auto;line-height:1.5;display:flex;background:var(--dsw-alias-bg-base,#fff)}",
      ".ddb-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 10px;display:flex}",
      ".ddb-title{flex:auto;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);padding-left:6px}",
      ".ddb-worktabs{flex:auto;min-width:0;display:flex;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden}",
      ".ddb-worktab{flex:none;display:inline-flex;align-items:center;gap:4px;height:26px;max-width:160px;padding:0 8px;border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
      ".ddb-worktab.ddb-on{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform,#eef3f8));color:var(--dsw-alias-label-primary)}",
      ".ddb-tab-ico{display:inline-flex;align-items:center;flex:none;color:#3d6fd9}",
      ".ddb-tab-ico svg{width:12px;height:12px;display:block}",
      ".ddb-worktab-edit{cursor:default}",
      ".ddb-worktab-input{width:110px;height:20px;box-sizing:border-box;padding:0 6px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;outline:none}",
      ".ddb-main{flex:auto;min-height:0;min-width:0;display:flex;overflow:hidden}",
      ".ddb-tree-col{flex:auto;width:auto;min-width:0;max-width:none;display:flex;flex-direction:column;min-height:0;border-right:0}",
      // Invisible drag hit area, matching the host layout's splitter: the visual
      // separation comes from the tree column's own .5px border, so the handle itself
      // never paints — a solid accent bar on hover reads as a stray line.
      ".ddb-hsplit{flex:none;width:8px;cursor:ew-resize;margin-left:-4px;margin-right:-4px;z-index:2;background:transparent}",
      ".ddb-work-col{flex:auto;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".ddb-sql-page{flex:auto;min-height:0;height:100%;overflow:hidden;display:flex;flex-direction:column}",
      ".ddb-sql-tools{flex:none;display:flex;align-items:center;gap:2px;height:28px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex-wrap:nowrap;min-width:0}",
      ".ddb-sql-tools select{height:22px;max-width:180px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:0 6px;min-width:0}",
      ".ddb-sql-tools select:hover,.ddb-sql-tools select:focus{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-sql-tools .ddb-tool:disabled{opacity:.4;cursor:default}",
      ".ddb-sql-spacer{flex:auto;min-width:8px}",
      ".ddb-sql-find{flex:none;display:flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".ddb-sql-body{flex:auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".ddb-sql-editor{flex:auto;min-height:80px;display:flex;flex-direction:column;overflow:hidden}",
      ".ddb-sql-vsplit{flex:none;height:6px;cursor:ns-resize;margin-top:-3px;margin-bottom:-3px;z-index:2;background:transparent}",
      ".ddb-sql-results{flex:none;min-height:120px;max-height:70%;display:flex;flex-direction:column;overflow:hidden;border-top:.5px solid var(--dsw-alias-border-l3)}",
      ".ddb-sql-results .ddb-dock{flex:auto;height:auto;min-height:0;max-height:none;border-top:0}",
      // Same optical size as dsh-idea's tree-bar tools: 22px hit area, 14px stroke.
      ".ddb-tool{appearance:none;background:transparent;border:0;width:22px;height:22px;padding:0;line-height:0;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      ".ddb-tool svg{width:14px;height:14px;display:block}",
      ".ddb-tool:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-tool:disabled{opacity:.4;cursor:default;background:transparent}",
      ".ddb-filter{flex:none;padding:6px 10px 4px;display:flex;align-items:center}",
      ".ddb-filter-box{flex:1;min-width:0;height:28px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-module-platform,#eef3f8);display:flex;align-items:center;gap:4px;padding:0 6px 0 8px}",
      ".ddb-filter-box:focus-within{border-color:var(--dsw-alias-brand-primary,rgba(61,111,217,.7))}",
      ".ddb-filter input{flex:1;min-width:0;height:26px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:0;outline:none}",
      ".ddb-filter-clear{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);width:18px;height:18px;padding:0;border-radius:4px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:12px;line-height:1}",
      ".ddb-filter-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-body{flex:auto;min-height:80px;padding:4px 0 8px 4px;overflow:auto;overflow-x:hidden}",
      ".ddb-dock{flex:none;height:var(--ddb-dock-h,58%);min-height:220px;max-height:82%;overflow:hidden;display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l3);position:relative;background:var(--dsw-alias-bg-base,#fff)}",
      ".dce-dbtree .ddb-tree-col{width:100%;max-width:none;flex:auto;min-width:0;border-right:0}",
      ".dce-dbtree .ddb-header{display:none!important}",
      ".dce-dbpane .ddb-dock{flex:auto;height:auto;min-height:0;max-height:none;border-top:0}",
      ".ddb-idea-shell[hidden]{display:none!important}",
      // Same treatment as the vertical splitter: the dock's own top border draws the
      // line, so the drag area stays invisible.
      ".ddb-dock-handle{position:absolute;top:-4px;left:0;right:0;height:8px;cursor:ns-resize;z-index:4;background:transparent}",
      ".ddb-tabs{flex:none;display:flex;align-items:center;gap:2px;min-height:32px;padding:4px 8px 0;overflow-x:auto;overflow-y:hidden}",
      ".ddb-tabs-gap{flex:auto}",
      ".ddb-dock-close{flex:none;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);width:22px;height:22px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:12px;margin-left:4px;margin-bottom:2px}",
      ".ddb-dock-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-tab{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 10px;border:0;border-radius:8px 8px 0 0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}",
      ".ddb-tab.ddb-on{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform,#eef3f8));color:var(--dsw-alias-label-primary)}",
      ".ddb-tab-title{white-space:nowrap}",
      ".ddb-worktab .ddb-tab-title{overflow:hidden;text-overflow:ellipsis}",
      ".ddb-tab-x{width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;line-height:16px;padding:0}",
      ".ddb-tab-x:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-tab-pin{width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      ".ddb-tab-pin:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-tab-pin.ddb-on{color:var(--dsw-alias-brand-primary,#3d6fd9)}",
      ".ddb-pane{flex:auto;min-height:0;overflow:hidden;display:flex;flex-direction:column}",
      ".ddb-empty{color:var(--dsw-alias-label-tertiary);padding:28px 16px;text-align:center;font-size:13px}",
      ".ddb-empty p{margin:0 0 6px}",
      ".ddb-hint{font-size:12px;line-height:1.5}",
      ".ddb-row{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:8px;align-items:center;gap:6px;padding:4px 8px;display:flex}",
      ".ddb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // Selection is not hover: a left bar stays visible when the pointer is on
      // another row, which is what makes keyboard movement readable.
      ".ddb-row.ddb-on{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#3d6fd9)}",
      ".ddb-row:focus{outline:none}",
      ".ddb-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3d6fd9);outline-offset:-2px}",
      // Drag-to-reorder feedback. The row being dragged dims, and a 2px accent
      // line above/below the row it would displace marks the landing slot. Both
      // anchor to the row itself: the `.ddb-node` wrapper also holds an expanded
      // connection's children, so a line on it would sit past them.
      ".ddb-node{position:relative}",
      ".ddb-row{position:relative}",
      ".ddb-row.ddb-grab{cursor:grab;touch-action:none}",
      ".ddb-dragging>.ddb-row{opacity:.45;cursor:grabbing}",
      ".ddb-drop-before:before,.ddb-drop-after:after{content:\"\";position:absolute;left:6px;right:6px;height:2px;border-radius:1px;background:var(--dsw-alias-brand-primary,#3d6fd9);pointer-events:none;z-index:2}",
      ".ddb-drop-before:before{top:-1px}",
      ".ddb-drop-after:after{bottom:-1px}",
      ".ddb-chev{width:12px;height:12px;flex:none;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center}",
      ".ddb-chev svg{transition:transform .12s}",
      ".ddb-open .ddb-chev svg{transform:rotate(90deg)}",
      ".ddb-ico{width:14px;height:14px;flex:none;display:flex}",
      // Name stays content-sized until a comment is present, then it caps so the
      // comment (the grey tail) keeps a share of the row and both ellipsize.
      ".ddb-name{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden;flex:1 1 auto}",
      ".ddb-row:has(.ddb-cmt) .ddb-name{flex:0 1 auto;max-width:62%}",
      ".ddb-cmt{flex:1 1 auto;min-width:0;margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".ddb-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".ddb-note{color:var(--dsw-alias-label-tertiary);margin:0;padding:2px 10px 6px 34px;font-size:12px}",
      ".ddb-overlay{position:fixed;inset:0;z-index:260;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;background:rgba(16,18,22,.28)}",
      ".ddb-card{width:min(440px,100%);display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 18px 60px rgba(0,0,0,.22);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));overflow:hidden}",
      ".ddb-card h2{margin:0;padding:14px 16px 8px;font-size:15px;font-weight:600}",
      ".ddb-form{display:flex;flex-direction:column;gap:8px;padding:4px 16px 12px;max-height:min(62vh,560px);overflow:auto}",
      ".ddb-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".ddb-field input,.ddb-field select{height:32px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-module-platform,#eef3f8);color:inherit;font:inherit;font-size:13px;padding:0 10px;outline:none}",
      ".ddb-check{flex-direction:row;align-items:center;gap:8px}",
      // Schema picker inside the connection dialog: a bordered box that scrolls on its
      // own so a server with hundreds of schemas cannot stretch the card.
      ".ddb-schemas{border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-module-platform,#eef3f8);overflow:hidden;display:flex;flex-direction:column;min-height:0}",
      ".ddb-schemas-bar{display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));flex:none}",
      ".ddb-schemas-bar .ddb-lbl{flex:auto;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ddb-schemas-list{max-height:168px;overflow:auto;padding:3px}",
      ".ddb-schemas-list label{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:6px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".ddb-schemas-list label:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-schemas-list input{flex:none;margin:0}",
      ".ddb-schemas-list span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ddb-schemas-note{padding:8px 9px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}",
      ".ddb-schemas-chips{display:flex;flex-wrap:wrap;gap:4px;padding:5px 6px 0}",
      ".ddb-schemas-input{flex:auto;min-width:0;height:22px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:11.5px;padding:0 7px;outline:none}",
      ".ddb-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:22px;padding:0 3px 0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
      ".ddb-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ddb-chip button{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;width:16px;height:16px;line-height:1;padding:0;border-radius:999px;font-size:12px;flex:none}",
      ".ddb-chip button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary,#c44)}",
      ".ddb-mini{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-secondary);height:22px;padding:0 8px;border-radius:6px;font:inherit;font-size:11.5px;cursor:pointer}",
      ".ddb-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-mini:disabled{opacity:.5;cursor:default}",
      ".ddb-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px 14px;border-top:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06))}",
      ".ddb-btn{appearance:none;border:0;border-radius:8px;height:30px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer}",
      ".ddb-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary)}",
      ".ddb-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // The fill is the host's brand token, which the host INVERTS in dark mode
      // (`--dsw-alias-brand-primary` is near-white there, `#f9fafb`). A hardcoded
      // `#fff` label therefore painted white-on-white — 1.05:1, invisible. The
      // foreground is the matching pair token, which the host defines as the dark
      // ink that sits on that fill in either theme.
      ".ddb-btn-primary{background:var(--dsw-alias-brand-primary,#3d6fd9);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".ddb-btn:disabled{opacity:.55;cursor:default}",
      // Icon-only header actions: square, tight padding, no oversized hit area so the
      // glyph reads at the same optical size as the 12px label beside it.
      ".ddb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border-radius:6px;flex:none}",
      ".ddb-closed-btn{display:inline-flex;align-items:center;gap:4px;width:auto;padding:0 6px}",
      ".ddb-history-count{font-size:10.5px;line-height:1;padding:2px 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-variant-numeric:tabular-nums}",
      // Closed consoles: one line each, title then database/time. The SQL itself
      // is restored on click and is not previewed here.
      ".ddb-history-menu{width:280px;max-height:320px;overflow:auto;padding:0}",
      ".ddb-history-head{position:sticky;top:0;z-index:1;padding:8px 10px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));background:inherit}",
      ".ddb-history-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;border-radius:8px;padding:6px 10px;cursor:pointer}",
      ".ddb-history-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-history-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}",
      ".ddb-history-meta{flex:0 1 auto;max-width:58%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.4))}",
      ".ddb-history-empty{padding:12px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}",
      ".ddb-history-clear{position:sticky;bottom:0;width:100%;text-align:left;border:0;border-top:.5px solid var(--dsw-alias-border-l3);background:inherit;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:8px 10px;cursor:pointer;border-radius:0}",
      ".ddb-status{padding:0 16px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);min-height:16px}",
      // Shared open-mode switch, same pill as dsh-idea's status bar.
      ".ddb-foot{flex:none;height:26px;display:flex;align-items:center;gap:12px;padding:0 10px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".ddb-foot-gap{flex:auto}",
      ".ddb-modebtn{appearance:none;flex:none;height:18px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:600;line-height:18px;cursor:pointer}",
      ".ddb-modebtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-keysbtn{flex:none;width:18px;height:18px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}",
      ".ddb-keysbtn svg{width:12px;height:12px;display:block}",
      ".ddb-keysbtn:hover,.ddb-keysbtn[data-on=\"true\"]{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-keys{position:fixed;z-index:80;width:min(340px,calc(100vw - 16px));max-height:min(360px,calc(100vh - 24px));display:flex;flex-direction:column;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden}",
      ".ddb-keyshead{flex:none;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:13px;font-weight:600}",
      ".ddb-keyshint{flex:none;margin:0;padding:6px 12px 2px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}",
      ".ddb-keyslist{flex:auto;min-height:0;overflow:auto;padding:2px 0 8px}",
      ".ddb-keysrow{display:flex;align-items:center;gap:6px;min-height:28px;padding:2px 8px 2px 12px}",
      ".ddb-keysrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-keysname{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;padding:0}",
      ".ddb-keysbind{flex:none;max-width:130px;height:22px;padding:0 8px;border:0;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#eef1f5);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}",
      ".ddb-keysbind[data-on=\"true\"]{color:var(--dsw-alias-label-primary);outline:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.28))}",
      ".ddb-keysmini{flex:none;height:22px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}",
      ".ddb-keysmini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-keysnote{flex:none;margin:0;padding:0 12px 8px;font-size:11px;color:#c41a16}",
      ".ddb-status.ddb-bad{color:var(--dsw-alias-state-error-primary,#c44)}",
      ".ddb-status.ddb-ok{color:var(--dsw-alias-state-success-primary,#2a7)}",
      ".ddb-menu{position:fixed;z-index:270;min-width:168px;padding:6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.08));box-shadow:0 12px 40px rgba(0,0,0,.18)}",
      ".ddb-menu button{width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;border-radius:8px;padding:7px 10px;cursor:pointer}",
      ".ddb-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-sql{flex:auto;min-height:0;display:flex;flex-direction:column}",
      ".ddb-grid{flex:auto;min-height:0;overflow:auto}",
      ".ddb-grid table{border-collapse:collapse;font-size:12px;width:max-content;min-width:100%}",
      ".ddb-grid th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:.5px solid var(--dsw-alias-border-l3);padding:6px 8px;text-align:left;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px;cursor:pointer;user-select:none;vertical-align:top}",
      ".ddb-grid th:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // Two-line header: column name on top, its comment below in a smaller,
      // quieter font. The comment is absolutely positioned so it never takes part
      // in the column's width calculation — the column keeps the width its name
      // and data dictate, and a long comment just ellipsizes inside that width
      // (the full text stays available through the native title tooltip).
      ".ddb-grid th.ddb-has-cmt{padding-bottom:19px}",
      ".ddb-grid th .ddb-th-name{display:block;overflow:hidden;text-overflow:ellipsis}",
      ".ddb-grid th .ddb-th-cmt{position:absolute;left:8px;right:8px;bottom:5px;font-size:10.5px;line-height:1.4;font-weight:400;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));overflow:hidden;text-overflow:ellipsis}",
      ".ddb-grid th.ddb-th-on{background:rgba(61,111,217,.16)}",
      ".ddb-grid td{padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));max-width:360px;vertical-align:top;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}",
      ".ddb-grid td input{width:100%;min-width:0;max-width:100%;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;padding:0;outline:none;text-overflow:ellipsis}",
      ".ddb-grid td input:focus{background:var(--dsw-alias-bg-module-platform,#eef3f8)}",
      ".ddb-grid td textarea.ddb-cell-ta{width:100%;min-width:140px;min-height:44px;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary,#3d6fd9);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;padding:2px 4px;outline:none;resize:vertical;line-height:1.4}",
      ".ddb-grid tr.ddb-dirty td{background:rgba(61,111,217,.08)}",
      ".ddb-grid tr.ddb-new td{background:rgba(42,170,119,.08)}",
      ".ddb-grid tr.ddb-pick td{background:rgba(61,111,217,.16)}",
      ".ddb-grid tr.ddb-del td{opacity:.5;text-decoration:line-through}",
      ".ddb-grid tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-grid td.ddb-col-on,.ddb-grid th.ddb-th-on{background:rgba(61,111,217,.18)}",
      // The editor reads as an input surface, not as bare page background: a subtle
      // field fill, a hairline border and a brand focus ring, matching the tree filter
      // and connection-dialog fields it sits beside.
      // The file a console was opened from: one quiet line above the editor.
      ".ddb-filebar{flex:none;display:flex;align-items:center;gap:8px;padding:4px 12px 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".ddb-filebar-path{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".ddb-filebar-note{flex:none;margin-left:auto}",
      ".ddb-sql-wrap{flex:auto;min-height:0;position:relative;display:flex;overflow:hidden;margin:8px 10px 10px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));box-shadow:inset 0 1px 1px rgba(0,0,0,.02);transition:border-color .12s ease,box-shadow .12s ease}",
      ".ddb-sql-wrap:hover{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.16))}",
      ".ddb-sql-wrap:focus-within{border-color:var(--dsw-alias-brand-primary,#3d6fd9);box-shadow:0 0 0 3px rgba(61,111,217,.14)}",
      // Scoped to `.ddb-sql-fallback`, never to a bare `textarea`: CodeMirror creates
      // its own offscreen textarea under this subtree for clipboard capture, and a
      // descendant selector here would restyle it and break copy/paste.
      //
      // Absolutely positioned over the CodeMirror host rather than beside it: the host
      // stays full-size from the first paint, so the view is never constructed against
      // a zero-height box, and the fallback simply disappears once the view exists.
      ".ddb-sql-fallback{position:absolute;inset:0;z-index:1;box-sizing:border-box;margin:0;padding:10px 14px;border:0;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary);font:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:19px;tab-size:4;caret-color:var(--dsw-alias-link,#3d6fd9)}",
      ".ddb-sql-fallback::placeholder{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.34))}",
      // Syntax palette. Declared per element rather than on :root so it travels with
      // the editor, with the dark values swapped under the host's theme attribute.
      ".ddb-sql-wrap{--ddb-cm-keyword:#0033b3;--ddb-cm-type:#00627a;--ddb-cm-builtin:#7a3e9d;--ddb-cm-string:#067d17;--ddb-cm-number:#1750eb;--ddb-cm-comment:#8c8c8c;--ddb-cm-punct:#5c5c5c;--ddb-cm-ident:#1f1f1f;--ddb-cm-var:#9e3838;--ddb-cm-invalid:#d13438}",
      "body[data-ds-dark-theme] .ddb-sql-wrap{--ddb-cm-keyword:#cf8e6d;--ddb-cm-type:#56a8f5;--ddb-cm-builtin:#b3b3b3;--ddb-cm-string:#6aab73;--ddb-cm-number:#2aacb8;--ddb-cm-comment:#7a7e85;--ddb-cm-punct:#a9b7c6;--ddb-cm-ident:#a9b7c6;--ddb-cm-var:#c77dbb;--ddb-cm-invalid:#ff6b68}",
      // CodeMirror fills the wrap and owns its own scrolling, so the outer box stays
      // fixed and the gutter scrolls with the text.
      ".ddb-sql-host{flex:auto;min-height:0;display:flex;overflow:hidden;border-radius:inherit}",
      ".ddb-sql-host .cm-editor{flex:auto;min-height:0;width:100%;background:transparent;color:var(--dsw-alias-label-primary);font:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
      ".ddb-sql-host .cm-editor.cm-focused{outline:none}",
      ".ddb-sql-host .cm-scroller{flex:auto;min-height:0;overflow:auto;font-family:inherit;line-height:19px;padding:10px 0}",
      ".ddb-sql-host .cm-content{padding:0 14px;tab-size:4;caret-color:var(--dsw-alias-link,#3d6fd9)}",
      ".ddb-sql-host .cm-line{padding:0}",
      // The gutter reads as a quiet margin, not a second panel: no fill, no rule.
      ".ddb-sql-host .cm-gutters{flex:none;background:transparent;border-right:0;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.34));padding-left:10px;user-select:none}",
      ".ddb-sql-host .cm-lineNumbers .cm-gutterElement{min-width:22px;padding:0 6px 0 0}",
      ".ddb-sql-host .cm-activeLine{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}",
      ".ddb-sql-host .cm-activeLineGutter{background:transparent;color:var(--dsw-alias-label-secondary)}",
      ".ddb-sql-host .cm-cursor,.ddb-sql-host .cm-dropCursor{border-left-color:var(--dsw-alias-link,#3d6fd9)}",
      ".ddb-sql-host .cm-selectionBackground,.ddb-sql-host .cm-content ::selection{background:rgba(61,111,217,.35)}",
      ".ddb-sql-host .cm-editor.cm-focused .cm-selectionBackground{background:rgba(61,111,217,.45)}",
      // Dark theme: the same brand blue gets lost on a dark canvas, so the selection
      // switches to a lighter blue there, bright enough to read the text on top of it.
      "body[data-ds-dark-theme] .ddb-sql-host .cm-selectionBackground,body[data-ds-dark-theme] .ddb-sql-host .cm-content ::selection{background:rgba(88,133,235,.45)}",
      "body[data-ds-dark-theme] .ddb-sql-host .cm-editor.cm-focused .cm-selectionBackground{background:rgba(88,133,235,.55)}",
      ".ddb-sql-host .cm-placeholder{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.34));font-style:normal}",
      // Keyword completion popup: the one CodeMirror panel this editor can open, so it
      // is styled to match the plugin's own menus.
      ".ddb-sql-host .cm-tooltip{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.1));border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary)}",
      ".ddb-sql-host .cm-tooltip.cm-tooltip-autocomplete > ul{font:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;max-height:220px}",
      ".ddb-sql-host .cm-tooltip-autocomplete ul li{padding:3px 8px}",
      ".ddb-sql-host .cm-tooltip-autocomplete ul li[aria-selected]{background:var(--dsw-alias-interactive-bg-hover,rgba(61,111,217,.16));color:inherit}",
      ".ddb-sql-host .cm-completionLabel{color:var(--dsw-alias-label-primary)}",
      ".ddb-sql-host .cm-completionDetail{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-style:normal;margin-left:8px}",
      // Structure popover: shown with F1 for the table selected in the tree or console.
      // Sized to sit inside the right sidebar instead of covering most of it: a
      // fixed 880px was wider than the column it opens over. 640px keeps all five
      // columns readable (the table's own min-width is 520px) and the height cap
      // still shows ~14 rows before scrolling, so a wide table stays usable.
      ".ddb-struct{position:fixed;z-index:275;width:min(640px,calc(100vw - 32px));max-height:min(66vh,540px);display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.1));box-shadow:0 16px 48px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary)}",
      ".ddb-struct-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}",
      ".ddb-struct-name{flex:auto;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ddb-struct-tag{flex:none;font-size:10.5px;line-height:1;padding:3px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}",
      ".ddb-struct-sub{flex:none;padding:6px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));word-break:break-word}",
      ".ddb-struct-body{flex:auto;min-height:0;overflow:auto}",
      // Fixed layout with explicit shares: the column name and type size to their content,
      // 可空/默认值 are narrow and fixed, and every remaining pixel goes to the comment so
      // long Chinese notes wrap once instead of every few characters.
      ".ddb-struct table{border-collapse:collapse;width:100%;min-width:520px;font-size:12px;table-layout:fixed}",
      ".ddb-struct th:nth-child(1),.ddb-struct td:nth-child(1){width:22%}",
      ".ddb-struct th:nth-child(2),.ddb-struct td:nth-child(2){width:19%}",
      ".ddb-struct th:nth-child(3),.ddb-struct td:nth-child(3){width:7%}",
      ".ddb-struct th:nth-child(4),.ddb-struct td:nth-child(4){width:15%}",
      ".ddb-struct th:nth-child(5),.ddb-struct td:nth-child(5){width:37%}",
      ".ddb-struct th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);white-space:nowrap}",
      ".ddb-struct td{padding:5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));vertical-align:top}",
      ".ddb-struct tr:last-child td{border-bottom:0}",
      ".ddb-struct-col{font-weight:500;word-break:break-all}",
      ".ddb-struct-pk{color:var(--dsw-alias-link,#3d6fd9);margin-right:4px}",
      ".ddb-struct-type{font:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".ddb-struct-null{white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}",
      ".ddb-struct-def{font:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));word-break:break-all}",
      ".ddb-struct-cmt{color:var(--dsw-alias-label-secondary);word-break:break-word}",
      ".ddb-struct-empty{padding:16px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}",
      ".ddb-pager{flex:none;display:flex;align-items:center;gap:6px}",
      ".ddb-pager-info{font-variant-numeric:tabular-nums;margin-right:2px}",
      ".ddb-pager button{appearance:none;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.1));background:transparent;color:inherit;height:24px;min-width:24px;padding:0 8px;border-radius:6px;font:inherit;font-size:12px;cursor:pointer}",
      ".ddb-pager button:disabled{opacity:.4;cursor:default}",
      ".ddb-pre{margin:0;padding:10px 16px;max-height:40vh;overflow:auto;font:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all}",
      ".ddb-null{color:var(--dsw-alias-label-tertiary);font-style:italic}",
      // The result bar sits ABOVE the grid. `flex-wrap` lets the pager/search drop
      // to a second line on a narrow sidebar instead of squashing the status text.
      ".ddb-bar{flex:none;padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary);font-size:11px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      // Buttons follow the search box, so the grid's actions stay in the top-left area.
      ".ddb-bar-actions{flex:none;display:inline-flex;align-items:center;gap:2px}",
      ".ddb-bar-status{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ddb-bar-sel{flex:none;border:0;border-radius:6px;background:rgba(61,111,217,.12);color:var(--dsw-alias-link,#3d6fd9);font:inherit;font-size:11px;line-height:1;padding:4px 7px;cursor:pointer;font-variant-numeric:tabular-nums}",
      ".ddb-bar-sel:hover{background:rgba(61,111,217,.2)}",
      // In-result search controls. The box leads the bar (the old magnifier slot),
      // so it carries no left margin; matching is over the loaded page, not the
      // whole table, which is why the controls stay next to the grid.
      ".ddb-search{flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;gap:4px}",
      ".ddb-search-input{width:150px;min-width:76px;height:24px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:0 8px;outline:none}",
      ".ddb-search-input:focus{border-color:var(--dsw-alias-brand-primary,rgba(61,111,217,.7))}",
      ".ddb-search-count{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".ddb-search-none{color:var(--dsw-alias-link,#3d6fd9)}",
      ".ddb-search-step{appearance:none;border:0;background:transparent;color:inherit;height:22px;min-width:20px;padding:0 4px;border-radius:6px;font:inherit;font-size:12px;line-height:1;cursor:pointer}",
      ".ddb-search-step:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".ddb-search-step:disabled{opacity:.4;cursor:default}",
      // The replace toggle lights up while its box is open, so the field that
      // appeared beside it is explained by the button rather than by a label.
      ".ddb-search-step[data-on=\"true\"]{background:rgba(61,111,217,.16);color:var(--dsw-alias-brand-primary,#3d6fd9)}",
      // Replace opens inline, next to the find box: no second row, and the field
      // gives up width before the fixed-size steps and buttons do.
      ".ddb-replace-input{width:auto;flex:1 1 96px;min-width:68px;max-width:200px}",
      ".ddb-replace-btn{appearance:none;flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);height:22px;padding:0 7px;border-radius:6px;font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}",
      ".ddb-replace-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ddb-replace-btn:disabled{opacity:.4;cursor:default}",
      // Match highlighting. A non-matching row is dimmed rather than hidden, so the
      // grid keeps its shape and edits stay addressable; the current match gets an
      // accent bar on the leading edge.
      ".ddb-grid tr.ddb-hit-off td{opacity:.35}",
      ".ddb-grid tr.ddb-hit td{background:rgba(255,196,0,.14)}",
      ".ddb-grid tr.ddb-hit-cur td{background:rgba(255,196,0,.28)}",
      ".ddb-grid tr.ddb-hit-cur td:first-child{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#3d6fd9)}",
    ].join("\n");

    const h = React.createElement;

    const makeBus = (initial) => {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        set: (next) => {
          value = typeof next === "function" ? next(value) : next;
          for (const fn of listeners) {
            try { fn(); } catch {}
          }
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
      };
    };

    const useBus = (bus) => {
      const [value, setValue] = React.useState(bus.getSnapshot);
      React.useEffect(() => bus.subscribe(() => setValue(bus.getSnapshot())), [bus]);
      return value;
    };

    async function api(path, body) {
      const response = await fetch(API + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body || {}),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = value && value.error ? String(value.error) : "HTTP " + response.status;
        throw new Error(message);
      }
      // A 2xx without a parsable JSON body is a failure, not an empty success.
      // An intermediary can answer 200 with an HTML interstitial or an empty
      // body; returning `undefined` here made every caller's `value.items` throw
      // a TypeError *inside a .then()*, which surfaces only as an unhandled
      // rejection — the tree or the preview sat on its spinner with no message.
      // Throwing keeps the failure on the path callers already handle.
      if (value === undefined) {
        // `t()` is not in scope here (this helper sits above `apply`), so the
        // message is a literal. It is a diagnostic, not user-facing copy.
        throw new Error("invalid-response (HTTP " + response.status + ")");
      }
      return value;
    }

    const TYPE_COLOR = { postgres: "#336791", mysql: "#e48e00", oracle: "#f80000", redis: "#d82c20" };

    function CylinderIcon({ color, size }) {
      const s = size || 14;
      return h("svg", { width: s, height: s, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true },
        h("ellipse", { cx: "7", cy: "3.2", rx: "5.2", ry: "2.1", stroke: color, strokeWidth: "1.3" }),
        h("path", { d: "M1.8 3.2v7.4c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V3.2", stroke: color, strokeWidth: "1.3" }),
        h("path", { d: "M1.8 7.1c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1", stroke: color, strokeWidth: "1.2", opacity: ".85" }),
      );
    }
    function RedisIcon({ size }) {
      const s = size || 14;
      return h("svg", { width: s, height: s, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true },
        h("path", { d: "M2 4.2h10L7 1.6 2 4.2z", fill: "#d82c20" }),
        h("path", { d: "M2 4.2l5 2.6 5-2.6v5.2L7 12.4 2 9.4V4.2z", fill: "#a11c16", opacity: ".9" }),
      );
    }
    function TableIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true },
        h("rect", { x: "1.5", y: "2.5", width: "11", height: "9", rx: "1.4", stroke: "currentColor", strokeWidth: "1.2" }),
        h("path", { d: "M1.5 5.5h11M5.5 5.5v6", stroke: "currentColor", strokeWidth: "1.1" }),
      );
    }
    function SchemaIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true },
        h("path", { d: "M2.5 11.5V5.2l4.5-2.4 4.5 2.4v6.3H2.5z", stroke: "currentColor", strokeWidth: "1.2" }),
      );
    }
    function KeyIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true },
        h("circle", { cx: "5", cy: "7", r: "2.4", stroke: "currentColor", strokeWidth: "1.2" }),
        h("path", { d: "M7.2 7h4.2v2.2", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round" }),
      );
    }
    // Result-area header icons sit beside 12px text, so they are sized to match its
    // optical weight; the tree toolbar keeps the larger default.
    const ICON = 13;
    const ICON_TOOL = 15;
    function PlusIcon({ size }) {
      return h("svg", { width: size || ICON_TOOL, height: size || ICON_TOOL, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M8 3.2v9.6M3.2 8h9.6", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
      );
    }
    function CheckIcon() {
      return h("svg", { width: ICON, height: ICON, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M3.2 8.4l3.2 3.2 6.4-7.2", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }),
      );
    }
    function DownloadIcon() {
      return h("svg", { width: ICON, height: ICON, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M8 2.4v7.4", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
        h("path", { d: "M4.8 7l3.2 3.2L11.2 7", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M3.2 13.2h9.6", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
      );
    }
    // Clock-with-arrow: "reopen something from earlier".
    function HistoryIcon() {
      return h("svg", { width: ICON_TOOL, height: ICON_TOOL, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M2.9 8a5.1 5.1 0 1 0 1.6-3.7", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
        h("path", { d: "M2.6 2.6v2.6h2.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M8 5.4V8l2 1.3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
      );
    }
    function RunIcon() {
      return h("svg", { width: ICON_TOOL, height: ICON_TOOL, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
        h("path", { d: "M4.2 2.8v10.4L13 8 4.2 2.8z" }),
      );
    }
    function StopIcon() {
      return h("svg", { width: ICON_TOOL, height: ICON_TOOL, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
        h("rect", { x: "4.2", y: "4.2", width: "7.6", height: "7.6", rx: "1" }),
      );
    }
    function CloseIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
      );
    }
    function PinIcon({ on }) {
      return h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M6 2.4h4v3.1L11.6 8H4.4L6 5.5V2.4z", fill: on ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round" }),
        h("path", { d: "M8 8v5.4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
      );
    }
    function RefreshIcon() {
      return h("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M13 8a5 5 0 1 1-1.4-3.5", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
        h("path", { d: "M13 3.2V6.5H9.8", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
      );
    }
    // Same stroke as dsh-idea's tree-bar collapse. Text « does not share its size.
    function CollapseIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M10.2 3.4L5.6 8l4.6 4.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
      );
    }
    function Chevron() {
      return h("svg", { width: 10, height: 10, viewBox: "0 0 10 10", fill: "currentColor", "aria-hidden": true },
        h("path", { d: "M3.2 1.6L7.2 5 3.2 8.4V1.6z" }),
      );
    }
    function DbGlyph({ size, className }) {
      return h("span", { className, style: { display: "inline-flex" } }, h(CylinderIcon, { color: "#3d6fd9", size: size || 16 }));
    }
    function typeGlyph(type) {
      if (type === "redis") return h(RedisIcon);
      return h(CylinderIcon, { color: TYPE_COLOR[type] || "#6b7280" });
    }

    // Oracle's Instant Client directory. node-oracledb only needs it to reach
    // servers below 12.2 (Thin mode handles newer ones), so the default is
    // empty — Thin mode — rather than a path that only makes sense on one
    // machine. It is only a DEFAULT: `draftOf` spreads the stored row, so
    // editing an existing connection never overwrites the path the user saved —
    // an empty value there still means "stay on Thin mode".
    const ORACLE_INSTANT_CLIENT = "";

    // Per-type defaults for the connection form. `database` is the Oracle
    // service name, a schema/database elsewhere. Oracle needs a non-empty value
    // (an empty one makes the listener answer ORA-12504); MySQL has no fixed
    // name to suggest, so it stays blank.
    const TYPE_DEFAULTS = {
      postgres: { port: 5432, user: "postgres", database: "postgres" },
      mysql: { port: 3306, user: "root", database: "" },
      oracle: { port: 1521, user: "", database: "ORCL", instantClient: ORACLE_INSTANT_CLIENT },
      redis: { port: 6379, user: "", database: "" },
    };

    function blankDraft(type) {
      const next = type || "postgres";
      const preset = TYPE_DEFAULTS[next] || TYPE_DEFAULTS.postgres;
      return {
        name: "",
        type: next,
        host: "127.0.0.1",
        port: preset.port,
        user: preset.user,
        password: "",
        database: preset.database,
        ssl: false,
        // Off unless the user ticks it: `ssl: true` verifies the certificate.
        sslAllowUntrusted: false,
        instantClient: preset.instantClient ?? "",
        // Empty means "show every schema"; a non-empty list limits the tree. Kept as
        // an array in the draft and normalized to names on the host.
        schemas: [],
        // Default for a brand-new PG connection; the stored row also defaults to
        // true, so the dialog must start ticked.
        hideBuiltinDatabases: next === "postgres",
      };
    }

    function nodeKey(node) {
      if (node.kind === "conn") return "c:" + node.id;
      if (node.kind === "database") return "d:" + node.connId + ":" + node.name;
      if (node.kind === "schema") return "s:" + node.connId + ":" + (node.database || "") + ":" + node.name;
      if (node.kind === "redis-db") return "r:" + node.connId + ":" + node.index;
      if (node.kind === "table") return "t:" + node.connId + ":" + (node.database || "") + ":" + (node.schema || "") + ":" + node.name;
      if (node.kind === "key") return "k:" + node.connId + ":" + node.database + ":" + node.name;
      return node.kind + ":" + node.name;
    }

    function sameValue(a, b) {
      if (a === b) return true;
      if (a === null || a === undefined) return b === null || b === undefined || b === "";
      if (b === null || b === undefined) return a === "";
      return String(a) === String(b);
    }

    // Which of `rows` match `query`, as a Set of row indexes. Matching is a plain
    // case-insensitive substring over every cell's rendered text, so it behaves
    // the way the user reads the grid: `NULL` is searchable as "null", and a
    // number matches without quoting. An empty query matches nothing (the caller
    // treats that as "search off") rather than everything.
    function matchRowIndexes(rows, query) {
      const needle = String(query == null ? "" : query).trim().toLowerCase();
      const hits = new Set();
      if (needle === "") return hits;
      (rows || []).forEach((row, ri) => {
        for (let ci = 0; ci < (row || []).length; ci++) {
          const value = row[ci];
          const text = value === null || value === undefined ? "NULL" : String(value);
          if (text.toLowerCase().indexOf(needle) >= 0) {
            hits.add(ri);
            return;
          }
        }
      });
      return hits;
    }

    // Identify the "no search" case without allocating, so the memos and
    // effects keyed on the match set stay stable while nothing is being
    // searched. Both are read-only by contract: `hits` is only ever queried
    // with `.has`/`.size` downstream, and `hitList` only with `.length` and
    // indexing.
    const NO_HITS = new Set();
    const NO_HITS_LIST = [];

    function coerce(original, text) {
      if (original === null && text === "") return null;
      if (typeof original === "number") {
        if (text.trim() === "") return null;
        const n = Number(text);
        return Number.isFinite(n) ? n : text;
      }
      if (typeof original === "boolean") return text === "true" || text === "1";
      return text;
    }

    function quoteIdent(type, name) {
      const value = String(name || "");
      if (type === "mysql") return "`" + value.replace(/`/g, "``") + "`";
      return '"' + value.replace(/"/g, '""') + '"';
    }

    function qualifyTable(type, schema, table) {
      if (schema) return quoteIdent(type, schema) + "." + quoteIdent(type, table);
      return quoteIdent(type, table);
    }

    // Result-tab label. Schema wins over the service/database name: Oracle's
    // "database" is the service (ORCL), and the name the user means is the owner.
    function resultTabName(node) {
      if (!node) return "";
      const table = String(node.name || "").trim();
      if (!table) return "";
      const qualifier = String(node.schema || node.database || "").trim();
      return qualifier ? qualifier + "." + table : table;
    }

    function sqlLiteral(type, value) {
      if (value === null || value === undefined) return "NULL";
      if (typeof value === "number" && isFinite(value)) return String(value);
      if (typeof value === "bigint") return String(value);
      if (typeof value === "boolean") {
        if (type === "mysql" || type === "oracle") return value ? "1" : "0";
        return value ? "TRUE" : "FALSE";
      }
      // MySQL reads `\'` as an escaped quote, so backslashes must be escaped
      // before the quote doubling (same reasoning as the server-side copy in
      // lib/sql.js).
      if (type === "mysql") {
        return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
      }
      return "'" + String(value).replace(/'/g, "''") + "'";
    }

    function patchTab(tabsBus, id, patch) {
      tabsBus.set((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== id) return tab;
          return typeof patch === "function" ? patch(tab) : { ...tab, ...patch };
        }),
      }));
    }

    function downloadText(filename, text) {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function pickFile() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".sql,.json,.txt";
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) {
            resolve(null);
            return;
          }
          file.text().then((text) => resolve({ name: file.name, text })).catch(() => resolve(null));
        };
        input.click();
      });
    }

    function readNum(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        const n = Number(raw);
        return Number.isFinite(n) ? n : fallback;
      } catch {
        return fallback;
      }
    }

    function writeLS(key, value) {
      try { window.localStorage.setItem(key, String(value)); } catch {}
    }

    // The tree's connection order, as a list of connection ids.
    //
    // Kept in localStorage rather than in `~/.dsh/database-connections.json`
    // because the array order in that file is host-owned: reordering it needs a
    // new host route, and the host half of this plugin is not hot-reloadable
    // (only the profile's `cordis.patch.yml` files are watched), so such a
    // change would force a `dsh web` restart. The tree width, dock height and
    // console list all persist here for the same reason.
    //
    // An id the store no longer knows is ignored at sort time, and a connection
    // the saved order does not mention (a fresh one) sorts after those it does —
    // so an unknown or partially stale order degrades to "new ones at the
    // bottom" instead of hiding rows.
    function readConnOrder() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(ORDER_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((id) => typeof id === "string" && id !== "");
      } catch {
        return [];
      }
    }

    function sortByConnOrder(list) {
      const saved = readConnOrder();
      if (saved.length === 0) return list;
      const rank = new Map();
      saved.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
      // Decorate-sort so unlisted rows keep their store order among themselves.
      return list
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const ra = rank.has(a.row.id) ? rank.get(a.row.id) : Number.MAX_SAFE_INTEGER;
          const rb = rank.has(b.row.id) ? rank.get(b.row.id) : Number.MAX_SAFE_INTEGER;
          return ra === rb ? a.index - b.index : ra - rb;
        })
        .map((item) => item.row);
    }

    // -----------------------------------------------------------------------
    // Running a .sql file from the editor: the Run action in the editor footer.
    //
    // The script is read by the host route `/sqlfile`, resolved with the
    // editor's own path rules. The page never posts script text, so nothing a
    // page contains can be turned into a host-side request body, and a GET
    // cannot be replayed by a cross-site form.
    //
    // Which connection it runs against is settled in `sqlFileConnection` (in
    // `apply`, below). A file that names none opens its console for the user to
    // pick, and the pick is what binds it from then on.
    // -----------------------------------------------------------------------
    const SQL_FILE_WAIT_MS = 5000;
    const SQL_BIND_KEY = "dsh.database.sqlheaders";
    const sqlFileWaiters = new Map();
    // Which connection each .sql file runs against, as the console last settled
    // it. Sent with the console view (`/consoles/save`) and read back from it,
    // so the next run of the same file starts from the same database.
    let sqlFileBinds = {};
    // The `-- datasource:` header a newly bound file gains on its next save,
    // keyed by file. Empty means "write none".
    const sqlFileHeaders = Object.create(null);
    try {
      const stored = JSON.parse(window.localStorage.getItem(SQL_BIND_KEY) || "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const key of Object.keys(stored)) if (typeof stored[key] === "string") sqlFileHeaders[key] = stored[key];
      }
    } catch {}
    function rememberSqlHeader(rel, name) {
      sqlFileHeaders[rel] = name;
      try { window.localStorage.setItem(SQL_BIND_KEY, JSON.stringify(sqlFileHeaders)); } catch {}
    }
    // The workspace root a .sql file lives under, as the editor itself decides
    // it (the session's cwd). The editor half installs this:
    // `window.__dshIdeaRoot = () => cwd`. "" means "no workspace", and every
    // caller then refuses instead of resolving against a guess.
    function editorCwd() {
      try {
        const probe = window.__dshIdeaRoot;
        return typeof probe === "function" ? String(probe() || "") : "";
      } catch { return ""; }
    }
    let sqlFileCallbackSeq = 0;

    function failSqlFile(rel) {
      const list = sqlFileWaiters.get(rel);
      if (list === undefined) return false;
      sqlFileWaiters.delete(rel);
      for (const fn of list) fn({ ok: false, error: "unreachable" });
      return true;
    }

    // Resolve `{ok, rel, text, datasource, connId}` for one workspace file.
    // Every caller for the same path shares one request.
    function readSqlFile(cwd, rel) {
      const key = String(rel || "");
      return new Promise((resolve) => {
        const queued = sqlFileWaiters.get(key);
        if (queued !== undefined) { queued.push(resolve); return; }
        sqlFileWaiters.set(key, [resolve]);
        let timer = 0;
        const settle = (value) => {
          const list = sqlFileWaiters.get(key);
          if (list === undefined) return;
          sqlFileWaiters.delete(key);
          window.clearTimeout(timer);
          try { delete window[name]; } catch { window[name] = undefined; }
          try { script.remove(); } catch {}
          const out = value && value.ok === true
            ? value
            : { ok: false, error: String((value && value.error) || "failed") };
          for (const fn of list) fn(out);
        };
        sqlFileCallbackSeq += 1;
        const name = "__dshSqlFile" + sqlFileCallbackSeq;
        // `callback` is percent-encoded like any other query value, so the URL
        // carries nothing but an identifier and its arguments.
        const src = API + "/sqlfile?cwd=" + encodeURIComponent(String(cwd || ""))
          + "&rel=" + encodeURIComponent(key) + "&callback=" + encodeURIComponent(name);
        const script = document.createElement("script");
        window[name] = settle;
        script.src = src;
        script.async = true;
        script.onerror = () => {
          failSqlFile(key);
          try { script.remove(); } catch {}
          try { delete window[name]; } catch { window[name] = undefined; }
        };
        document.head.appendChild(script);
        timer = window.setTimeout(() => {
          if (sqlFileWaiters.has(key)) settle({ ok: false, error: "timeout" });
        }, SQL_FILE_WAIT_MS);
      });
    }

    function apply(ctx) {
      // If the standalone dsh-database plugin already mounted this workspace,
      // leave it in charge so the two copies do not double-register the tab
      // and ⌘2. Connections, credentials, and localStorage keys are shared.
      if (window.__dshDatabaseHotkeys && window.__dshDatabaseOwner !== "dsh-idea") {
        return;
      }
      window.__dshDatabaseOwner = "dsh-idea";

      // The workspace is portaled into idea; the host tab/guide is no longer
      // registered, so slots is optional.
      const slots = ctx.get("slots") || ctx.slots;

      const localeService = () => { try { return ctx.get("locale") || ctx.locale; } catch { return undefined; } };
      const langOf = () => {
        try {
          const loc = localeService();
          const snap = loc && loc.getSnapshot ? loc.getSnapshot() : undefined;
          const id = snap && (snap.id || snap.locale || snap.language);
          if (typeof id === "string" && id.indexOf("zh") === 0) return "zh";
          if (typeof id === "string" && id.indexOf("en") === 0) return "en";
        } catch {}
        try { if (String(window.navigator.language || "").indexOf("zh") === 0) return "zh"; } catch {}
        return "zh";
      };
      const langBus = makeBus(langOf());
      const loc = localeService();
      if (loc && typeof loc.subscribe === "function") ctx.effect(() => loc.subscribe(() => langBus.set(langOf())));
      const tip = (label, key) => {
        const text = withKey(label, key);
        return { title: text, "aria-label": text };
      };
      // Stable server codes stay language-neutral on the wire. The sentence the
      // user reads is chosen here, with the UI locale.
      const errText = (error) => {
        const raw = String((error && error.message) || error || "");
        const known = {
          "unsupported-type": "errUnsupported",
          "name-required": "errName",
          "not-sql": "errNotSql",
          "redis-not-table": "errRedisTable",
          "table-required": "errTable",
          "no-primary-key": "noPk",
          "empty-command": "errEmpty",
          "not-redis": "errNotRedis",
          "nothing-to-export": "errNothingExport",
          "import-too-large": "errImportLarge",
          "empty-sql": "errEmptySql",
          "import-too-many-statements": "errImportMany",
          "empty-key": "errEmptyKey",
          "bad-db": "errBadDb",
          "invalid-identifier": "errIdent",
          "not-found": "errNotFound",
          "connection-not-found": "errConnection",
          "bad": "errBad",
          "invalid-json": "errJson",
          "too-large": "errTooLarge",
          "unsupported-media-type": "errMedia",
          "request-not-trusted": "errTrusted",
          "method not allowed": "errMethod",
        };
        if (known[raw]) return t(known[raw]);
        if (raw.indexOf("import-failed") === 0) return t("errImportFailed") + raw.slice("import-failed".length);
        const driver = /^缺少 (.+) 驱动（([^）]+)）：([\s\S]*)$/.exec(raw);
        if (driver) return t("errDriver").replace("{label}", driver[1]).replace("{spec}", driver[2]).replace("{detail}", driver[3]);
        return raw;
      };
      const t = (key, vars) => {
        let s = (I18N[langBus.getSnapshot()] || I18N.zh)[key] ?? I18N.en[key] ?? key;
        if (vars !== undefined) {
          for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
        }
        return s;
      };

      const styleTag = document.createElement("style");
      styleTag.dataset.plugin = PLUGIN;
      styleTag.textContent = STYLE;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => { if (styleTag.isConnected) styleTag.remove(); });

      const connBus = makeBus([]);
      const treeBus = makeBus({
        expanded: {},
        children: {},
        filter: "",
        active: "",
        treeW: Math.min(480, Math.max(180, readNum(TREE_W_KEY, DEFAULT_TREE_W))),
        // Hidden tree persists across reloads; "0"/absent means shown.
        treeOpen: (() => { try { return window.localStorage.getItem(TREE_CLOSED_KEY) !== "1"; } catch { return true; } })(),
        dockH: Math.min(0.82, Math.max(0.22, (() => {
          const stored = readNum(DOCK_H_KEY, DEFAULT_DOCK_H);
          return stored === 0.4 ? DEFAULT_DOCK_H : stored;
        })())),
      });
      const tabsBus = makeBus({ tabs: [], activeId: "" });
      // Console numbering is derived from the consoles that actually exist, so closing
      // them all makes the next one "SQL console 1" again. A stored `seq` used to grow
      // forever, which is what made new consoles keep counting up from long-gone tabs.
      // Only the auto-generated "… N" shape counts: a console the user renamed to
      // something ending in a digit must not hijack the sequence.
      const AUTO_TITLE = /^(.*?)\s(\d+)$/;
      const nextConsoleNo = (consoles, label) => {
        const prefix = label || t("console");
        let max = 0;
        for (const item of consoles || []) {
          const m = AUTO_TITLE.exec(String(item.title || ""));
          if (!m) continue;
          // The title must be the auto pattern for THIS label ("SQL 控制台 3"), not an
          // arbitrary renamed tab whose text merely ends with a number.
          if (m[1] !== prefix) continue;
          max = Math.max(max, Number(m[2]));
        }
        return max + 1;
      };
      // Consoles live on the host (`~/.dsh/database-consoles.json`, mode 0600), not
      // in localStorage. The SQL in them is as sensitive as the schema it queries,
      // while a browser profile is synced, backed up and readable by anything
      // running as this user. The buses start empty and `hydrateConsoles` fills
      // them; every later change is pushed back, debounced, because typing in the
      // editor rewrites `sql` on each keystroke.
      const viewBus = makeBus({ page: "explorer", consoles: [] });
      const closedBus = makeBus([]);
      // Most recent first; de-duplicated on title + SQL so re-closing the same console
      // does not pile up duplicate entries.
      const addClosed = (item) => {
        if (!item) return;
        const sql = String(item.sql || "");
        closedBus.set((prev) => [{
          id: String(item.id || ""),
          title: String(item.title || ""),
          connId: String(item.connId || ""),
          database: String(item.database || ""),
          sql,
          at: Date.now(),
        }].concat(prev.filter((row) => !(row.title === String(item.title || "") && row.sql === sql))).slice(0, CLOSED_MAX));
      };
      const readLegacyJson = (key) => {
        try {
          const raw = window.localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      };
      const dropLegacyKeys = () => {
        try {
          window.localStorage.removeItem(CONSOLES_KEY);
          window.localStorage.removeItem(CLOSED_KEY);
        } catch {}
      };
      const consoleSnapshot = () => {
        const snap = viewBus.getSnapshot();
        return {
          page: snap.page,
          consoles: snap.consoles.map((item) => ({
            id: item.id,
            title: item.title,
            connId: item.connId || "",
            database: item.database || "",
            sql: item.sql || "",
          })),
          closed: closedBus.getSnapshot(),
          // Which connection each .sql file runs against, for the next run and
          // the next page load. Normalized by the host.
          sqlFiles: sqlFileBinds,
        };
      };
      let saveTimer = 0;
      const persistView = () => {
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          saveTimer = 0;
          api("/consoles/save", consoleSnapshot()).catch(() => {});
        }, 400);
      };
      // A tab closed mid-debounce would lose its last edits; beacon the pending
      // snapshot out on unload so the host has the newest SQL.
      const flushPendingView = () => {
        if (!saveTimer) return;
        window.clearTimeout(saveTimer);
        saveTimer = 0;
        try {
          const blob = new Blob([JSON.stringify(consoleSnapshot())], { type: "application/json" });
          window.navigator.sendBeacon(API + "/consoles/save", blob);
        } catch {}
      };
      window.addEventListener("pagehide", flushPendingView);
      ctx.effect(() => () => {
        window.removeEventListener("pagehide", flushPendingView);
        if (saveTimer) window.clearTimeout(saveTimer);
      });
      const hydrateConsoles = async () => {
        let view = null;
        let failed = false;
        try {
          const value = await api("/consoles");
          view = value && value.view ? value.view : null;
        } catch {
          failed = true;
        }
        let adopted = null;
        if (view === null && !failed) {
          // The host has never stored a view: take over whatever an older build
          // left in localStorage, then drop those keys so the SQL stops living
          // there. `view` stays null when there is nothing to adopt.
          const legacyView = readLegacyJson(CONSOLES_KEY);
          const legacyClosed = readLegacyJson(CLOSED_KEY);
          const consoles = legacyView && Array.isArray(legacyView.consoles) ? legacyView.consoles : [];
          const closed = Array.isArray(legacyClosed) ? legacyClosed : [];
          if (consoles.length || closed.length) {
            adopted = {
              page: legacyView && typeof legacyView.page === "string" ? legacyView.page : "explorer",
              consoles,
              closed,
            };
          }
        }
        // Only clear the legacy keys once the host has answered: had the request
        // failed, deleting them would destroy SQL the host never received.
        if (!failed) dropLegacyKeys();
        const source = view || adopted;
        const consoles = (source && Array.isArray(source.consoles) ? source.consoles : []).map((item) => ({
          id: item.id,
          title: item.title || "SQL",
          connId: item.connId || "",
          database: item.database || "",
          sql: item.sql || "",
          result: null,
          status: "",
          busy: false,
          dbOptions: [],
        }));
        const binds = source && source.sqlFiles && typeof source.sqlFiles === "object" && !Array.isArray(source.sqlFiles)
          ? source.sqlFiles
          : null;
        if (binds) {
          for (const [rel, row] of Object.entries(binds)) {
            if (!row || typeof row !== "object") continue;
            sqlFileBinds[rel] = { connId: String(row.connId || ""), database: String(row.database || "") };
          }
        }
        const closed = (source && Array.isArray(source.closed) ? source.closed : []).map((row) => ({
          id: String(row.id || ""),
          title: String(row.title || ""),
          connId: String(row.connId || ""),
          database: String(row.database || ""),
          sql: String(row.sql || ""),
          at: Number(row.at) || 0,
        })).slice(0, CLOSED_MAX);
        // A console the user opened while this round trip was in flight must not
        // be wiped by the restored set: keep whatever is already in the bus and
        // append the restored consoles it does not already have.
        const live = viewBus.getSnapshot();
        const merged = live.consoles.length === 0
          ? consoles
          : live.consoles.concat(consoles.filter((item) => !live.consoles.some((row) => row.id === item.id)));
        const page = live.page !== "explorer" && merged.some((item) => item.id === live.page)
          ? live.page
          : (merged.some((item) => item.id === (source && source.page)) ? source.page : "explorer");
        viewBus.set({ page, consoles: merged });
        // Same race on the history: a console the user closed during the round
        // trip is already in the bus, so keep it and append the restored entries
        // it does not already carry (the bus is newest-first).
        const liveClosed = closedBus.getSnapshot();
        const mergedClosed = liveClosed.concat(
          closed.filter((row) => !liveClosed.some((item) => item.title === row.title && item.sql === row.sql)),
        ).slice(0, CLOSED_MAX);
        closedBus.set(mergedClosed);
        if (adopted) persistView();
        viewBus.subscribe(persistView);
        closedBus.subscribe(persistView);
        merged.forEach((item) => {
          if (item.connId) loadConsoleDbs(item.id, item.connId);
        });
      };
      hydrateConsoles();
      const confirmBus = makeBus(null);
      let lastPick = -1;
      const sidebarOf = () => { try { return ctx.get("sidebarRight") || ctx.sidebarRight; } catch { return undefined; } };
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
        const actions = store === undefined ? undefined : store.actions;
        if (actions === undefined) return undefined;
        return { sessionId, actions, store };
      };
      // `toggleFullscreen` reads focus and the viewport's auto-fullscreen rule, so
      // the same open sometimes lands in push mode and sometimes flips back off.
      // Writing the stored mode is the chrome button's real effect, without that.
      const openMode = () => {
        try { return window.localStorage.getItem(OPEN_MODE_KEY) === "push" ? "push" : "fullscreen"; } catch { return "fullscreen"; }
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
      // How an open lands depends on the user's preference: fullscreen pins
      // the column over the conversation, push keeps the chat beside it. Push
      // also writes the mode explicitly, so a fullscreen left behind by Git or
      // the chrome button drops back to the ordinary width on this open.
      const showColumnOpen = () => {
        if (openMode() !== "push") { showColumnFullscreen(); return; }
        const seat = columnSeat();
        if (seat === undefined) return;
        try { if (typeof seat.actions.setMode === "function") seat.actions.setMode(seat.sessionId, "push"); } catch {}
        try { if (typeof seat.actions.setExpanded === "function") seat.actions.setExpanded(seat.sessionId, true); } catch {}
      };
      // The preference is shared with dsh-idea (`dsh.rightcolumn.openmode`).
      // Writing it and applying it now is what the status-bar pill does; the
      // event keeps the other plugin's label in step while both tabs are mounted.
      const writeOpenMode = (next) => {
        try { window.localStorage.setItem(OPEN_MODE_KEY, next); } catch {}
        try { window.dispatchEvent(new CustomEvent("dsh-open-mode", { detail: next })); } catch {}
        const seat = columnSeat();
        if (seat === undefined) return;
        try { if (typeof seat.actions.setMode === "function") seat.actions.setMode(seat.sessionId, next); } catch {}
        try { if (typeof seat.actions.setExpanded === "function") seat.actions.setExpanded(seat.sessionId, true); } catch {}
      };
      // Kept so a leftover host tab of kind "database" can close itself after
      // redirecting into the idea workspace.
      const databaseTabRecord = () => {
        const sidebar = sidebarOf();
        if (!sidebar || typeof sidebar.active !== "function") return undefined;
        try {
          const record = sidebar.active();
          return record !== undefined && record !== null && (record.kind === EXPLORER_KIND || record.id === EXPLORER_ID) ? record : undefined;
        } catch { return undefined; }
      };
      const editorApi = () => {
        try {
          const api = window.__dshEditorPanel;
          return api !== undefined && api !== null ? api : null;
        } catch { return null; }
      };
      const editorVisibleNow = () => {
        const editor = editorApi();
        const sidebar = sidebarOf();
        const expanded = sidebar !== undefined && sidebar !== null
          && typeof sidebar.isExpanded === "function" && sidebar.isExpanded() === true;
        if (!expanded) return false;
        if (editor && typeof editor.isOpen === "function") {
          try { return editor.isOpen() === true; } catch { return false; }
        }
        return false;
      };
      const databaseVisible = () => {
        if (!editorVisibleNow()) return false;
        const editor = editorApi();
        if (editor && typeof editor.leftTool === "function") {
          try { if (editor.leftTool() !== "database") return false; } catch { return false; }
        }
        if (editor && typeof editor.treeOpen === "function") {
          try { if (editor.treeOpen() === false) return false; } catch {}
        }
        return true;
      };
      const openDatabasePanel = () => {
        try { window.localStorage.setItem("dsh.idea.lefttool", "database"); } catch {}
        const editor = editorApi();
        let opened = false;
        try {
          if (editor && typeof editor.open === "function") opened = editor.open() !== false;
          else if (editor && typeof editor.reveal === "function") opened = editor.reveal() !== false;
        } catch { opened = false; }
        if (!opened) {
          const sidebar = sidebarOf();
          if (!sidebar || typeof sidebar.openTab !== "function") return false;
          try { sidebar.openTab("editor"); } catch { return false; }
          showColumnOpen();
        }
        try {
          if (editor && typeof editor.showLeftTool === "function") editor.showLeftTool("database");
          else window.dispatchEvent(new CustomEvent("dsh-idea-left-tool", { detail: "database" }));
        } catch {}
        return true;
      };
      const toggleDatabasePanel = () => {
        // ⌘2 now toggles the database tool window inside the idea workspace,
        // and always brings that workspace to the front first. A second press
        // while the tree is already showing switches back to the file tree.
        if (databaseVisible()) {
          const editor = editorApi();
          try {
            if (editor && typeof editor.showLeftTool === "function") editor.showLeftTool("files");
          } catch {}
          return false;
        }
        openDatabasePanel();
        return true;
      };
      // ⌘2 / Ctrl+2 shows or hides the database tree in the idea workspace.
      const toggleRightColumnFullscreen = () => toggleDatabasePanel();
      // ⌘2 / Ctrl+2 is the browser's own "switch to tab 2", so the page usually
      // never sees that chord — on some builds only its keyup arrives. While the
      // binding is still the default Digit2 chord, also accept the other of
      // Ctrl/⌘ (⌃2 on macOS), which is what actually reaches the page. Same
      // contract as dsh-git-manager's ⌘9 / ⌃9.
      const isTwoEvent = (event) => event.code === "Digit2" || event.code === "Numpad2" || event.key === "2";
      const dbToggleHeld = (event) => {
        if (dbChordHeld("database.toggle", event, ["Digit2", "Numpad2"])) return true;
        if (event.altKey || event.shiftKey) return false;
        if (event.metaKey === event.ctrlKey) return false;
        if (!isTwoEvent(event)) return false;
        let spec = DB_CHORDS["database.toggle"];
        try {
          if (dbKeys.has("database.toggle")) {
            const bound = dbKeys.binding("database.toggle");
            if (bound !== undefined) spec = bound;
          }
        } catch {}
        if (spec === null || spec === undefined) return false;
        if (spec.code !== "Digit2" && spec.code !== "Numpad2") return false;
        if (spec.alt || spec.shift) return false;
        return !!spec.ctrl !== !!spec.meta;
      };
      // The chord fires here, not from another plugin's dispatcher. The page
      // knows whether this workspace is the one on screen.
      let sawToggleDown = false;
      const onToggleKeyDown = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (!dbToggleHeld(event)) return;
        sawToggleDown = true;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        toggleRightColumnFullscreen();
      };
      // When the browser swallows the keydown, only the keyup is delivered; the
      // flag keeps a chord the page did see from toggling twice.
      const onToggleKeyUp = (event) => {
        if (!dbToggleHeld(event)) return;
        if (sawToggleDown) {
          sawToggleDown = false;
          return;
        }
        toggleRightColumnFullscreen();
      };
      window.addEventListener("keydown", onToggleKeyDown, true);
      window.addEventListener("keyup", onToggleKeyUp, true);
      ctx.effect(() => () => {
        window.removeEventListener("keydown", onToggleKeyDown, true);
        window.removeEventListener("keyup", onToggleKeyUp, true);
      });

      // The right column's fullscreen toggle has to keep working while the caret
      // is inside this workspace, and by default it does not.
      //
      // The host binds that chord as `pane.fullscreen.toggle`, but only in the
      // desktop runtime: on the web runtime the action is never registered, so
      // the chord is simply unbound and nothing dispatches it. The column's own
      // chrome button works regardless (it calls `toggleFullscreen` directly),
      // which is why the failure reads as "the shortcut sometimes does nothing"
      // rather than "the button is broken".
      //
      // So the workspace registers the same ⌘⌥Enter / Ctrl+Alt+Enter itself,
      // exactly as it already registers `database.toggle`, and answers it by
      // handing focus back to the pane and letting the host's own binding run.
      //
      // Re-deriving the toggle here was tried and rejected twice over. Calling
      // `sidebar.toggleFullscreen(target)` silently no-oped because that service
      // resolves its target from FOCUS (`commandTarget()` bottoms out in
      // `focusedTarget()`, which requires a `[data-dockkit-pane]` ancestor), and
      // the page used to hang off the panel ROOT where no pane contains it. It
      // is a tab body now, so a focused element does sit inside a pane — the
      // forwarder below stays because focus can still be on a chrome control of
      // the page itself, and because moving focus is what the host's own chord
      // expects. Synthesizing a click on the chrome button remains unreliable:
      // its React handler commits inside the keyboard event's own commit.
      const FULLSCREEN_ID = "database.fullscreen";
      // The page is a tab body now, so "focus is in the page" is the same test
      // the host's own command target uses: a focused element inside a pane.
      const focusInsideWorkspace = () => {
        const active = document.activeElement;
        if (active === null || active === undefined) return false;
        return typeof active.closest === "function" && active.closest("[data-dockkit-pane]") !== null;
      };
      // Hand focus to the pane that owns this column so the host's own
      // `pane.fullscreen.toggle` resolves a target, then re-dispatch the chord.
      // The workspace keeps its own element focus for the next keystroke, so the
      // user's caret position is restored on the following frame.
      let forwardingFullscreen = false;
      const forwardFullscreenChord = (event) => {
        const pane = document.querySelector("[data-sidebar-right-panel] [data-dockkit-pane]");
        if (pane === null) return false;
        const active = document.activeElement;
        if (pane === active) return false;
        try {
          if (pane.getAttribute("tabindex") === null) pane.setAttribute("tabindex", "-1");
          pane.focus({ preventScroll: true });
        } catch {
          return false;
        }
        // The host's listener is on the document, so the focused pane is enough:
        // a fresh event carries the same chord to it.
        forwardingFullscreen = true;
        try {
          const forwarded = new KeyboardEvent("keydown", {
            key: event.key,
            code: event.code,
            keyCode: event.keyCode,
            which: event.which,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          forwarded.__dshForwardedFullscreen = true;
          pane.dispatchEvent(forwarded);
        } catch {
          return false;
        } finally {
          forwardingFullscreen = false;
        }
        if (active !== null && active !== undefined && typeof active.focus === "function") {
          window.setTimeout(() => { try { active.focus({ preventScroll: true }); } catch {} }, 0);
        }
        return true;
      };
      const isHostFullscreenChord = (event) => (
        (event.code === "Enter" || event.code === "NumpadEnter")
        && event.altKey === true && event.shiftKey !== true
        && (IS_MAC ? event.metaKey === true && event.ctrlKey !== true : event.ctrlKey === true && event.metaKey !== true)
      );
      const onFullscreenKeyDown = (event) => {
        if (forwardingFullscreen || event.__dshForwardedFullscreen === true) return;
        if (window.__dshShortcutCapture === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        // The idea editor owns this chord once the database UI is hosted there.
        if (editorVisibleNow()) return;
        if (!databaseVisible() || !focusInsideWorkspace()) return;
        if (!dbChordHeld(FULLSCREEN_ID, event, ["Enter", "NumpadEnter"])) return;
        // If focus already sits inside a pane and the chord matches the host's
        // own `pane.fullscreen.toggle`, let the host handle it directly.
        const targetEl = event.target instanceof Element ? event.target : document.activeElement;
        if (isHostFullscreenChord(event) && targetEl && typeof targetEl.closest === "function" && targetEl.closest("[data-dockkit-pane]") !== null) return;
        if (!forwardFullscreenChord(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      };
      window.addEventListener("keydown", onFullscreenKeyDown, true);
      ctx.effect(() => () => window.removeEventListener("keydown", onFullscreenKeyDown, true));

      // `dsh-database-open` stays as the outside entry point: a command or
      // another plugin's button. It silently opens the idea workspace and
      // shows the connection tree — there is no visible host "Database" tab.
      window.addEventListener("dsh-database-open", openDatabasePanel);
      ctx.effect(() => () => window.removeEventListener("dsh-database-open", openDatabasePanel));

      const isDatabaseOpenId = (id) => id === EXPLORER_ID || id === EXPLORER_KIND;
      let unwrapOpenTab = null;
      const installOpenTabGuard = () => {
        const sidebar = sidebarOf();
        if (!sidebar || typeof sidebar.openTab !== "function") return false;
        if (sidebar.openTab.__dshIdeaDbGuard) return true;
        const original = sidebar.openTab.bind(sidebar);
        const guarded = function (id) {
          if (isDatabaseOpenId(id)) {
            openDatabasePanel();
            return;
          }
          return original.apply(this, arguments);
        };
        guarded.__dshIdeaDbGuard = true;
        try {
          sidebar.openTab = guarded;
          unwrapOpenTab = () => {
            try { if (sidebar.openTab === guarded) sidebar.openTab = original; } catch {}
          };
          return true;
        } catch {
          return false;
        }
      };
      if (!installOpenTabGuard()) {
        const timer = window.setInterval(() => { if (installOpenTabGuard()) window.clearInterval(timer); }, 250);
        ctx.effect(() => () => window.clearInterval(timer));
      }
      ctx.effect(() => () => { if (typeof unwrapOpenTab === "function") unwrapOpenTab(); });
      const closeLeftoverDatabaseTab = () => {
        const sidebar = sidebarOf();
        if (!sidebar || typeof sidebar.active !== "function" || typeof sidebar.close !== "function") return;
        try {
          const record = sidebar.active();
          if (!record || (record.kind !== EXPLORER_KIND && record.id !== EXPLORER_ID)) return;
          const id = record.id;
          if (!id || id === "editor") return;
          sidebar.close(id);
          openDatabasePanel();
        } catch {}
      };
      closeLeftoverDatabaseTab();

      const loadConnections = () => api("/list").then((value) => {
        const list = Array.isArray(value.connections) ? value.connections : [];
        connBus.set(sortByConnOrder(list));
      }).catch(() => {});
      loadConnections();

      // Register before the body renderer: the catalog is independent, and a
      // missing tab service must not drop the rows. The editor chunk publishes
      // the store before it loads this file; a later reload of that chunk
      // fires dsh-idea-keys-ready.
      const registerCommands = () => {
        const api = ideaKeys();
        if (api === null || typeof api.register !== "function") return null;
        try {
          return api.register({ owner: PLUGIN, commands: DB_COMMANDS });
        } catch (err) {
          console.error("dsh-idea: database shortcut registration failed", err);
          return null;
        }
      };
      let unregisterCommands = registerCommands();
      const onCatalogReady = () => {
        if (typeof unregisterCommands === "function") {
          try { unregisterCommands(); } catch {}
          unregisterCommands = null;
        }
        unregisterCommands = registerCommands();
      };
      window.addEventListener("dsh-idea-keys-ready", onCatalogReady);
      ctx.effect(() => () => {
        window.removeEventListener("dsh-idea-keys-ready", onCatalogReady);
        if (typeof unregisterCommands === "function") {
          try { unregisterCommands(); } catch {}
        }
        unregisterCommands = null;
      });

      // Schema picker. The options come from the server (`/schemas`) using the draft
      // the user is looking at, so a not-yet-saved connection can be configured in one
      // pass. A name can also be typed by hand, which is the only way to pre-set a
      // schema that does not exist yet (or is not readable by this user).
      function SchemaPicker({ draft, onChange }) {
        const [options, setOptions] = React.useState(null);
        const [state, setState] = React.useState("idle");
        const [error, setError] = React.useState("");
        const [manual, setManual] = React.useState("");
        const selected = Array.isArray(draft.schemas) ? draft.schemas : [];
        const has = (name) => selected.some((item) => item.toLowerCase() === String(name).toLowerCase());
        const load = () => {
          setState("loading");
          setError("");
          api("/schemas", { id: draft.id, draft }).then((value) => {
            const names = (value.items || []).map((item) => String(item.name)).filter((name) => name !== "");
            setOptions(names);
            setState("ready");
          }).catch((err) => {
            setOptions(null);
            setState("failed");
            setError(String(err.message || err));
          });
        };
        const toggle = (name) => {
          const next = has(name)
            ? selected.filter((item) => item.toLowerCase() !== String(name).toLowerCase())
            : selected.concat([name]);
          onChange(next);
        };
        const addManual = () => {
          const name = manual.trim();
          if (!name || has(name)) { setManual(""); return; }
          onChange(selected.concat([name]));
          setManual("");
        };
        const shown = options || [];
        // A hand-typed name that the server did not list must still get a checkbox, or
        // it would look like it had been dropped.
        const extra = selected.filter((name) => !shown.some((item) => item.toLowerCase() === name.toLowerCase()));
        return h("div", { className: "ddb-field" },
          h("span", null, t("schemas")),
          h("div", { className: "ddb-schemas" },
            h("div", { className: "ddb-schemas-bar" },
              h("span", { className: "ddb-lbl" }, selected.length ? t("schemasCount").replace("{n}", String(selected.length)) : t("schemasHint")),
              h("button", {
                type: "button",
                className: "ddb-mini",
                disabled: state === "loading",
                ...tip(state === "ready" ? t("schemasReload") : t("schemasPick")),
                onClick: load,
              }, state === "ready" ? t("schemasReload") : (state === "loading" ? t("loading") : t("schemasPick"))),
            ),
            selected.length ? h("div", { className: "ddb-schemas-chips" },
              selected.map((name) => h("span", { key: name, className: "ddb-chip" },
                h("span", { title: name }, name),
                h("button", { type: "button", ...tip(t("schemasRemove")), onClick: () => toggle(name) }, "×"),
              ))) : null,
            state === "failed" ? h("div", { className: "ddb-schemas-note" }, t("schemasFailed") + ": " + error) : null,
            state === "ready"
              ? h("div", { className: "ddb-schemas-list" },
                shown.length === 0 ? h("div", { className: "ddb-schemas-note" }, t("schemasEmpty")) : null,
                shown.map((name) => h("label", { key: name },
                  h("input", { type: "checkbox", checked: has(name), onChange: () => toggle(name) }),
                  h("span", { title: name }, name),
                )),
                extra.map((name) => h("label", { key: "x:" + name },
                  h("input", { type: "checkbox", checked: true, onChange: () => toggle(name) }),
                  h("span", { title: name }, name),
                )),
              )
              : null,
            state === "ready" || selected.length
              ? h("div", { className: "ddb-schemas-bar" },
                h("input", {
                  className: "ddb-schemas-input",
                  value: manual,
                  placeholder: t("schemasManual"),
                  spellCheck: false,
                  onChange: (e) => setManual(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") { e.preventDefault(); addManual(); }
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setManual(""); }
                  },
                }),
                h("button", { type: "button", className: "ddb-mini", disabled: !manual.trim(), ...tip(t("schemasAdd")), onClick: addManual }, t("schemasAdd")),
                h("button", { type: "button", className: "ddb-mini", disabled: !selected.length, ...tip(t("schemasNone")), onClick: () => onChange([]) }, t("schemasNone")),
              )
              : null,
          ),
        );
      }

      function Dialog({ draftBus, onClose }) {
        const draft = useBus(draftBus);
        useBus(langBus);
        const [status, setStatus] = React.useState({ kind: "", text: "" });
        const [busy, setBusy] = React.useState(false);
        const redis = draft.type === "redis";
        const oracle = draft.type === "oracle";
        const setField = (key, value) => {
          draftBus.set((prev) => {
            const next = { ...prev, [key]: value };
            if (key === "type") {
              // Reset the type-specific fields to the new type's defaults. Stale
              // values from the previous type (e.g. an Oracle service name left
              // in a MySQL form) are worse than an empty one, because they look
              // intentional. Keep what the user already typed for this type.
              const preset = TYPE_DEFAULTS[value] || TYPE_DEFAULTS.postgres;
              next.port = preset.port;
              next.user = preset.user;
              next.database = preset.database;
              next.ssl = false;
              next.sslAllowUntrusted = false;
              // Schema names are engine-specific (a PostgreSQL namespace vs. a MySQL
              // database), so a leftover selection from the previous type is dropped.
              next.schemas = [];
              // The Instant Client path belongs to Oracle alone: switching to it
              // fills the default in, switching away clears it.
              next.instantClient = preset.instantClient ?? "";
              // The PG-only hide-builtins switch would otherwise leak into the
              // row written for any other engine type.
              next.hideBuiltinDatabases = value === "postgres";
            }
            return next;
          });
        };
        const runTest = () => {
          setBusy(true);
          setStatus({ kind: "", text: t("testing") });
          api("/test", { id: draft.id, draft }).then(() => setStatus({ kind: "ok", text: t("testOk") }))
            .catch((error) => setStatus({ kind: "bad", text: errText(error) }))
            .finally(() => setBusy(false));
        };
        const runSave = () => {
          setBusy(true);
          // Saving can change the schema filter, so the cached children for this
          // connection (and everything under it) are dropped on success.
          api("/save", draft).then(() => {
            if (draft.id) reloadConnTree(draft.id);
            loadConnections();
            onClose();
          })
            .catch((error) => setStatus({ kind: "bad", text: errText(error) }))
            .finally(() => setBusy(false));
        };
        return h("div", { className: "ddb-overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
          h("div", { className: "ddb-card", role: "dialog" },
            h("h2", null, draft.id ? t("edit") : t("add")),
            h("div", { className: "ddb-form" },
              h("label", { className: "ddb-field" }, t("kind"),
                h("select", { value: draft.type, onChange: (e) => setField("type", e.target.value) },
                  TYPES.map((type) => h("option", { key: type, value: type }, type)))),
              h("label", { className: "ddb-field" }, t("name"),
                h("input", { value: draft.name, onChange: (e) => setField("name", e.target.value), autoFocus: true })),
              h("label", { className: "ddb-field" }, t("host"),
                h("input", { value: draft.host, onChange: (e) => setField("host", e.target.value) })),
              h("label", { className: "ddb-field" }, t("port"),
                h("input", { type: "number", value: draft.port, onChange: (e) => setField("port", Number(e.target.value) || 0) })),
              redis ? null : h("label", { className: "ddb-field" }, t("user"),
                h("input", { value: draft.user, onChange: (e) => setField("user", e.target.value) })),
              h("label", { className: "ddb-field" }, t("password"),
                h("input", { type: "password", value: draft.password, placeholder: draft.id ? t("passwordKeep") : "", onChange: (e) => setField("password", e.target.value) })),
              redis ? null : h("label", { className: "ddb-field" }, t("database"),
                h("input", { value: draft.database, onChange: (e) => setField("database", e.target.value) })),
              redis ? null : h("label", { className: "ddb-field ddb-check" },
                h("input", { type: "checkbox", checked: draft.ssl === true, onChange: (e) => setField("ssl", e.target.checked) }),
                t("ssl")),
              // Only meaningful once SSL is on: by default the certificate is
              // verified, and this is the explicit opt-out for a self-signed
              // internal server. Naming it plainly ("do not verify") is the
              // point — the old build skipped verification for every SSL
              // connection while showing nothing about it.
              !redis && draft.ssl === true ? h("label", { className: "ddb-field ddb-check" },
                h("input", {
                  type: "checkbox",
                  checked: draft.sslAllowUntrusted === true,
                  onChange: (e) => setField("sslAllowUntrusted", e.target.checked),
                }),
                t("sslUntrusted")) : null,
              oracle ? h("label", { className: "ddb-field" }, t("instantClient"),
                h("input", {
                  value: draft.instantClient || "",
                  placeholder: t("instantClientHint"),
                  onChange: (e) => setField("instantClient", e.target.value),
                })) : null,
              // Redis has no schema layer of its own, so the picker is SQL-only.
              redis ? null : h(SchemaPicker, {
                draft,
                onChange: (next) => setField("schemas", next),
              }),
              // PG ships with internal/management databases that are almost
              // never where application data lives. The default hides them;
              // unchecking shows the full `pg_database` list.
              draft.type === "postgres" ? h("label", { className: "ddb-field ddb-check" },
                h("input", {
                  type: "checkbox",
                  checked: draft.hideBuiltinDatabases !== false,
                  onChange: (e) => setField("hideBuiltinDatabases", e.target.checked),
                }),
                t("hideBuiltinDatabases")) : null,
            ),
            h("div", { className: "ddb-status" + (status.kind ? " ddb-" + status.kind : "") }, status.text),
            h("div", { className: "ddb-actions" },
              h("button", { type: "button", className: "ddb-btn ddb-btn-ghost", disabled: busy, ...tip(t("test")), onClick: runTest }, t("test")),
              h("button", { type: "button", className: "ddb-btn ddb-btn-ghost", ...tip(t("cancel")), onClick: onClose }, t("cancel")),
              h("button", { type: "button", className: "ddb-btn ddb-btn-primary", disabled: busy || !draft.name, ...tip(t("save")), onClick: runSave }, t("save")),
            ),
          ),
        );
      }

      // Reload one connection's cached subtree. Editing a connection can change its
      // schema filter, so the stale children map is dropped and every node that was
      // expanded is fetched again — parents before children, so a container is
      // repopulated before the levels beneath it are asked for.
      function reloadConnTree(connId) {
        const tree = treeBus.getSnapshot();
        const nodes = [];
        const walk = (list, depth) => {
          if (depth > 8) return;
          for (const node of list) {
            const key = nodeKey(node);
            if (tree.expanded[key] !== true) continue;
            nodes.push(node);
            const kids = tree.children[key];
            if (kids && kids.kind === "ready") {
              walk((kids.items || []).map((item) => ({ ...item, connId, type: node.type })), depth + 1);
            }
          }
        };
        // Built inline (not via treeNodesOfConnections) because that helper is a
        // `const` arrow declared further down: a function declaration here may run
        // before its initializer, which would be a temporal-dead-zone error.
        const root = { kind: "conn", id: connId, connId, name: "", type: "" };
        const conn = connBus.getSnapshot().find((item) => item.id === connId);
        if (conn) { root.name = conn.name; root.type = conn.type; }
        walk([root], 0);
        // Drop only this connection's cached levels. Clearing the whole map used
        // to wipe every other connection too, and `refreshTree` walks them one
        // after another — the second walk then saw an empty cache and skipped
        // every expanded schema under it.
        treeBus.set((prev) => {
          const id = String(connId);
          const children = {};
          const own = (key) => key === "c:" + id
            || key.startsWith("d:" + id + ":")
            || key.startsWith("s:" + id + ":")
            || key.startsWith("r:" + id + ":")
            || key.startsWith("t:" + id + ":")
            || key.startsWith("k:" + id + ":");
          for (const key of Object.keys(prev.children)) {
            if (!own(key)) children[key] = prev.children[key];
          }
          return { ...prev, children };
        });
        nodes.forEach((node) => loadKids(node, true));
      }

      // Per-level request generation. A forced refresh can overlap the first
      // load of the same node (expand-and-refresh, or a re-expand while the
      // first request is still out); without a token the slower response lands
      // last and the level silently reverts to the older list.
      const kidsSeq = new Map();

      function loadKids(node, force) {
        const key = nodeKey(node);
        const cur = treeBus.getSnapshot().children[key];
        if (!force && cur && cur.kind === "ready") return;
        const seq = (kidsSeq.get(key) || 0) + 1;
        kidsSeq.set(key, seq);
        const stale = () => kidsSeq.get(key) !== seq;
        treeBus.set((prev) => ({ ...prev, children: { ...prev.children, [key]: { kind: "loading" } } }));
        const path = node.kind === "conn"
          ? { kind: "root" }
          : node.kind === "database"
            ? { kind: "database", name: node.name }
            : node.kind === "schema"
              ? { kind: "schema", name: node.name, database: node.database }
              : node.kind === "redis-db"
                ? { kind: "redis-db", index: node.index, name: node.name }
                : { kind: "root" };
        api("/children", { id: node.connId || node.id, path }).then((value) => {
          if (stale()) return;
          treeBus.set((prev) => ({ ...prev, children: { ...prev.children, [key]: { kind: "ready", items: value.items || [] } } }));
        }).catch((error) => {
          if (stale()) return;
          treeBus.set((prev) => ({ ...prev, children: { ...prev.children, [key]: { kind: "failed", error: errText(error) } } }));
        });
      }

      function activateTab(id) {
        tabsBus.set((prev) => ({ ...prev, activeId: id }));
      }

      const DB_DOCK_ATTR = "dshDbDock";
      const isDbDockOpen = () => {
        try { return document.documentElement.dataset[DB_DOCK_ATTR] === "1"; } catch { return false; }
      };
      const stowGitAndRun = () => {
        try {
          const git = window.__dshGitPanel;
          if (git !== undefined && git !== null && typeof git.close === "function") git.close();
        } catch {}
        try {
          const run = window.__dshRunPanel;
          if (run !== undefined && run !== null && typeof run.close === "function") run.close();
        } catch {}
      };
      const setDbDockOpen = (on) => {
        const value = on === true;
        try { document.documentElement.dataset[DB_DOCK_ATTR] = value ? "1" : "0"; } catch {}
        try { window.dispatchEvent(new CustomEvent("dsh-db-dock", { detail: { open: value } })); } catch {}
      };
      function closeDbDock() {
        setDbDockOpen(false);
      }
      function openDbDock() {
        const editor = editorApi();
        try { if (editor && typeof editor.reveal === "function") editor.reveal(); } catch {}
        stowGitAndRun();
        setDbDockOpen(true);
      }
      function toggleDbDock() {
        if (isDbDockOpen()) closeDbDock();
        else openDbDock();
      }

      function closeTab(id) {
        tabsBus.set((prev) => {
          const tabs = prev.tabs.filter((tab) => tab.id !== id);
          let activeId = prev.activeId;
          if (activeId === id) {
            const at = prev.tabs.findIndex((tab) => tab.id === id);
            const next = tabs[at] || tabs[at - 1] || tabs[0];
            activeId = next ? next.id : "";
          }
          return { tabs, activeId };
        });
        if (tabsBus.getSnapshot().tabs.length === 0) closeDbDock();
      }

      function closeAllTabs() {
        tabsBus.set({ tabs: [], activeId: "" });
        closeDbDock();
      }

      function closeConsole(id) {
        const closing = viewBus.getSnapshot().consoles.find((item) => item.id === id);
        // Keep the whole console (title, connection, database and SQL) so it can be
        // reopened from the closed-consoles dropdown.
        if (closing) addClosed(closing);
        viewBus.set((prev) => {
          const consoles = prev.consoles.filter((item) => item.id !== id);
          let page = prev.page;
          if (page === id) {
            const at = prev.consoles.findIndex((item) => item.id === id);
            const next = consoles[at] || consoles[at - 1];
            page = next ? next.id : "explorer";
          }
          return { ...prev, consoles, page };
        });
        closeTab("q:" + id);
        const next = viewBus.getSnapshot();
        if (next.page === "explorer") {
          const editor = editorApi();
          try { if (editor && typeof editor.clearDatabaseTab === "function") editor.clearDatabaseTab(); } catch {}
        } else {
          focusConsole(next.page);
        }
      }

      // Close a console for good: unlike `closeConsole`, nothing is kept in the
      // closed-console history, so the SQL cannot be brought back. Any entry the
      // same console left in that history (from an earlier close) is dropped too,
      // matched the same way `addClosed` de-duplicates — on title + SQL.
      function deleteConsole(id) {
        const item = viewBus.getSnapshot().consoles.find((row) => row.id === id);
        const title = item ? String(item.title || "") : "";
        const sql = item ? String(item.sql || "") : "";
        closeConsole(id);
        if (item) {
          closedBus.set((prev) => prev.filter((row) => !(row.title === title && row.sql === sql)));
        }
      }

      function closeActiveTab() {
        if (confirmBus.getSnapshot()) {
          confirmBus.set(null);
          return true;
        }
        const editor = editorApi();
        const workId = editor && typeof editor.activeDatabaseTab === "function" ? editor.activeDatabaseTab() : "";
        if (!workId) return false;
        if (viewBus.getSnapshot().consoles.some((item) => item.id === workId)) {
          closeConsole(workId);
          return true;
        }
        if (tabsBus.getSnapshot().tabs.some((tab) => tab.id === workId)) {
          closeTab(workId);
          const editorNow = editorApi();
          const still = editorNow && typeof editorNow.activeDatabaseTab === "function" ? editorNow.activeDatabaseTab() : "";
          if (still === workId) {
            try { if (editorNow && typeof editorNow.clearDatabaseTab === "function") editorNow.clearDatabaseTab(); } catch {}
          }
          return true;
        }
        return false;
      }

      function patchConsole(id, patch) {
        viewBus.set((prev) => ({
          ...prev,
          consoles: prev.consoles.map((item) => {
            if (item.id !== id) return item;
            return typeof patch === "function" ? patch(item) : { ...item, ...patch };
          }),
        }));
      }

      function renameConsole(id, nextTitle) {
        const title = String(nextTitle == null ? "" : nextTitle).replace(/\s+/g, " ").trim();
        if (!title) return false;
        const current = viewBus.getSnapshot().consoles.find((item) => item.id === id);
        if (!current || current.title === title) return false;
        patchConsole(id, { title });
        // Fallback label for a result that is not a single table. A resolved table
        // shows `schema.table` instead, so this rename does not cover that tab.
        tabsBus.set((prev) => ({
          tabs: prev.tabs.map((tab) => (tab.consoleId === id ? { ...tab, consoleTitle: title } : tab)),
        }));
        return true;
      }

      function patchEdit(tab, patch) {
        if (!tab || !tab.id) return;
        patchTab(tabsBus, tab.id, patch);
      }

      // The grid edits a console result through a derived view, but the stored tab
      // stays `kind: "console"`. Commit has to see that view: checking the stored
      // kind drops the click, so a `SELECT *` result can be double-clicked and
      // edited, and the Commit button then does nothing.
      //
      // The fields here are the ones `editablePatch` writes and `BottomPanel`
      // hands the grid. A result that does not map to one table has no `table.name`
      // and is not committable.
      function editViewOf(tab) {
        if (!tab) return null;
        if (tab.kind === "table") return tab;
        if (tab.kind !== "console" || !tab.table || !tab.table.name) return null;
        if (!Array.isArray(tab.columns) || tab.columns.length === 0) return null;
        return {
          kind: "table",
          id: tab.id,
          writable: tab.writable,
          columns: tab.columns,
          rows: tab.rows || [],
          original: tab.original || [],
          kinds: tab.kinds || [],
          pk: tab.pk || [],
          fullCells: tab.fullCells || {},
          table: tab.table,
          editing: tab.editing || null,
          selected: tab.selected || {},
          selectedCol: tab.selectedCol,
          consoleId: tab.consoleId,
          status: tab.status,
          sql: tab.sql,
        };
      }

      function currentEditTab() {
        const { tabs, activeId } = tabsBus.getSnapshot();
        return editViewOf(tabs.find((item) => item.id === activeId));
      }

      let ideaWorkFocus = "files";
      const onIdeaWorkFocus = (event) => {
        ideaWorkFocus = event && event.detail === "database" ? "database" : "files";
      };
      window.addEventListener("dsh-idea-work-focus", onIdeaWorkFocus);
      ctx.effect(() => () => window.removeEventListener("dsh-idea-work-focus", onIdeaWorkFocus));

      function focusConsole(id) {
        ideaWorkFocus = "database";
        if (id && id !== "explorer") {
          viewBus.set((prev) => (prev.page === id ? prev : { ...prev, page: id }));
        }
        const editor = editorApi();
        try {
          if (editor && typeof editor.reveal === "function") editor.reveal();
          if (id && id !== "explorer" && editor && typeof editor.activateDatabaseTab === "function") {
            editor.activateDatabaseTab(id);
          }
          window.dispatchEvent(new CustomEvent("dsh-idea-work-focus", { detail: "database" }));
        } catch {}
      }

      function focusTable(id) {
        if (id) activateTab(id);
        const editor = editorApi();
        try { if (editor && typeof editor.reveal === "function") editor.reveal(); } catch {}
        openDbDock();
      }

      function publishWorkTabs() {
        const view = viewBus.getSnapshot();
        const closed = closedBus.getSnapshot();
        const tables = tabsBus.getSnapshot().tabs.filter((tab) => tab.kind === "table").map((tab) => ({
          id: tab.id,
          title: tab.title,
        }));
        try {
          window.dispatchEvent(new CustomEvent("dsh-database-work", {
            detail: {
              consoles: view.consoles.map((item) => ({ id: item.id, title: item.title })),
              tables,
              page: view.page,
              closedCount: closed.length,
            },
          }));
        } catch {}
      }
      viewBus.subscribe(publishWorkTabs);
      closedBus.subscribe(publishWorkTabs);
      tabsBus.subscribe(publishWorkTabs);

      const readMaxRows = () => {
        const value = readNum(MAX_ROWS_KEY, DEFAULT_MAX_ROWS);
        return ROW_LIMITS.indexOf(value) >= 0 ? value : DEFAULT_MAX_ROWS;
      };
      const writeMaxRows = (value) => {
        const next = ROW_LIMITS.indexOf(value) >= 0 ? value : DEFAULT_MAX_ROWS;
        writeLS(MAX_ROWS_KEY, String(next));
        return next;
      };
      let maxRows = readMaxRows();

      function cancelConsole(id) {
        const item = viewBus.getSnapshot().consoles.find((row) => row.id === id);
        if (!item || !item.busy) {
          const tabs = tabsBus.getSnapshot().tabs;
          const running = tabs.some((tab) => tab.consoleId === id && tab.busy);
          if (!running) return;
        }
        resultEpoch += 1;
        patchConsole(id, { busy: false });
        tabsBus.set((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) => (
            tab.consoleId === id && tab.busy ? { ...tab, busy: false, status: t("stop") } : tab
          )),
        }));
      }

      const readIdeaHosts = () => {
        const editor = editorApi();
        const pick = (name) => {
          if (!editor || typeof editor[name] !== "function") return null;
          try { return editor[name]() || null; } catch { return null; }
        };
        return {
          tree: pick("databaseTreeHost"),
          work: pick("databaseWorkHost"),
          tabs: pick("databaseTabsHost"),
          dock: pick("databaseDockHost"),
        };
      };

      window.__dshDatabaseDock = {
        open: openDbDock,
        close: closeDbDock,
        toggle: toggleDbDock,
        isOpen: isDbDockOpen,
      };
      const onPeerDock = (event) => {
        if (event && event.detail && event.detail.open === true) closeDbDock();
      };
      window.addEventListener("dsh-git-dock", onPeerDock);
      window.addEventListener("dsh-run-dock", onPeerDock);
      ctx.effect(() => () => {
        window.removeEventListener("dsh-git-dock", onPeerDock);
        window.removeEventListener("dsh-run-dock", onPeerDock);
        if (window.__dshDatabaseDock && window.__dshDatabaseDock.open === openDbDock) {
          try { delete window.__dshDatabaseDock; } catch { window.__dshDatabaseDock = undefined; }
        }
        try { setDbDockOpen(false); } catch {}
      });

      window.__dshDatabaseHotkeys = {
        closeTab: () => closeActiveTab(),
        open: openDatabasePanel,
        toggle: toggleDatabasePanel,
        isOpen: () => databaseVisible(),
        focusConsole,
        openConsole: () => openConsole(),
        cancelConsole,
        addConnection: () => { try { window.dispatchEvent(new CustomEvent("dsh-database-add-conn")); } catch {} },
        refreshTree: () => { try { window.dispatchEvent(new CustomEvent("dsh-database-refresh-tree")); } catch {} },
        // Used by the editor footer's Run action: opens and runs one .sql file.
        runFile: runSqlFileFromEditor,
        // The editor asks what this file is bound to before it saves: the
        // binding lives on the console's side, and the annotation line is the
        // editor's own first line.
        sqlFileBinding: (rel) => sqlFileBinds[String(rel || "")] || null,
        // The JetBrains header the editor should add the next time it saves a
        // newly bound file, so the file keeps naming its data source from then
        // on. Cleared once it is written.
        sqlFileHeader: (rel) => sqlFileHeaders[String(rel || "")] || "",
        // The editor saved the header away: forget the hint so no later save
        // adds it a second time.
        clearSqlFileHeader: (rel) => {
          const key = String(rel || "");
          if (!(key in sqlFileHeaders)) return;
          delete sqlFileHeaders[key];
          try { window.localStorage.setItem(SQL_BIND_KEY, JSON.stringify(sqlFileHeaders)); } catch {}
        },
      };
      // Errors and unhandled rejections from this half (a driver that throws
      // asynchronously, a handler that reads a field a route did not send) end
      // up in the page console with no marker of who caused them. Tag them.
      const onChunkError = (event) => {
        try { console.error("dsh-idea: database chunk error", event.error || event.message || event.reason); } catch {}
      };
      const onChunkRejection = (event) => {
        try { console.error("dsh-idea: database chunk unhandled rejection", event.reason); } catch {}
      };
      window.addEventListener("error", onChunkError);
      window.addEventListener("unhandledrejection", onChunkRejection);
      ctx.effect(() => () => {
        window.removeEventListener("error", onChunkError);
        window.removeEventListener("unhandledrejection", onChunkRejection);
      });

      try { window.dispatchEvent(new CustomEvent("dsh-database-ready")); } catch {}
      ctx.effect(() => () => {
        if (window.__dshDatabaseHotkeys && window.__dshDatabaseHotkeys.open === openDatabasePanel) {
          try { delete window.__dshDatabaseHotkeys; } catch { window.__dshDatabaseHotkeys = undefined; }
        }
        try { window.dispatchEvent(new CustomEvent("dsh-database-ready")); } catch {}
      });
      window.addEventListener("dsh-database-toggle", toggleDatabasePanel);
      ctx.effect(() => () => window.removeEventListener("dsh-database-toggle", toggleDatabasePanel));
      const onCloseKey = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.defaultPrevented === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (!dbChordHeld("database.close", event)) return;
        const api = window.__dshDatabaseHotkeys;
        if (!api || typeof api.closeTab !== "function") return;
        if (api.closeTab() !== true) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      };
      window.addEventListener("keydown", onCloseKey, true);
      ctx.effect(() => () => window.removeEventListener("keydown", onCloseKey, true));

      function upsertTab(tab, fetch) {
        const snap = tabsBus.getSnapshot();
        const exists = snap.tabs.some((item) => item.id === tab.id);
        if (exists) {
          activateTab(tab.id);
          if (tab.kind === "table") focusTable(tab.id);
          return;
        }
        tabsBus.set((prev) => ({ tabs: prev.tabs.concat([tab]), activeId: tab.id }));
        if (tab.kind === "table") focusTable(tab.id);
        if (fetch) fetch();
      }

      // A write or DDL comes back with no columns. "没有返回行" is the empty-SELECT
      // message and reads as a failure on UPDATE. `affected` of 0 is real.
      function writeStatus(value, translate) {
        if (!value) return "";
        const columns = value.columns || [];
        if (columns.length) return "";
        const command = String(value.command || "").toUpperCase();
        if (!command && value.affected == null) return "";
        const n = Number(value.affected);
        const count = Number.isFinite(n) ? n : 0;
        const text = (key) => String(translate(key)).replace("{n}", String(count));
        if (command === "UPDATE") return text("updatedRows");
        if (command === "INSERT" || command === "REPLACE") return text("insertedRows");
        if (command === "DELETE") return text("deletedRows");
        if (command === "MERGE") return text("affectedRows");
        return translate("executed");
      }

      function previewStatus(value, rows) {
        const written = writeStatus(value, t);
        if (written) return written;
        const total = Number(value.total) || rows.length;
        const offset = Number(value.offset) || 0;
        const to = offset + rows.length;
        if (!rows.length) return t("noRows");
        return (offset + 1) + "–" + to + " / " + total + (value.truncated ? " · " + t("truncated") : "");
      }

      function rowsFromResult(value) {
        const columns = (value && value.columns) || [];
        const rows = ((value && value.rows) || []).map((row) => (Array.isArray(row) ? row.slice() : columns.map((col) => row[col])));
        return { columns, rows };
      }

      // Column comments shown under the grid header's column names. Same /columns
      // call the F1 structure popover uses, cached per table so page turns and
      // reruns do not re-query. Attached to the tab asynchronously; the header
      // simply shows no comment line until the reply lands.
      const commentCache = new Map();
      // Per-tab generation: a tab can be re-pointed at another table (console
      // rerun, tree click) while the previous /columns reply is still out. The
      // older answer must not paint its comments onto the new columns.
      const commentSeq = new Map();

      function loadColumnComments(tabId, table) {
        if (!table || !table.connId || !table.name) return;
        const key = nodeKey(table);
        const seq = (commentSeq.get(tabId) || 0) + 1;
        commentSeq.set(tabId, seq);
        const cached = commentCache.get(key);
        if (cached) {
          patchTab(tabsBus, tabId, { comments: cached });
          return;
        }
        api("/columns", {
          id: table.connId,
          database: table.database,
          schema: table.schema,
          table: table.name,
          tableType: table.tableType,
        }).then((value) => {
          // patchTab only updates an existing tab, so a closed or replaced tab
          // is skipped naturally; failures just leave the header without notes.
          const comments = {};
          (value.columns || []).forEach((col) => {
            if (col && col.name && col.comment) comments[col.name] = String(col.comment);
          });
          commentCache.set(key, comments);
          if (commentSeq.get(tabId) !== seq) return;
          patchTab(tabsBus, tabId, { comments });
        }).catch(() => {});
      }

      function applyTablePreview(id, value, extra) {
        const { columns, rows } = rowsFromResult(value);
        patchTab(tabsBus, id, (tab) => ({
          ...tab,
          loading: false,
          error: "",
          columns,
          rows,
          original: rows.map((row) => row.slice()),
          kinds: rows.map(() => "old"),
          pk: value.pk || [],
          selected: {},
          selectedCol: null,
          editing: null,
          truncated: value.truncated === true,
          total: Number(value.total) || rows.length,
          offset: Number(value.offset) || 0,
          limit: Number(value.limit) || PAGE_SIZE,
          all: value.all === true,
          status: (extra && extra.status) || previewStatus(value, rows),
          // Moves when this page replaces the previous rows, not when the
          // request starts. A fetch-on-edit opened on the old page keys off it.
          rowsGen: (tab.rowsGen || 0) + 1,
          fullCells: {},
        }));
      }

      // Per-tab monotonic counter for background loads (preview / key), the same
      // pattern `runSeq` uses for query results: a reply whose seq is no longer
      // the tab's latest belongs to an earlier load (page turn, reload) and must
      // not overwrite the newer data or resurrect a closed tab.
      function bumpLoadSeq(id) {
        let seq = 0;
        tabsBus.set((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) => {
            if (tab.id !== id) return tab;
            seq = (tab.loadSeq || 0) + 1;
            return { ...tab, loadSeq: seq };
          }),
        }));
        return seq;
      }

      function loadSeqCurrent(id, seq) {
        const tab = tabsBus.getSnapshot().tabs.find((row) => row.id === id);
        return !!tab && tab.loadSeq === seq;
      }

      function loadTablePage(tab, opts) {
        if (!tab || !tab.table) return;
        const node = tab.table;
        const all = !!(opts && opts.all);
        const limit = all ? 5000 : (opts && opts.limit) || tab.limit || PAGE_SIZE;
        const offset = all ? 0 : (opts && opts.offset != null ? opts.offset : (tab.offset || 0));
        patchTab(tabsBus, tab.id, { loading: true, error: "" });
        const seq = bumpLoadSeq(tab.id);
        loadColumnComments(tab.id, tab.table);
        api("/preview", {
          id: node.connId,
          database: node.database,
          schema: node.schema,
          table: node.name,
          offset,
          limit,
          all,
        }).then((value) => {
          if (!loadSeqCurrent(tab.id, seq)) return;
          applyTablePreview(tab.id, value);
        }).catch((error) => {
          if (!loadSeqCurrent(tab.id, seq)) return;
          patchTab(tabsBus, tab.id, { loading: false, error: errText(error) });
        });
      }

      function openTable(node) {
        const id = nodeKey(node);
        treeBus.set((prev) => ({ ...prev, active: id }));
        upsertTab({
          id,
          kind: "table",
          title: resultTabName(node) || node.name,
          connId: node.connId,
          table: node,
          loading: true,
          error: "",
          columns: [],
          rows: [],
          original: [],
          kinds: [],
          pk: [],
          selected: {},
          selectedCol: null,
          editing: null,
          truncated: false,
          total: 0,
          offset: 0,
          limit: PAGE_SIZE,
          all: false,
          status: "",
        }, () => loadTablePage({ id, table: node, limit: PAGE_SIZE, offset: 0 }, { offset: 0, limit: PAGE_SIZE }));
      }

      // Table structure for the F1 popover. Results are cached per table+connection so
      // holding F1 while moving through the tree does not re-query on every keypress;
      // `force` is only used by an explicit reload.
      const STRUCT_MAX = 60;
      const structBus = makeBus(null);
      const structCache = new Map();
      let structSeq = 0;

      function closeStructure() {
        if (structBus.getSnapshot()) structBus.set(null);
      }

      function loadStructure(node, force) {
        if (!node || node.kind !== "table") return;
        const key = nodeKey(node);
        const cached = force ? null : structCache.get(key);
        if (cached) {
          structSeq += 1;
          structBus.set({ ...cached, seq: structSeq, loading: false, error: "" });
          return;
        }
        structSeq += 1;
        const seq = structSeq;
        const anchor = node.__anchor || null;
        structBus.set({
          seq,
          key,
          loading: true,
          error: "",
          name: node.name,
          kind: node.tableType === "view" ? "view" : "table",
          schema: node.schema || "",
          database: node.database || "",
          comment: "",
          columns: [],
          anchor,
        });
        api("/columns", {
          id: node.connId,
          database: node.database,
          schema: node.schema,
          table: node.name,
          tableType: node.tableType,
        }).then((value) => {
          // A newer request or a closed popover must not be resurrected by a slow reply.
          if (structBus.getSnapshot() === null || structSeq !== seq) return;
          const next = {
            seq,
            key,
            loading: false,
            error: "",
            name: value.table || node.name,
            kind: value.kind === "view" ? "view" : "table",
            schema: value.schema || node.schema || "",
            database: value.database || node.database || "",
            comment: value.comment || "",
            columns: (value.columns || []).slice(0, STRUCT_MAX),
            pk: value.pk || [],
            anchor,
          };
          structCache.set(key, next);
          structBus.set(next);
        }).catch((error) => {
          if (structBus.getSnapshot() === null || structSeq !== seq) return;
          structBus.set({
            seq,
            key,
            loading: false,
            error: errText(error),
            name: node.name,
            kind: node.tableType === "view" ? "view" : "table",
            schema: node.schema || "",
            database: node.database || "",
            comment: "",
            columns: [],
            anchor,
          });
        });
      }

      // The node F1 applies to: whatever the tree has selected, or the table behind the
      // active result/preview tab when the tree has no selection at all.
      const treeNodesOfConnections = () => connBus.getSnapshot()
        .map((conn) => ({ kind: "conn", id: conn.id, connId: conn.id, name: conn.name, type: conn.type }));

      function structureTargetNode() {
        const tree = treeBus.getSnapshot();
        const activeKey = tree.active || "";
        let found = null;
        const walk = (nodes, depth) => {
          for (const node of nodes) {
            if (found || depth > 6) return;
            if (nodeKey(node) === activeKey) { if (node.kind === "table") found = node; return; }
            const kids = tree.children[nodeKey(node)];
            if (kids && kids.kind === "ready") walk((kids.items || []).map((item) => ({ ...item, connId: node.connId || node.id, type: node.type })), depth + 1);
          }
        };
        if (activeKey) walk(treeNodesOfConnections(), 0);
        if (found) return found;
        const snap = tabsBus.getSnapshot();
        const tab = snap.tabs.find((item) => item.id === snap.activeId);
        if (tab && tab.kind === "table" && tab.table && tab.table.name) return tab.table;
        return null;
      }

      function openKey(node) {
        const id = nodeKey(node);
        treeBus.set((prev) => ({ ...prev, active: id }));
        upsertTab({
          id,
          kind: "key",
          title: node.name,
          connId: node.connId,
          key: node,
          loading: true,
          error: "",
          columns: [],
          rows: [],
          original: [],
          kinds: [],
          pk: [],
          selected: {},
          status: "",
        }, () => {
          // Opening an already-open table just re-activates its tab (upsertTab):
          // reloading it here would also discard uncommitted grid edits with a
          // stale pre-request snapshot.
          const seq = bumpLoadSeq(id);
          api("/key", { id: node.connId, database: node.database, key: node.name }).then((value) => {
            if (!loadSeqCurrent(id, seq)) return;
            patchTab(tabsBus, id, {
              loading: false,
              error: "",
              columns: value.columns || [],
              rows: value.rows || [],
              original: (value.rows || []).map((row) => (Array.isArray(row) ? row.slice() : [])),
              status: "",
            });
          }).catch((error) => {
            if (!loadSeqCurrent(id, seq)) return;
            patchTab(tabsBus, id, { loading: false, error: errText(error) });
          });
        });
      }

      // The console's second picker means different things per engine. Oracle's list is
      // *schemas*, while the connection's `database` is the service name (`ORCL`) — not
      // a schema. Seeding that would leave the picker on a value that has no option and
      // the session on the login schema. An empty value is a real choice for Oracle:
      // "login schema", stored as no ALTER SESSION at all.
      function defaultConsoleDb(conn) {
        if (!conn) return "";
        if (conn.type === "oracle") return "";
        return conn.database || "";
      }

      function loadConsoleDbs(id, connId) {
        if (!connId) {
          patchConsole(id, { dbOptions: [] });
          return;
        }
        const conn = connBus.getSnapshot().find((row) => row.id === connId);
        const oracle = !!conn && conn.type === "oracle";
        api("/children", { id: connId, path: { kind: "root" } }).then((value) => {
          // The user may have switched this console to another connection while
          // the reply was in flight; a list for the old connection must not
          // clobber the picker.
          const cur = viewBus.getSnapshot().consoles.find((item) => item.id === id);
          if (!cur || cur.connId !== connId) return;
          const opts = (value.items || []).map((item) => {
            if (item.kind === "redis-db") return { label: item.name, value: String(item.index) };
            if (item.kind === "database" || item.kind === "schema") return { label: item.name, value: item.name };
            return null;
          }).filter(Boolean);
          patchConsole(id, (item) => ({
            ...item,
            dbOptions: opts,
            // Auto-pick the first entry only where the list is a set the user must
            // choose from. Oracle keeps "" (login schema) instead of landing on
            // whichever account happens to sort first, such as ANONYMOUS.
            database: item.database || (oracle ? "" : (opts[0] ? opts[0].value : "")),
          }));
        }).catch(() => {
          const cur = viewBus.getSnapshot().consoles.find((item) => item.id === id);
          if (!cur || cur.connId !== connId) return;
          patchConsole(id, { dbOptions: [] });
        });
      }

      function openConsole(conn) {
        const list = connBus.getSnapshot();
        const picked = conn || list[0];
        const snap = viewBus.getSnapshot();
        const no = nextConsoleNo(snap.consoles, t("console"));
        const id = "sql-" + Date.now().toString(36) + "-" + no;
        const item = {
          id,
          title: t("console") + " " + no,
          connId: picked ? picked.id : "",
          database: defaultConsoleDb(picked),
          sql: "",
          result: null,
          status: "",
          busy: false,
          dbOptions: [],
        };
        viewBus.set((prev) => ({ ...prev, page: id, consoles: prev.consoles.concat([item]) }));
        if (item.connId) window.setTimeout(() => loadConsoleDbs(id, item.connId), 0);
        focusConsole(id);
      }

      // Reopen a console kept by `addClosed`. Its old id is gone, so a fresh id is
      // minted but the title, connection, database and SQL are restored as they were.
      function reopenConsole(entry) {
        if (!entry) return;
        const id = "sql-" + Date.now().toString(36) + "-r";
        const item = {
          id,
          title: entry.title || t("console"),
          connId: entry.connId || "",
          database: entry.database || "",
          sql: entry.sql || "",
          result: null,
          status: "",
          busy: false,
          dbOptions: [],
        };
        viewBus.set((prev) => ({ ...prev, page: id, consoles: prev.consoles.concat([item]) }));
        closedBus.set((prev) => prev.filter((row) => row !== entry));
        if (item.connId) window.setTimeout(() => loadConsoleDbs(id, item.connId), 0);
        focusConsole(id);
      }

      let resultSeq = 0;
      // Bumped on every run that writes a result tab. A reply whose seq no longer
      // matches is from a query this tab has since been reused for, and is dropped.
      let resultEpoch = 0;

      function resultCurrent(tabId, seq) {
        const tab = tabsBus.getSnapshot().tabs.find((row) => row.id === tabId);
        return !!tab && tab.runSeq === seq;
      }

      // The newest query-result tab of this console. Table previews are not
      // candidates: a re-run only replaces a result, never an open table.
      function latestConsoleResult(consoleId) {
        const tabs = tabsBus.getSnapshot().tabs;
        for (let i = tabs.length - 1; i >= 0; i--) {
          const tab = tabs[i];
          if (tab.kind === "console" && tab.consoleId === consoleId) return tab;
        }
        return null;
      }

      // Redis commands are not SQL. Keep the historical client split for them:
      // a semicolon outside quotes starts another command. SQL scripts are not
      // split here — Oracle PL/SQL and q-quotes are decided by the server.
      function splitRedisCommands(sql) {
        const text = String(sql || "").replace(/--[^\n]*/g, " ");
        const out = [];
        let buf = "";
        let quote = "";
        let block = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (block) {
            buf += ch;
            if (ch === "*" && text[i + 1] === "/") { buf += text[i + 1]; i += 1; block = false; }
            continue;
          }
          if (quote) {
            buf += ch;
            if (ch === quote) quote = "";
            continue;
          }
          if (ch === "/" && text[i + 1] === "*") { block = true; buf += ch; continue; }
          if (ch === "'" || ch === '"' || ch === "`") { quote = ch; buf += ch; continue; }
          if (ch === ";") { out.push(buf); buf = ""; continue; }
          buf += ch;
        }
        out.push(buf);
        return out.map((s) => s.trim()).filter((s) => s && !/^--/.test(s));
      }

      function newResultTab(title) {
        resultSeq += 1;
        const tabId = "q:" + Date.now().toString(36) + "-" + resultSeq;
        const tab = {
          id: tabId,
          kind: "console",
          title: title || (t("console") + " " + resultSeq),
          consoleId: "",
          result: null,
          busy: true,
          status: t("loading"),
          error: "",
          selected: {},
          selectedCol: -1,
        };
        tabsBus.set((prev) => ({ tabs: prev.tabs.concat([tab]), activeId: tabId }));
        return tabId;
      }

      function scriptLabel(sql, index) {
        return t("console") + " " + (index + 1) + ": " + String(sql || "").replace(/\s+/g, " ").trim().slice(0, 28);
      }

      // Open (or reuse) one result tab for a script statement. `seq` is this
      // run's token: a later run on the reused tab makes the old reply stale.
      function openScriptTab(item, label, reuse) {
        const latest = reuse ? latestConsoleResult(item.id) : null;
        const tabId = latest && latest.pinned !== true ? latest.id : newResultTab(label);
        const seq = ++resultEpoch;
        const autoTitle = new RegExp("^" + t("console").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\d+$");
        const renamed = item.title && !autoTitle.test(item.title);
        openDbDock();
        patchTab(tabsBus, tabId, {
          title: label,
          consoleId: item.id,
          connId: item.connId,
          database: item.database || "",
          consoleTitle: renamed ? item.title : "",
          runSeq: seq,
          busy: true,
          status: t("loading"),
          error: "",
          result: null,
          columns: [],
          comments: {},
          rows: [],
          original: [],
          kinds: [],
          pk: [],
          table: null,
          writable: false,
          sql: "",
          selected: {},
          selectedCol: -1,
          editing: null,
          total: 0,
          offset: 0,
          limit: maxRows,
          all: false,
        });
        activateTab(tabId);
        return { tabId, seq };
      }

      function paintScriptEntry(tabId, seq, entry) {
        if (!resultCurrent(tabId, seq)) return false;
        const sql = entry.sql || "";
        if (entry.error) {
          const message = String(entry.error);
          patchTab(tabsBus, tabId, {
            busy: false,
            error: message,
            result: { columns: ["error"], rows: [[message]] },
            status: message,
            writable: false,
            sql,
          });
          return true;
        }
        applyQueryResult(tabId, entry, { sql });
        return true;
      }

      // Record the picker's choice for a `.sql` file's console: remembered
      // beside the consoles, and written into the file by the editor's next
      // save (the console never writes the file itself).
      function bindFileBinding(file, conn, database) {
        if (!file || !file.rel || !conn) return;
        sqlFileBinds[file.rel] = { connId: conn.id, database: String(database == null ? (conn.database || "") : database) };
        if (!file.datasource && /^[A-Za-z_][A-Za-z0-9_$.-]*$/.test(String(conn.name || "")) && !sqlFileHeaders[file.rel]) {
          rememberSqlHeader(file.rel, String(conn.name));
        }
        persistView();
      }

      // The `-- datasource:` and `-- @dsh-connection` lines are a binding for
      // this console, not SQL: the driver would reject the raw form of neither
      // (both are comments), but a `.sql` opened from a project would otherwise
      // show them as script text on every run.
      function stripSqlFileHeader(sql) {
        return String(sql || "").replace(/^(?:--\s*(?:@dsh-connection|datasource|data\s*source|数据源)[^\n]*\n)+/, "");
      }

      function runSql(id, sqlOverride) {
        const item = viewBus.getSnapshot().consoles.find((row) => row.id === id);
        if (!item || !item.connId) return;
        // A console opened from a workspace file reads the file again on every
        // run: what executes is the saved script, not a buffer that has drifted
        // since the console opened. A run of an explicit selection still uses
        // the text it was given.
        if (item.file && sqlOverride == null) {
          const cwd = editorCwd();
          if (cwd === "") {
            // No editor open to say which workspace the file is in: run the
            // buffer the console already holds, which came from that file.
            runSqlNow(id, item.sql);
            return;
          }
          readSqlFile(cwd, item.file.rel).then((file) => {
            if (!file || file.ok !== true) {
              const missing = !file || file.error === "not-found";
              patchConsole(id, { status: missing ? t("sqlFileMissing", { file: item.file.rel }) : errText((file && file.error) || "failed") });
              return;
            }
            patchConsole(id, { sql: file.text, file: { rel: file.rel } });
            runSqlNow(id, file.text);
          });
          return;
        }
        runSqlNow(id, sqlOverride == null ? item.sql : sqlOverride);
      }

      function runSqlNow(id, sqlText) {
        const item = viewBus.getSnapshot().consoles.find((row) => row.id === id);
        if (!item || !item.connId) return;
        const raw = item.file ? stripSqlFileHeader(sqlText) : String(sqlText == null ? "" : sqlText);
        if (!raw.trim()) return;
        const conn = connBus.getSnapshot().find((row) => row.id === item.connId);
        // Redis stays a client-side command list. SQL goes up whole: the server
        // splits it, so a PL/SQL block is not cut on the semicolons inside it.
        if (conn && conn.type === "redis") {
          const statements = splitRedisCommands(raw);
          if (!statements.length) return;
          statements.forEach((sql, index) => {
            runOneStatement(item, sql, scriptLabel(sql, index), index === 0);
          });
          return;
        }
        const pending = openScriptTab(item, scriptLabel(raw, 0), true);
        api("/script", { id: item.connId, sql: raw, database: item.database, limit: maxRows, offset: 0 }).then((value) => {
          const results = value && Array.isArray(value.results) ? value.results : [];
          if (!resultCurrent(pending.tabId, pending.seq)) return;
          if (!results.length) {
            paintScriptEntry(pending.tabId, pending.seq, { error: "empty-sql", sql: raw });
            return;
          }
          results.forEach((entry, index) => {
            const label = scriptLabel(entry.sql || raw, index);
            if (index === 0) {
              patchTab(tabsBus, pending.tabId, { title: label });
              paintScriptEntry(pending.tabId, pending.seq, entry);
              return;
            }
            if (!resultCurrent(pending.tabId, pending.seq)) return;
            const tab = openScriptTab(item, label, false);
            paintScriptEntry(tab.tabId, tab.seq, entry);
          });
        }).catch((error) => {
          paintScriptEntry(pending.tabId, pending.seq, { error: errText(error), sql: raw });
        });
      }

      // ── run a .sql file (the editor's Run action) ──────────────────────────
      // A connection id as this plugin mints it (`randomUUID`).
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      //
      // Which connection a file runs against, in order of precedence:
      //   1. the connection the file is bound to — the annotation line the
      //      editor writes on save, or the binding beside the consoles;
      //   2. `-- datasource: <name>`, JetBrains' own header, matched on the
      //      connection's name (or, for DataGrip's `##database` form, its
      //      database);
      //   3. the only connection, when there is exactly one.
      // Anything else opens the script in a console with no connection, for the
      // user to choose one: a script is never run against "whatever sorts first".
      const sqlRunNotice = (text, tone) => {
        try { window.dispatchEvent(new CustomEvent("dsh-idea-notice", { detail: { text, tone: tone || "info" } })); } catch {}
      };

      // Which connection a .sql file runs against: what the file (or its last
      // run) bound it to, then what its header names, then — only when it has
      // exactly one — the workspace's only connection.
      function sqlFileConnection(file, uuidPattern) {
        if (!file) return undefined;
        const list = connBus.getSnapshot();
        const saved = file.rel ? sqlFileBinds[file.rel] : null;
        if (saved && saved.connId) {
          const known = list.find((row) => row.id === saved.connId);
          if (known) return known;
        }
        const id = String(file.connId || "");
        if (id !== "") {
          // A uuid comes from this plugin; anything else is a name a user wrote.
          if (uuidPattern.test(id)) return list.find((row) => row.id === id);
          const lower = id.toLowerCase();
          const byName = list.find((row) => String(row.name || "").toLowerCase() === lower);
          if (byName) return byName;
        }
        const label = String(file.datasource || "").trim();
        if (label !== "") {
          const lower = label.toLowerCase();
          const hit = list.find((row) => String(row.name || "").toLowerCase() === lower)
            || list.find((row) => String(row.database || "").toLowerCase() === lower);
          if (hit) return hit;
        }
        return list.length === 1 ? list[0] : undefined;
      }

      // The console this file already has, when one is open against `connId`.
      function sqlFileConsole(rel, connId) {
        return viewBus.getSnapshot().consoles.find((row) => row.file
          && row.file.rel === rel && (connId === undefined || row.connId === connId)) || null;
      }

      // Open `file` in its console and run it. An open console for the same file
      // and connection is reused, with the file's current text, so running a
      // script twice leaves one console and the newest result rather than two.
      // A file's console: at most one at a time, so picking another connection
      // re-binds the console the file already has instead of stacking a second
      // one beside it (IDEA's data source picker does the same for a file).
      function openSqlFile(file, conn) {
        if (!file || typeof file.text !== "string") return false;
        const existing = sqlFileConsole(file.rel);
        if (existing) {
          patchConsole(existing.id, {
            ...(conn ? { connId: conn.id, database: conn.database || "" } : {}),
            sql: file.text,
            file: { rel: file.rel },
          });
          if (conn) window.setTimeout(() => loadConsoleDbs(existing.id, conn.id), 0);
          focusConsole(existing.id);
          openDbDock();
          if (conn) window.setTimeout(() => runSql(existing.id), 0);
          return true;
        }
        const id = "sql-" + Date.now().toString(36) + "-f";
        const item = {
          id,
          title: String(file.rel || "").split("/").pop() || "script.sql",
          connId: conn ? conn.id : "",
          database: conn ? (conn.database || "") : "",
          // `file: {rel}` is what tells the console this buffer belongs to a
          // workspace file: every run reads the file again, and the connection
          // picker above the editor re-binds it from there.
          sql: file.text,
          file: { rel: file.rel },
          result: null,
          status: "",
          busy: false,
          dbOptions: [],
        };
        viewBus.set((prev) => ({ ...prev, page: id, consoles: prev.consoles.concat([item]) }));
        if (item.connId) window.setTimeout(() => loadConsoleDbs(id, conn.id), 0);
        focusConsole(id);
        openDbDock();
        if (item.connId) window.setTimeout(() => runSql(id), 0);
        return true;
      }

      // The editor's Run action and its chord. Returns whether a .sql file was
      // the target, so the caller knows whether the chord was consumed.
      function runSqlFileFromEditor() {
        const panel = window.__dshEditorPanel;
        let current = null;
        try { current = panel && typeof panel.currentFile === "function" ? panel.currentFile() : null; } catch {}
        if (!current || typeof current.rel !== "string" || !/\.sql$/i.test(current.rel)) return false;
        const cwd = editorCwd();
        if (cwd === "") return false;
        const rel = current.rel;
        readSqlFile(cwd, rel).then((file) => {
          if (!file || file.ok !== true) {
            sqlRunNotice(file && file.error === "not-found" ? t("sqlFileMissing", { file: rel }) : errText((file && file.error) || "failed"), "error");
            return;
          }
          runSqlFileNow(file);
          return;
        });
        return true;
      }

      // What the Run action does with a file that was just read: run it on the
      // connection it is bound to, else open (and focus) its console so the
      // connection picker above the editor is the next thing to answer, and run
      // it once the picker binds one.
      function runSqlFileNow(file) {
        const rel = String(file.rel || "");
        const conn = sqlFileConnection(file, UUID_RE);
        const existing = sqlFileConsole(rel);
        if (existing) {
          // A console for this file is open: run it as it stands. An unbound one
          // says so instead of silently doing nothing.
          patchConsole(existing.id, { sql: file.text, file: { rel: file.rel } });
          if (conn && conn.type !== "redis" && existing.connId !== conn.id) {
            patchConsole(existing.id, { connId: conn.id, database: conn.database || "" });
            window.setTimeout(() => loadConsoleDbs(existing.id, conn.id), 0);
          }
          focusConsole(existing.id);
          openDbDock();
          if (!existing.connId && !conn) {
            patchConsole(existing.id, { status: t("sqlFileUnsaved", { file: rel }) });
            return;
          }
          window.setTimeout(() => runSql(existing.id), 0);
          return;
        }
        if (conn && conn.type !== "redis") {
          openSqlFile(file, conn);
          return;
        }
        // No connection named: the console opens unbound (the picker is where a
        // connection is chosen, and a script is never run against a guess).
        openSqlFile(file);
        const opened = sqlFileConsole(rel);
        if (opened) {
          patchConsole(opened.id, { status: connBus.getSnapshot().length === 0 ? t("sqlNoConn") : t("sqlFileUnsaved", { file: rel }) });
        }
      }

      const SQL_RUN_ID = "database.runFile";
      let sqlRunKeys = 0;
      const installSqlRunKey = () => {
        const keys = window.__dshIdeaKeys;
        if (!keys || typeof keys.register !== "function" || sqlRunKeys !== 0) return;
        try {
          sqlRunKeys = keys.register({
            owner: PLUGIN,
            commands: [{
              id: SQL_RUN_ID,
              group: "database",
              order: 25,
              labels: { zh: "运行当前 .sql 文件", en: "Run the current .sql file" },
              // IDEA runs the console's SQL with ⌘⏎ (Ctrl+⏎ elsewhere); this is
              // the same chord on the editor side, where the console's own
              // handler does not see it.
              default: { ctrl: !IS_MAC, alt: false, shift: false, meta: IS_MAC, code: "Enter" },
            }],
          });
        } catch { sqlRunKeys = 0; }
      };
      const onSqlRunKeyDown = (event) => {
        if (window.__dshShortcutCapture === true) return;
        if (event.defaultPrevented === true) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        const target = event.target;
        // The console's own editor owns this chord inside itself; and in a real
        // text field ⏎ with a modifier belongs to the field. The editor's own
        // surface is excluded: it is a scroll box with a hidden textarea for the
        // caret, and ⌘⏎ there is this action.
        if (target && typeof target.closest === "function"
          && target.closest(".ddb-sql-wrap, .dce-paint, .dce-input, .cm-editor")) return;
        if (target && typeof target.closest === "function"
          && target.closest("input, textarea, [contenteditable='true'], select") && !target.closest(".dce-root")) return;
        const keys = window.__dshIdeaKeys;
        const matched = keys && typeof keys.has === "function" && keys.has(SQL_RUN_ID)
          ? keys.match(SQL_RUN_ID, event, ["Enter", "NumpadEnter"])
          : dbChordHeld("database.runSql", event, ["Enter", "NumpadEnter"]);
        if (!matched) return;
        if (runSqlFileFromEditor() !== true) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      };

      // The editor's Run action (`dsh-idea-run-file`) and its chord both land
      // here; neither needs the editor to know how a connection is chosen.
      // Registered here, after `runSqlFileFromEditor` and the chord handler are
      // initialized: these are `const`s in this closure, so wiring them above
      // their definition throws before the workspace ever mounts.
      window.addEventListener("dsh-idea-run-file", runSqlFileFromEditor);
      ctx.effect(() => () => window.removeEventListener("dsh-idea-run-file", runSqlFileFromEditor));
      installSqlRunKey();
      window.addEventListener("dsh-idea-keys-ready", installSqlRunKey);
      window.addEventListener("keydown", onSqlRunKeyDown, true);
      ctx.effect(() => () => {
        window.removeEventListener("dsh-idea-keys-ready", installSqlRunKey);
        window.removeEventListener("keydown", onSqlRunKeyDown, true);
        if (sqlRunKeys !== 0) {
          try { sqlRunKeys(); } catch {}
          sqlRunKeys = 0;
        }
      });

      // Seed a console result tab with the editable state a table preview would have, so
      // the same grid, add-row and commit code paths apply. Non-writable results (JOINs)
      // still get the shape; only the write actions are disabled downstream.
      function editablePatch(value) {
        const base = resultTab(value, "");
        return {
          columns: base.columns,
          rows: base.rows,
          original: base.original,
          kinds: base.kinds,
          pk: base.pk,
          table: base.table,
          writable: base.writable,
        };
      }

      function applyQueryResult(tabId, value, extra) {
        const { rows } = rowsFromResult(value);
        patchTab(tabsBus, tabId, (tab) => ({
          ...tab,
          busy: false,
          error: "",
          result: value,
          total: Number(value.total) || rows.length,
          offset: Number(value.offset) || 0,
          limit: Number(value.limit) || PAGE_SIZE,
          all: value.all === true,
          selected: {},
          selectedCol: -1,
          status: previewStatus(value, rows),
          affected: value.affected,
          command: value.command || "",
          ...editablePatch(value),
          ...extra,
          // See applyTablePreview: the in-flight page turn already bumped
          // `runSeq`, and these rows are still the previous page until here.
          rowsGen: (tab.rowsGen || 0) + 1,
          fullCells: {},
        }));
        // Console results carry `table` only when the host mapped the statement to
        // one table (e.g. `SELECT *`); JOINs and projections keep no comment line.
        const stored = tabsBus.getSnapshot().tabs.find((row) => row.id === tabId);
        if (stored && stored.table) loadColumnComments(tabId, stored.table);
      }

      function runOneStatement(item, sql, label, reuse) {
        // Reuse only when the newest result of this console is not pinned. A pin
        // keeps that grid; the run opens a fresh tab beside it instead.
        const latest = reuse ? latestConsoleResult(item.id) : null;
        const tabId = latest && latest.pinned !== true ? latest.id : newResultTab(label);
        const seq = ++resultEpoch;
        const autoTitle = new RegExp("^" + t("console").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\d+$");
        const renamed = item.title && !autoTitle.test(item.title);
        openDbDock();
        patchTab(tabsBus, tabId, {
          title: label,
          consoleId: item.id,
          connId: item.connId,
          database: item.database || "",
          consoleTitle: renamed ? item.title : "",
          runSeq: seq,
          busy: true,
          status: t("loading"),
          error: "",
          result: null,
          columns: [],
          comments: {},
          rows: [],
          original: [],
          kinds: [],
          pk: [],
          table: null,
          writable: false,
          sql: "",
          selected: {},
          selectedCol: -1,
          editing: null,
          total: 0,
          offset: 0,
          limit: maxRows,
          all: false,
        });
        activateTab(tabId);
        api("/query", { id: item.connId, sql, database: item.database, limit: maxRows, offset: 0 }).then((value) => {
          if (!resultCurrent(tabId, seq)) return;
          applyQueryResult(tabId, value, { sql });
        }).catch((error) => {
          if (!resultCurrent(tabId, seq)) return;
          patchTab(tabsBus, tabId, {
            busy: false,
            error: errText(error),
            result: { columns: ["error"], rows: [[errText(error)]] },
            status: errText(error),
            writable: false,
          });
        });
      }

      // A result belongs to the connection that produced it, not to the console's
      // current picker: switching the console to another database must not make a
      // pager/refresh re-run the old SQL against the new one. `runOneStatement`
      // stamps connId/database on the tab; consoles are only a fallback for tabs
      // that predate those fields.
      function sourceForResult(tab, consoles) {
        if (!tab) return null;
        if (tab.connId) return { connId: tab.connId, database: tab.database || "" };
        const owner = tab.consoleId ? consoles.find((row) => row.id === tab.consoleId) : undefined;
        const source = owner && owner.connId ? owner : consoles.find((row) => row.connId);
        return source && source.connId ? { connId: source.connId, database: source.database || "" } : null;
      }

      function runResultPage(tab, opts) {
        if (!tab.sql) return;
        const source = sourceForResult(tab, viewBus.getSnapshot().consoles);
        if (!source) return;
        const all = !!(opts && opts.all);
        const limit = all ? 5000 : (opts && opts.limit) || tab.limit || PAGE_SIZE;
        const offset = all ? 0 : (opts && opts.offset != null ? opts.offset : tab.offset || 0);
        const seq = ++resultEpoch;
        patchTab(tabsBus, tab.id, { busy: true, runSeq: seq });
        api("/query", { id: source.connId, sql: tab.sql, database: source.database, offset, limit, all }).then((value) => {
          if (!resultCurrent(tab.id, seq)) return;
          applyQueryResult(tab.id, value);
        }).catch((error) => {
          if (!resultCurrent(tab.id, seq)) return;
          patchTab(tabsBus, tab.id, { busy: false, status: errText(error) });
        });
      }

      // Formats a Date into `yyyy-mm-dd hh:mm:ss` using local components, which is
      // what most spreadsheet imports expect: ISO `T`/`.000Z` and JS `String(date)`
      // both produce strings no consumer wants to paste into a CSV cell.
      function pad2(n) {
        return String(n).padStart(2, "0");
      }
      function formatDateValue(value) {
        if (value instanceof Date) {
          return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate())
            + " " + pad2(value.getHours()) + ":" + pad2(value.getMinutes()) + ":" + pad2(value.getSeconds());
        }
        if (typeof value === "string") {
          // Drivers commonly return `YYYY-MM-DDTHH:MM:SS[.sss][Z|+HH:MM]` after JSON
          // round-trip; if a string parses cleanly as a date and matches that shape,
          // rewrite it to the spreadsheet-friendly form. Bare date or time strings
          // (e.g. `2026-10-09` or `17:43:36`) are left alone — they were already
          // short and unambiguous.
          const isoLike = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
          const m = isoLike.exec(value);
          if (!m) return value;
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) return value;
          return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
            + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
        }
        return value;
      }
      // Exports the on-screen rows as CSV. Works for both shapes: a console tab keeps
      // its data under `result`, while a table preview (and the derived console `view`)
      // carries `columns`/`rows` directly. `view` wins when present so unsaved edits are
      // what gets exported.
      function exportQueryResult(item, view) {
        const source = (view && view.columns && view.columns.length ? view : null)
          || item.edit
          || item.result
          || (item.columns && item.columns.length ? item : null);
        if (!source || !source.columns || !source.columns.length) return;
        const cols = source.columns;
        const lines = [cols.map((col) => {
          const s = String(col);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(",")];
        (source.rows || []).forEach((row) => {
          const cells = (Array.isArray(row) ? row : cols.map((col) => row[col])).map((value) => {
            if (value === null || value === undefined) return "";
            const normalized = formatDateValue(value);
            const s = String(normalized);
            if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
          });
          lines.push(cells.join(","));
        });
        downloadText((item.title || "query") + ".csv", lines.join("\n"));
      }

      function exportNode(node) {
        const connId = node.connId || node.id;
        const body = { id: connId };
        if (node.kind === "database") body.database = node.name;
        if (node.kind === "schema") { body.database = node.database; body.schema = node.name; }
        if (node.kind === "table") { body.database = node.database; body.schema = node.schema; body.table = node.name; }
        if (node.kind === "redis-db") body.database = String(node.index);
        api("/export", body).then((value) => {
          downloadText(value.filename || "export.sql", value.sql || "");
        }).catch((error) => {
          window.alert(errText(error));
        });
      }

      function importNode(node) {
        const connId = node.connId || node.id;
        pickFile().then((file) => {
          if (!file) return;
          const body = { id: connId, sql: file.text };
          if (node.kind === "database") body.database = node.name;
          if (node.kind === "schema") body.database = node.database;
          if (node.kind === "redis-db") body.database = String(node.index);
          const refresh = () => loadKids(
            node.kind === "table" ? { kind: "schema", connId, name: node.schema, database: node.database } : node,
            true,
          );
          // DROP / TRUNCATE come back held for a second, explicit confirmation
          // that names them, so a destructive import is never a single click on
          // a file the user did not read.
          api("/import", body).then((value) => {
            if (!value || value.needsConfirm !== true) { refresh(); return; }
            const list = (value.destructive || [])
              .map((stmt) => "  " + stmt.replace(/\s+/g, " ").slice(0, 120))
              .join("\n");
            if (!window.confirm(t("confirmDestructive") + "\n\n" + list)) return;
            body.confirmDestructive = true;
            api("/import", body).then(refresh).catch((error) => window.alert(errText(error)));
          }).catch((error) => window.alert(errText(error)));
        });
      }

      function buildMutation(tab) {
        if (!tab || tab.kind !== "table" || !tab.table) return null;
        const type = tab.table.type || "postgres";
        const qname = qualifyTable(type, tab.table.schema, tab.table.name);
        const cols = tab.columns || [];
        const pkNames = tab.pk || [];
        const pkIndex = pkNames.map((name) => cols.indexOf(name)).filter((i) => i >= 0);
        const updates = [];
        const inserts = [];
        const deletes = [];
        const sql = [];
        for (let i = 0; i < tab.rows.length; i++) {
          const row = tab.rows[i];
          const kind = (tab.kinds || [])[i] || "old";
          if (kind === "del") {
            if (!pkNames.length) continue;
            const orig = tab.original[i] || [];
            const pk = {};
            for (const idx of pkIndex) pk[cols[idx]] = orig[idx];
            deletes.push({ pk });
            const whereSql = pkNames.map((col) => {
              const value = pk[col];
              if (value === null || value === undefined) return quoteIdent(type, col) + " IS NULL";
              return quoteIdent(type, col) + " = " + sqlLiteral(type, value);
            }).join(" AND ");
            sql.push("DELETE FROM " + qname + " WHERE " + whereSql + ";");
            continue;
          }
          if (kind === "old" && pkNames.length === 0) continue;
          if (kind === "new") {
            const set = {};
            for (let c = 0; c < cols.length; c++) {
              const value = row[c];
              if (value === null || value === undefined || value === "") continue;
              set[cols[c]] = coerce(null, String(value));
            }
            if (Object.keys(set).length === 0) continue;
            inserts.push({ set });
            const names = Object.keys(set);
            sql.push("INSERT INTO " + qname + " (" + names.map((col) => quoteIdent(type, col)).join(", ") + ") VALUES (" + names.map((col) => sqlLiteral(type, set[col])).join(", ") + ");");
            continue;
          }
          const orig = tab.original[i] || [];
          const set = {};
          for (let c = 0; c < cols.length; c++) {
            if (!sameValue(row[c], orig[c])) {
              set[cols[c]] = coerce(orig[c], row[c] === null || row[c] === undefined ? "" : String(row[c]));
            }
          }
          if (Object.keys(set).length === 0) continue;
          const pk = {};
          for (const idx of pkIndex) pk[cols[idx]] = orig[idx];
          updates.push({ pk, set });
          const setSql = Object.keys(set).map((col) => quoteIdent(type, col) + " = " + sqlLiteral(type, set[col])).join(", ");
          const whereSql = pkNames.map((col) => {
            const value = pk[col];
            if (value === null || value === undefined) return quoteIdent(type, col) + " IS NULL";
            return quoteIdent(type, col) + " = " + sqlLiteral(type, value);
          }).join(" AND ");
          sql.push("UPDATE " + qname + " SET " + setSql + " WHERE " + whereSql + ";");
        }
        if (!sql.length) return null;
        return {
          sql: sql.join("\n"),
          payload: {
            id: tab.table.connId,
            database: tab.table.database,
            schema: tab.table.schema,
            table: tab.table.name,
            changes: updates,
            inserts,
            deletes,
          },
        };
      }

      function submitEdits() {
        const tab = currentEditTab();
        if (!tab || tab.kind !== "table") return;
        // Close the cell editor first. The Commit button keeps focus on mousedown
        // so this click is not lost; leaving the input open would sit under the
        // confirmation dialog.
        if (tab.editing) patchEdit(tab, { editing: null });
        // A non-writable result (JOIN and friends) must never reach the server.
        if (tab.writable === false) {
          patchEdit(tab, { status: t("readOnlyQuery") });
          return;
        }
        if (hasCutEdit(tab)) {
          patchEdit(tab, { status: t("cellCut"), editing: null });
          return;
        }
        if ((!tab.pk || !tab.pk.length) && !(tab.kinds || []).includes("new") && !(tab.kinds || []).includes("del")) {
          patchEdit(tab, { status: t("noPk") });
          return;
        }
        const mutation = buildMutation(tab);
        if (!mutation) {
          patchEdit(tab, { status: t("nothingToSubmit") });
          return;
        }
        confirmBus.set({ tabId: tab.id, ...mutation });
      }

      function runConfirmed(mutation) {
        confirmBus.set(null);
        patchEdit({ id: mutation.tabId }, { status: t("loading") });
        api("/update", mutation.payload).then((value) => {
          const msg = t("saved") + " · " + (value.rowCount || 0) + " " + t("rows");
          const target = tabsBus.getSnapshot().tabs.find((item) => item.id === mutation.tabId);
          if (!target) return;
          // A console result reloads the single statement that produced it. Re-running
          // the console's whole buffer executed every other statement again and opened
          // a fresh result tab for each one after the first.
          if (target.consoleId) {
            patchTab(tabsBus, target.id, { status: msg, selected: {}, selectedCol: -1 });
            if (target.sql) {
              runResultPage(target, {
                offset: target.all ? 0 : (target.offset || 0),
                limit: target.limit || PAGE_SIZE,
                all: target.all === true,
              });
            }
            return;
          }
          if (target.table) openTableReload(target, msg);
        }).catch((error) => {
          patchEdit({ id: mutation.tabId }, { status: errText(error) });
        });
      }

      function openTableReload(tab, status) {
        loadTablePage(tab, {
          offset: tab.offset || 0,
          limit: tab.limit || PAGE_SIZE,
          all: tab.all === true,
        });
        if (status) patchTab(tabsBus, tab.id, { status });
      }

      function tabIsDirty(tab) {
        if (!tab || tab.kind !== "table") return false;
        const kinds = tab.kinds || [];
        if (kinds.includes("new") || kinds.includes("del")) return true;
        const rows = tab.rows || [];
        const original = tab.original || [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] || [];
          const orig = original[i] || [];
          for (let c = 0; c < Math.max(row.length, orig.length); c++) {
            if (!sameValue(row[c], orig[c])) return true;
          }
        }
        return false;
      }

      // Row-menu copy is INSERT; ⌘C / column click stay raw tab-separated values.
      // JOIN results have no single table — emit `your_table` rather than guess.
      function copyRowsAsInsert(view, selected) {
        const rows = (view && view.rows) || [];
        const columns = (view && view.columns) || [];
        const indexes = Object.keys(selected || {}).map(Number).sort((a, b) => a - b);
        if (!indexes.length || !columns.length) return false;
        const table = (view && view.table) || {};
        const type = table.type || "postgres";
        const target = table.name ? qualifyTable(type, table.schema, table.name) : "your_table";
        const cols = columns.map((col) => quoteIdent(type, col)).join(", ");
        const statements = indexes.map((i) => {
          const row = rows[i] || [];
          const values = columns.map((_, ci) => sqlLiteral(type, row[ci])).join(", ");
          return "INSERT INTO " + target + " (" + cols + ") VALUES (" + values + ");";
        });
        try { navigator.clipboard.writeText(statements.join("\n")); } catch {}
        return true;
      }

      function rowMenuCopyMode(view, failed) {
        if (failed) return "values";
        const table = view && view.table;
        return table && table.type !== "redis" ? "insert" : "values";
      }

      function copyFromRowMenu(view, failed) {
        if (rowMenuCopyMode(view, failed) === "values") return copySelectedRows(view, view.selected);
        return copyRowsAsInsert(view, view.selected);
      }

      // ⌘C copies raw field values: cells within a row joined by tabs, rows by
      // newlines — paste-friendly for spreadsheets. NULL becomes an empty cell.
      function copySelectedRows(tab, selectedOverride) {
        if (!tab) return false;
        const rows = tab.rows || [];
        const plain = (value) => value === null || value === undefined ? "" : String(value);
        const lines = [];
        const useColumn = selectedOverride === undefined && typeof tab.selectedCol === "number" && tab.selectedCol >= 0;
        if (useColumn) {
          const ci = tab.selectedCol;
          rows.forEach((row) => { lines.push(plain((row || [])[ci])); });
        } else {
          const selected = selectedOverride || tab.selected || {};
          const indexes = Object.keys(selected).map(Number).sort((a, b) => a - b);
          if (!indexes.length) return false;
          indexes.forEach((i) => {
            lines.push((rows[i] || []).map(plain).join("\t"));
          });
        }
        if (!lines.length) return false;
        try { navigator.clipboard.writeText(lines.join("\n")); } catch {}
        return true;
      }

      function pickRows(tab, index, event) {
        const selected = tab.selected || {};
        let next = {};
        if (event && (event.metaKey || event.ctrlKey)) {
          next = { ...selected };
          if (next[index]) delete next[index];
          else next[index] = true;
        } else {
          next = { [index]: true };
        }
        lastPick = index;
        patchEdit(tab, { selected: next, selectedCol: null, editing: null });
      }

      function selectColumn(tab, ci) {
        patchEdit(tab, { selectedCol: ci, selected: {}, editing: null });
      }

      // The server truncates grid cells for display (`…` tail, up to 8000
      // chars, or `… (N bytes)` for a binary preview). Opening the editor on
      // such a cell re-reads that one value from the database at full length:
      // without it the user cannot copy the whole text, and committing an edit
      // would write the truncated string back. The editor stays closed until
      // that read returns a value that is no longer cut. Both `rows` and
      // `original` are replaced, so the freshly loaded value is not a change.
      //
      // A trailing `…` alone does not mean "cut": real data may end with one.
      // Text and JSON are cut at CELL_CHARS_MAX (the shaped string is one char
      // longer; a LOB cut is exactly the cap), binary previews at 64 bytes.
      // The cap is duplicated here because the browser half cannot import
      // sql.js; keep it in step with CELL_CHARS_MAX there.
      const DISPLAY_CELL_CHARS = 8000;
      const TRUNCATED_TAIL = /…(?: \(\d+ (?:chars|bytes)\))?$/;
      function isTruncated(value) {
        if (typeof value !== "string" || !TRUNCATED_TAIL.test(value)) return false;
        // A binary preview is short but unmistakable: `\x` + hex + `…`. A text
        // cut, including a LOB one, is always at least the display cap long.
        if (/^\\x[0-9a-f]+…/.test(value)) return true;
        return value.length >= DISPLAY_CELL_CHARS;
      }
      // A fully loaded value can still end in `…` or look like a `\x` preview.
      // The display guess must not treat that cell as unread, so a resolved
      // cell is remembered by its primary key and column, not by its text.
      function cellMark(tab, ri, ci) {
        const cols = tab.columns || [];
        const orig = (tab.original && tab.original[ri]) || [];
        const parts = (tab.pk || []).map((name) => {
          const idx = cols.indexOf(name);
          return idx < 0 ? null : orig[idx];
        });
        return JSON.stringify([parts, ci]);
      }
      function cellResolved(tab, ri, ci) {
        const marks = tab.fullCells;
        return !!marks && marks[cellMark(tab, ri, ci)] === true;
      }
      function hasCutEdit(tab) {
        const rows = tab.rows || [];
        const original = tab.original || [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] || [];
          const orig = original[i] || [];
          for (let c = 0; c < row.length; c++) {
            if (cellResolved(tab, i, c)) continue;
            if (!sameValue(row[c], orig[c]) && (isTruncated(row[c]) || isTruncated(orig[c]))) return true;
          }
        }
        return false;
      }
      function loadFullCell(tab, ri, ci) {
        const shown = tab.rows[ri] && tab.rows[ri][ci];
        if (!isTruncated(shown)) return;
        const table = tab.table;
        if (!table || !table.name || !table.connId) return;
        const cols = tab.columns || [];
        const pkIndex = (tab.pk || []).map((name) => cols.indexOf(name)).filter((i) => i >= 0);
        if (!pkIndex.length) {
          patchEdit(tab, { status: t("cellNoPk"), editing: null });
          return;
        }
        const orig = tab.original[ri] || [];
        // `runSeq` / `loadSeq` move when the request starts, while the old
        // rows are still on screen and still editable. Keying the reply to
        // that seq would accept it after the next page lands. `rowsGen` moves
        // only when the row set is replaced; the primary key has to match too,
        // because a truncated preview is not unique across rows.
        const version = tab.rowsGen || 0;
        const pkSent = pkIndex.map((idx) => orig[idx]);
        const samePage = (cur) => {
          if (cur.busy || cur.loading) return false;
          if ((cur.rowsGen || 0) !== version) return false;
          const now = (cur.original && cur.original[ri]) || [];
          for (let i = 0; i < pkIndex.length; i++) {
            if (!sameValue(now[pkIndex[i]], pkSent[i])) return false;
          }
          return true;
        };
        const fail = (statusKey) => patchEdit(tab, (cur) => {
          if (!samePage(cur)) return cur;
          // A cell editor opened for another cell in the meantime stays open.
          if (cur.editing && (cur.editing.ri !== ri || cur.editing.ci !== ci)) return cur;
          return { ...cur, status: t(statusKey), editing: null };
        });
        const pk = {};
        for (const idx of pkIndex) pk[cols[idx]] = orig[idx];
        api("/cell", {
          id: table.connId,
          database: table.database,
          schema: table.schema,
          table: table.name,
          column: cols[ci],
          pk,
        }).then((value) => {
          if (!value || value.missing || value.truncated === true || typeof value.value !== "string") {
            fail(value && value.missing ? "cellMissing" : "cellCut");
            return;
          }
          patchEdit(tab, (cur) => {
            if (!samePage(cur)) return cur;
            // Another cell was opened, or this one changed, before the fetch
            // landed: never clobber that, and do not steal the editor.
            if (!cur.rows[ri] || cur.rows[ri][ci] !== shown) return cur;
            if (cur.editing && (cur.editing.ri !== ri || cur.editing.ci !== ci)) return cur;
            const rows = cur.rows.slice();
            rows[ri] = rows[ri].slice();
            rows[ri][ci] = value.value;
            const original = cur.original.slice();
            original[ri] = (original[ri] || []).slice();
            original[ri][ci] = value.value;
            const fullCells = { ...(cur.fullCells || {}) };
            fullCells[cellMark({ ...cur, original }, ri, ci)] = true;
            return { ...cur, rows, original, fullCells, editing: { ri, ci }, selectedCol: null };
          });
        }).catch(() => fail("cellLoadFail"));
      }

      // Cap on the tooltip copy of a cell. The editor may hold a much longer
      // fetch-on-edit value; putting it in a DOM attribute as well doubles the
      // text the page has to keep, for a tooltip nobody can read in full.
      const CELL_TITLE_CHARS = 2000;

      // One grid row, memoised.
      //
      // Props are all primitives or per-row arrays, so React can skip a row whose
      // data did not change: the edit handler replaces only the edited row's
      // array, leaving every other `row`/`orig` identity intact. Anything that is
      // not per-row (the tab, the selection map, the callbacks) arrives through
      // `ctx`, a ref, precisely so it cannot invalidate every row on each render.
      const GridRow = React.memo(function GridRow({
        ri, row, orig, kind, editing, selected, isHit, hitsOn, isCurrentHit,
        selectedCol, canEdit, ctx,
      }) {
        const { onRowMenu } = ctx.current;
        const tab = ctx.current.tab;
        let dirty = kind === "new";
        if (kind === "old") {
          for (let c = 0; c < row.length; c++) if (!sameValue(row[c], orig[c])) dirty = true;
        }
        const cls = [
          kind === "new" ? "ddb-new" : "",
          kind === "del" ? "ddb-del" : "",
          dirty && kind !== "new" && kind !== "del" ? "ddb-dirty" : "",
          selected ? "ddb-pick" : "",
          hitsOn ? (isHit ? "ddb-hit" : "ddb-hit-off") : "",
          isCurrentHit ? "ddb-hit-cur" : "",
        ].filter(Boolean).join(" ");
        return h("tr", {
          // Addressable so the search cursor can scroll a match into view.
          "data-ri": ri,
          className: cls,
          onClick: (e) => pickRows(tab, ri, e),
        },
          row.map((value, ci) => {
            const isNull = value === null || value === undefined;
            const isEditing = canEdit && kind !== "del" && (kind === "new" || editing === ci);
            const colCls = selectedCol === ci ? { className: "ddb-col-on" } : null;
            if (!isEditing) {
              const text = isNull ? "NULL" : String(value);
              const title = text.length > CELL_TITLE_CHARS ? text.slice(0, CELL_TITLE_CHARS) + "…" : text;
              return h("td", {
                key: ci,
                ...(colCls || {}),
                title,
                onContextMenu: (e) => {
                  e.preventDefault();
                  if (!selected) pickRows(tab, ri, null);
                  if (onRowMenu) onRowMenu(e, ri, ci);
                },
                onDoubleClick: (e) => {
                  e.stopPropagation();
                  if (!canEdit || kind === "del") return;
                  if (kind === "old" && isTruncated(value) && !cellResolved(tab, ri, ci)) {
                    loadFullCell(tab, ri, ci);
                    return;
                  }
                  patchEdit(tab, { editing: { ri, ci, initial: value }, selectedCol: null });
                },
              }, isNull ? h("span", { className: "ddb-null" }, "NULL") : text);
            }
            const rawStr = isNull ? "" : String(value);
            const multiLine = rawStr.indexOf("\n") >= 0 || rawStr.length > 80;
            const onCellChange = (e) => {
              const next = e.target.value;
              patchEdit(tab, (cur) => {
                // Copy only the row being edited. This used to
                // `map(r => r.slice())` the whole grid, so one keystroke in
                // an "All" result (5000 rows) copied 5000 arrays to change
                // one cell — and re-rendered all 65k elements with it.
                const rows = cur.rows.slice();
                rows[ri] = rows[ri].slice();
                rows[ri][ci] = next;
                return { ...cur, rows };
              });
            };
            const onCellKeyDown = (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                const restore = tab.editing && tab.editing.ri === ri && tab.editing.ci === ci && "initial" in tab.editing
                  ? tab.editing.initial
                  : (orig ? orig[ci] : null);
                patchEdit(tab, (cur) => {
                  const rows = cur.rows.slice();
                  if (rows[ri]) {
                    rows[ri] = rows[ri].slice();
                    rows[ri][ci] = restore;
                  }
                  return { ...cur, rows, editing: null };
                });
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const nextCi = ci + (e.shiftKey ? -1 : 1);
                if (nextCi >= 0 && nextCi < row.length) {
                  patchEdit(tab, (cur) => ({ ...cur, editing: { ri, ci: nextCi, initial: cur.rows[ri][nextCi] } }));
                } else {
                  e.currentTarget.blur();
                }
                return;
              }
              if (e.key === "Enter" && (!multiLine || !e.shiftKey)) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            };
            return h("td", { key: ci, ...(colCls || {}) },
              multiLine
                ? h("textarea", {
                    className: "ddb-cell-ta",
                    rows: Math.min(6, Math.max(2, rawStr.split("\n").length)),
                    autoFocus: kind !== "new" || ci === 0,
                    value: rawStr,
                    placeholder: isNull ? "NULL" : "",
                    onClick: (e) => e.stopPropagation(),
                    onChange: onCellChange,
                    onBlur: () => patchEdit(tab, { editing: null }),
                    onKeyDown: onCellKeyDown,
                  })
                : h("input", {
                    autoFocus: kind !== "new" || ci === 0,
                    value: rawStr,
                    placeholder: isNull ? "NULL" : "",
                    onClick: (e) => e.stopPropagation(),
                    onChange: onCellChange,
                    onBlur: () => patchEdit(tab, { editing: null }),
                    onKeyDown: onCellKeyDown,
                  }),
            );
          }),
        );
      });

      function EditableGrid({ tab, onRowMenu, hits, currentHit }) {
        useBus(langBus);
        const gridRef = React.useRef(null);
        const editing = tab.editing || null;
        // Scroll the active match into view. Keyed on the cursor (and the hit set,
        // so re-typing a query re-lands on the first match) rather than on the row
        // data, which changes on every edit.
        React.useEffect(() => {
          if (!hits || hits.size === 0 || currentHit === null || currentHit === undefined) return;
          const node = gridRef.current;
          if (!node) return;
          const row = node.querySelector('tr[data-ri="' + currentHit + '"]');
          if (row && typeof row.scrollIntoView === "function") {
            try { row.scrollIntoView({ block: "nearest" }); } catch {}
          }
        }, [currentHit, hits]);
        React.useEffect(() => {
          if (!tab.focusNew) return;
          const el = gridRef.current && gridRef.current.querySelector("tr.ddb-new:last-child input");
          if (el) {
            try { el.focus(); el.scrollIntoView({ block: "nearest" }); } catch {}
          }
          patchEdit(tab, { focusNew: false });
        }, [tab.focusNew, tab.rows && tab.rows.length]);
        // The copy shortcut reads the live tab through a ref. Keying this effect
        // on `tab` (or on `view`, which a console tab rebuilds every render and a
        // table tab does not) re-installed both capture-phase listeners on every
        // keystroke; the handlers only ever need the *current* rows, so the
        // dependency is the tab's identity instead.
        const tabRef = React.useRef(tab);
        tabRef.current = tab;
        React.useEffect(() => {
          const node = gridRef.current;
          if (!node) return undefined;
          const onCopy = (e) => {
            const sel = window.getSelection && window.getSelection();
            if (sel && String(sel).trim()) return;
            if (!copySelectedRows(tabRef.current)) return;
            e.preventDefault();
            e.stopPropagation();
          };
          const onKey = (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
            if (e.code !== "KeyC" && e.key !== "c" && e.key !== "C") return;
            const active = document.activeElement;
            if (active && String(active.tagName || "").toLowerCase() === "input") return;
            if (copySelectedRows(tabRef.current)) {
              e.preventDefault();
              e.stopPropagation();
            }
          };
          node.addEventListener("copy", onCopy, true);
          node.addEventListener("keydown", onKey, true);
          return () => {
            node.removeEventListener("copy", onCopy, true);
            node.removeEventListener("keydown", onKey, true);
          };
        }, [tab.id]);
        // Row-level memoisation context.
        //
        // This hook MUST stay above the early returns below. `tab.loading` is
        // true on a table tab's first render and false once the preview lands, so
        // a `useRef` placed after those returns is called on the second render
        // but not the first — React error #310 ("rendered more hooks than during
        // the previous render"), which blanks the whole pane the moment you
        // double-click a table. The console path never tripped it because a
        // console tab tracks `busy`, not `loading`.
        //
        // Keeping every hook above the returns is the rule here; the comments in
        // BottomPanel say the same thing for the same reason.
        const rowCtx = { tab, onRowMenu };
        const rowCtxRef = React.useRef(rowCtx);
        rowCtxRef.current = rowCtx;
        if (tab.loading) return h("div", { className: "ddb-empty" }, t("loading"));
        if (tab.error) return h("div", { className: "ddb-empty" }, tab.error);
        if (!tab.columns.length) return h("div", { className: "ddb-empty" }, writeStatus(tab, t) || tab.status || t("noRows"));
        const pkSet = {};
        (tab.pk || []).forEach((name) => { pkSet[name] = true; });
        // A table preview is always editable. A console result is editable only when the
        // host confirmed it maps to one writable table (`writable`); a JOIN is not.
        const canEdit = tab.kind === "table" && tab.writable !== false;
        const selected = tab.selected || {};
        const selectedCol = typeof tab.selectedCol === "number" ? tab.selectedCol : -1;
        // `selectedCol` and `canEdit` are NOT inside the ref, even though they are
        // the same for every row: they can change with nothing else changing
        // (clicking a column header moves the highlight), and a row that bailed
        // out would keep the old class. They are cheap scalars, so passing them
        // as real props costs one comparison per row and keeps the highlight and
        // the read-only state correct.
        return h("div", { className: "ddb-grid", ref: gridRef, tabIndex: -1 },
          h("table", null,
            h("thead", null, h("tr", null,
              tab.columns.map((col, ci) => {
                // Column comment (中文注释) as a second, smaller line under the name;
                // ellipsized at the header's max width, the full text is the tooltip.
                const note = (tab.comments || {})[col] || "";
                const label = col + (pkSet[col] ? " *" : "");
                return h("th", {
                  key: col,
                  className: (selectedCol === ci ? "ddb-th-on" : "") + (note ? " ddb-has-cmt" : ""),
                  title: note ? label + "\n" + note : label,
                  onClick: () => selectColumn(tab, selectedCol === ci ? -1 : ci),
                },
                  h("span", { className: "ddb-th-name" }, label),
                  note ? h("span", { className: "ddb-th-cmt", title: note }, note) : null,
                );
              }),
            )),
            h("tbody", null, tab.rows.map((row, ri) => h(GridRow, {
              key: ri,
              ri,
              row,
              orig: tab.original[ri] || [],
              kind: (tab.kinds || [])[ri] || "old",
              editing: editing && editing.ri === ri ? editing.ci : -1,
              selected: selected[ri] === true,
              isHit: hits ? hits.has(ri) : false,
              hitsOn: !!(hits && hits.size > 0),
              isCurrentHit: !!(hits && hits.size > 0 && currentHit === ri),
              selectedCol,
              canEdit,
              ctx: rowCtxRef,
            }))),
          ),
        );
      }

      function Pager({ tab, onPage }) {
        const total = Number(tab.total) || (tab.result && tab.result.rows ? tab.result.rows.length : 0);
        const limit = Number(tab.limit) || PAGE_SIZE;
        const offset = Number(tab.offset) || 0;
        const shown = tab.result && tab.result.rows ? tab.result.rows.length : 0;
        const hasMore = offset + shown < total;
        return h("div", { className: "ddb-pager" },
          h("span", { className: "ddb-pager-info" }, (offset + 1) + "–" + (offset + shown) + " / " + total),
          h("button", {
            type: "button",
            disabled: tab.all || offset <= 0,
            ...tip(t("pagePrev")),
            onClick: () => onPage(tab, { offset: tab.all ? 0 : Math.max(0, offset - limit), limit }),
          }, "‹"),
          h("button", {
            type: "button",
            disabled: tab.all || !hasMore,
            ...tip(t("pageNext")),
            onClick: () => onPage(tab, { offset: offset + limit, limit }),
          }, "›"),
          h("button", {
            type: "button",
            disabled: tab.all === true,
            ...tip(t("pageAll")),
            onClick: () => onPage(tab, { all: true }),
          }, t("pageAll")),
        );
      }

      function BottomPanel({ consoleId, tabId } = {}) {
        const { tabs: allTabs, activeId } = useBus(tabsBus);
        useBus(viewBus);
        useBus(langBus);
        const tabs = allTabs.filter((item) => {
          if (tabId) return item.id === tabId;
          if (consoleId) return item.kind === "console" && item.consoleId === consoleId;
          return true;
        });
        const [rowMenu, setRowMenu] = React.useState(null);
        const [resultMenu, setResultMenu] = React.useState(null);
        // In-result search. The box is a permanent part of the result bar, so it
        // needs no open/closed state: `query` is the raw text and `hitCursor` is
        // the index into the (ordered) match list, or -1.
        const [query, setQuery] = React.useState("");
        const [hitCursor, setHitCursor] = React.useState(-1);
        const clearSearch = () => { setQuery(""); setHitCursor(-1); };
        const searchRef = React.useRef(null);
        React.useEffect(() => {
          if (!rowMenu) return undefined;
          const close = () => setRowMenu(null);
          window.addEventListener("click", close);
          return () => window.removeEventListener("click", close);
        }, [rowMenu]);
        React.useEffect(() => {
          if (!resultMenu) return undefined;
          const close = () => setResultMenu(null);
          window.addEventListener("click", close);
          return () => window.removeEventListener("click", close);
        }, [resultMenu]);
        // ⌘F while the result pane has focus: the grid, its tabs, or this box.
        React.useEffect(() => {
          const onKey = (event) => {
            if (!isPlainFindKey(event)) return;
            const node = event.target;
            if (!node || typeof node.closest !== "function" || !node.closest(".ddb-dock")) return;
            if (!focusFindInput(searchRef.current)) return;
            event.preventDefault();
            event.stopPropagation();
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, []);
        const tab = tabs.find((item) => item.id === activeId) || tabs[0];
        // In-result search. The match set must be derived from the rows the grid
        // actually renders: a console tab shows `tab.rows` once a query has landed
        // (the same array the grid is handed) and nothing while it is still busy.
        // These hooks live ABOVE the `if (!tab)` early return below — a hook after
        // a conditional return changes the hook count between renders (React #310).
        const searchRows = !tab
          ? []
          : (tab.columns ? tab.rows : ((tab.result && tab.result.rows) || []));
        // Re-filtering on the rows' identity means an edit updates the match set
        // live. No query means no highlighting at all (`hits` stays empty).
        //
        // The empty case returns one shared Set rather than a fresh one: a new
        // Set on every render would give `hits` a new identity each time, which
        // invalidates the `[hits]` memo below and re-runs the grid effect keyed
        // on it — a full re-render of the result pane per keystroke, for nothing.
        const hits = React.useMemo(
          () => (query.trim() !== "" ? matchRowIndexes(searchRows, query) : NO_HITS),
          [query, searchRows],
        );
        const hitList = React.useMemo(() => (hits === NO_HITS ? NO_HITS_LIST : [...hits].sort((a, b) => a - b)), [hits]);
        // Keep the cursor inside the current match list as the query or rows change.
        React.useEffect(() => {
          setHitCursor((prev) => (hitList.length === 0 ? -1 : (prev >= 0 && prev < hitList.length ? prev : 0)));
        }, [hitList.length, query]);
        const strip = h("div", { className: "ddb-tabs" },
          tabs.map((item) => {
            // A single-table result (preview or query) is `database.table`. Anything
            // that does not resolve to one table keeps the console or SQL label.
            const label = resultTabName(item.table) || item.consoleTitle || item.title;
            return h("div", {
              key: item.id,
              className: "ddb-tab" + (item.id === activeId ? " ddb-on" : ""),
              onClick: () => activateTab(item.id),
              onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
              onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(item.id); } },
              onContextMenu: (event) => {
                event.preventDefault();
                event.stopPropagation();
                setResultMenu({ id: item.id, x: event.clientX, y: event.clientY });
              },
            },
              h("span", { className: "ddb-tab-title", title: label }, label),
              item.kind === "console" ? h("button", {
                type: "button",
                className: "ddb-tab-pin" + (item.pinned ? " ddb-on" : ""),
                ...tip(item.pinned ? t("unpinResult") : t("pinResult")),
                onClick: (e) => {
                  e.stopPropagation();
                  patchTab(tabsBus, item.id, { pinned: item.pinned !== true });
                },
              }, h(PinIcon, { on: item.pinned === true })) : null,
              h("button", {
                type: "button",
                className: "ddb-tab-x",
                ...tip(t("closeTab"), closeChord()),
                onClick: (e) => { e.stopPropagation(); closeTab(item.id); },
              }, "×"),
            );
          }),
          !consoleId && !tabId ? h(React.Fragment, null,
            h("span", { className: "ddb-tabs-gap" }),
            h("button", {
              type: "button",
              className: "ddb-dock-close",
              ...tip(t("collapseDock")),
              onClick: closeDbDock,
            }, "▾"),
          ) : null,
        );
        if (!tab) {
          if (consoleId || tabId) return null;
          return h(React.Fragment, null, strip, h("div", { className: "ddb-empty" }, t("pickTable")));
        }
        // Both a table preview and a SQL console result render through this one path.
        // A console result is just a read-only tab: same grid, same selection, same
        // bar and header layout. Only the header actions differ (export vs add/commit)
        // and the row menu's destructive entry (clear selection vs delete).
        const isConsole = tab.kind === "console";
        const view = isConsole
          ? {
              ...resultTab(tab.result, tab.sql),
              id: tab.id,
              // The fetch-on-edit path keys its reply to the row set on screen,
              // which is not the in-flight `runSeq`: that moves before these
              // rows are replaced. `fullCells` is the set already read in full.
              consoleId: tab.consoleId,
              rowsGen: tab.rowsGen || 0,
              fullCells: tab.fullCells || {},
              // Edits are written onto the console tab itself (via patchEdit), so read
              // them back here; re-deriving from `result` would drop pending changes.
              ...(tab.columns ? {
                columns: tab.columns,
                rows: tab.rows,
                original: tab.original,
                kinds: tab.kinds,
                pk: tab.pk,
                table: tab.table,
                // Column comments load asynchronously onto the tab; the derived view
                // must carry them or the console grid's header would never show them.
                comments: tab.comments,
                // `editing` must be carried over too, or the cell editor opened by a
                // double-click / new row would be dropped on the very next render.
                editing: tab.editing,
              } : {}),
              // Writable is decided by the host and stored on the tab by editablePatch.
              // Read the tab's own value first: `resultTab` derives it from `result`,
              // which an error patch or a paged result can replace without the flag.
              writable: tab.writable !== undefined ? tab.writable : resultTab(tab.result, tab.sql).writable,
              affected: tab.affected,
              command: tab.command || (tab.result && tab.result.command) || "",
              status: tab.status || "",
              selected: tab.selected || {},
              selectedCol: tab.selectedCol,
            }
          : tab;
        const canWrite = isConsole ? view.writable === true : true;
        // UPDATE and friends are not a JOIN. Don't label the disabled actions as one.
        const writeNote = writeStatus(view, t);
        // A console tab keeps the failure message in both `error` and a synthetic result;
        // the grid is rendered either way, so the row menu needs to know it is not data.
        const failed = isConsole && !!tab.error && view.writable !== true;
        const selectedCount = Object.keys(view.selected || {}).length;
        const delCount = (tab.kinds || []).filter((k) => k === "del").length;
        const dirty = !isConsole ? tabIsDirty(tab) : tabIsDirty(view);
        const busy = isConsole ? tab.busy && !tab.result : false;
        const addRow = () => {
          patchEdit(tab, (cur) => ({
            ...cur,
            rows: cur.rows.concat([cur.columns.map(() => null)]),
            original: cur.original.concat([null]),
            kinds: (cur.kinds || []).concat(["new"]),
            focusNew: true,
            editing: { ri: cur.rows.length, ci: 0 },
          }));
        };
        const deleteSelected = () => {
          patchEdit(tab, (cur) => {
            const selected = cur.selected || {};
            const rows = [];
            const original = [];
            const kinds = [];
            cur.rows.forEach((row, i) => {
              const kind = (cur.kinds || [])[i] || "old";
              if (selected[i] && kind === "new") return;
              rows.push(row);
              original.push(cur.original[i]);
              kinds.push(selected[i] && kind === "old" ? "del" : kind);
            });
            return { ...cur, rows, original, kinds, selected: {} };
          });
        };
        const clearSelection = () => patchEdit(tab, { selected: {}, selectedCol: -1, editing: null });
        // Re-fetch whatever produced this result, keeping the current page window.
        // A table preview re-runs its `/preview`, a console result re-runs its SQL;
        // both already exist as the pager's own handlers, so refresh is just them
        // with the tab's current offset/limit. A full (`All`) result stays full.
        const canRefresh = isConsole ? !!tab.sql : !!(tab.table && !tab.consoleId);
        const refreshResult = () => {
          const opts = { offset: tab.all ? 0 : (tab.offset || 0), limit: tab.limit || PAGE_SIZE, all: tab.all === true };
          if (isConsole) runResultPage(tab, opts);
          else loadTablePage(tab, opts);
        };
        // The raw in-flight flags, not the derived `busy`: a refresh keeps the old
        // rows on screen (so `busy` stays false), but the button must still be
        // disabled or a second click would run the query again.
        const refreshing = isConsole ? tab.busy === true : tab.loading === true;
        return h(React.Fragment, null,
          strip,
          h("div", { className: "ddb-pane" },
            // The result bar lives ABOVE the grid, with the grid actions first so
            // they occupy the top-left corner. Everything that describes or acts on
            // the rows below sits here, out of the way of the data itself.
            h("div", { className: "ddb-bar" },
              // In-result search leads the bar: the box itself sits in the old
              // magnifier slot (top-left), always visible, so there is no icon to
              // toggle and no hidden state. `Enter` / `Shift+Enter` walk the
              // matches, `Esc` clears the query. Matching is over the loaded page.
              h("span", { className: "ddb-search" },
                h("input", {
                  ref: searchRef,
                  className: "ddb-search-input",
                  value: query,
                  placeholder: t("searchResultPlaceholder"),
                  "aria-label": t("searchResultPlaceholder"),
                  title: t("searchResultHint", { key: FIND_KEY }),
                  onChange: (e) => { setQuery(e.target.value); setHitCursor(0); },
                  onKeyDown: (e) => {
                    if (e.key === "Escape") { e.preventDefault(); clearSearch(); }
                    else if (e.key === "Enter") {
                      e.preventDefault();
                      if (hitList.length) setHitCursor((prev) => (prev + (e.shiftKey ? -1 : 1) + hitList.length) % hitList.length);
                    }
                  },
                }),
                h("span", { className: "ddb-search-count" + (query.trim() !== "" && hitList.length === 0 ? " ddb-search-none" : "") },
                  query.trim() === "" ? "" : (hitList.length ? t("searchMatches").replace("{n}", String(hitList.length)) : t("searchNoMatch"))),
              ),
              // The grid actions follow: top-left, next to the table.
              h("span", { className: "ddb-bar-actions" },
                h("button", {
                  type: "button",
                  className: "ddb-btn ddb-btn-ghost ddb-icon-btn",
                  ...(canRefresh ? tip(t("refreshResult")) : tip(t("pickTable"))),
                  disabled: !canRefresh || refreshing,
                  onClick: refreshResult,
                }, h(RefreshIcon)),
                h("button", {
                  type: "button",
                  className: "ddb-btn ddb-btn-ghost ddb-icon-btn",
                  ...tip(t("exportResult")),
                  disabled: !view.columns || !view.columns.length,
                  onClick: () => exportQueryResult(tab, view),
                }, h(DownloadIcon)),
                h("button", {
                  type: "button",
                  className: "ddb-btn ddb-btn-ghost ddb-icon-btn",
                  ...(canWrite ? tip(t("addRow")) : { title: writeNote || t("readOnlyQuery"), "aria-label": t("addRow") }),
                  disabled: !canWrite,
                  onClick: addRow,
                }, h(PlusIcon, { size: ICON })),
                h("button", {
                  type: "button",
                  className: "ddb-btn ddb-btn-primary ddb-icon-btn",
                  ...(canWrite ? tip(t("submit"), dbChordLabel("database.runSql")) : { title: writeNote || t("readOnlyQuery"), "aria-label": t("submit") }),
                  disabled: !canWrite || !dirty,
                  // Blurring the open cell editor re-renders this bar before `click`,
                  // and the click never lands on the new button. Keep focus so the
                  // first click after an edit actually commits.
                  onMouseDown: (e) => { if (e.button === 0) e.preventDefault(); },
                  onClick: submitEdits,
                }, h(CheckIcon)),
              ),
              h("span", { className: "ddb-bar-status" }, tab.status || (canWrite ? t("submitHint", { run: dbChordLabel("database.runSql") }) : t("readOnlyQuery"))),
              !isConsole && tab.table && !tab.consoleId ? h(Pager, { tab, onPage: loadTablePage }) : null,
              // A write has no field list. The pager would render "1–0 / 0".
              isConsole && tab.sql && view.columns && view.columns.length ? h(Pager, { tab, onPage: runResultPage }) : null,
              delCount ? h("span", null, t("pendingDel") + " · " + delCount) : null,
              selectedCount ? h("button", {
                type: "button",
                className: "ddb-bar-sel",
                ...tip(t("clearSel")),
                onClick: clearSelection,
              }, t("selRows").replace("{n}", String(selectedCount)) + " ×") : null,
            ),
            busy
              ? h("div", { className: "ddb-empty" }, t("loading"))
              : h(EditableGrid, {
                  tab: view,
                  onRowMenu: (e, ri, ci) => setRowMenu({ x: e.clientX, y: e.clientY, ri, ci }),
                  hits: query.trim() !== "" ? hits : null,
                  currentHit: hitCursor >= 0 && hitList.length ? hitList[hitCursor] : null,
                }),
          ),
          rowMenu ? h("div", {
            className: "ddb-menu",
            style: { left: Math.min(rowMenu.x, window.innerWidth - 180), top: Math.min(rowMenu.y, window.innerHeight - 130) },
            onClick: (e) => e.stopPropagation(),
          },
            h("button", { type: "button", disabled: selectedCount === 0, ...tip(t(rowMenuCopyMode(view, failed) === "insert" ? "copyInsert" : "copy"), copyChord()), onClick: () => { copyFromRowMenu(view, failed); setRowMenu(null); } }, t(rowMenuCopyMode(view, failed) === "insert" ? "copyInsert" : "copy")),
            canWrite && typeof rowMenu.ri === "number" && typeof rowMenu.ci === "number" ? h("button", {
              type: "button",
              ...tip(t("setNull")),
              onClick: () => {
                const { ri, ci } = rowMenu;
                patchEdit(tab, (cur) => {
                  if (!cur.rows || !cur.rows[ri]) return cur;
                  const rows = cur.rows.slice();
                  rows[ri] = rows[ri].slice();
                  rows[ri][ci] = null;
                  return { ...cur, rows, editing: null };
                });
                setRowMenu(null);
              },
            }, t("setNull")) : null,
            h("button", {
              type: "button",
              disabled: selectedCount === 0 || !canWrite,
              ...tip(t("delete")),
              onClick: () => { deleteSelected(); setRowMenu(null); },
            }, t("delete")),
          ) : null,
          resultMenu ? h("div", {
            className: "ddb-menu",
            style: { left: Math.min(resultMenu.x, window.innerWidth - 180), top: Math.min(resultMenu.y, window.innerHeight - 100) },
            onClick: (e) => e.stopPropagation(),
          },
            h("button", { type: "button", onClick: () => { closeTab(resultMenu.id); setResultMenu(null); } }, t("closeTab")),
            h("button", { type: "button", onClick: () => { closeAllTabs(); setResultMenu(null); } }, t("closeAllTabs")),
          ) : null,
        );
      }

      // SQL editor: CodeMirror 6, loaded lazily from the plugin's own route.
      //
      // The DSH client module table is a frozen whitelist, so CodeMirror cannot be
      // `require`d here; `scripts/build-vendor.mjs` bundles it into
      // `lib/vendor/codemirror.js` and the server half serves that over
      // `<PREFIX>/vendor/codemirror.js`. The first editor mount injects one classic
      // <script> (shared by every console via a single promise) and reads the
      // `__ddbCodeMirror` global it defines.
      //
      // If that script fails to load — a stale package without the artifact, an
      // offline host — the editor falls back to the plain textarea it used before,
      // so the console always stays usable.
      //
      // Describing a table the user merely typed requires knowing where it lives, and the
      // tree's depth differs per engine: PostgreSQL nests database → schema → table, while
      // MySQL and Oracle expose their schemas one level down. Walk one or two levels under
      // the console's current database and take the first matching table; results are
      // cached so repeated F1 presses do not re-walk the tree.
      const schemaCache = new Map();

      async function resolveTableNode(connId, database, rawName) {
        const name = String(rawName || "").replace(/^["`\[]|["`\]]$/g, "").trim();
        if (!connId || !name) return null;
        const base = { kind: "table", connId, database: database || "", name };
        const cacheKey = connId + "::" + (database || "") + "::" + name.toLowerCase();
        const hit = schemaCache.get(cacheKey);
        if (hit) return { ...base, name: hit.name || name, schema: hit.schema, tableType: hit.tableType };
        const childPath = async (path) => {
          try { return (await api("/children", { id: connId, path })).items || []; }
          catch { return []; }
        };
        const matchIn = (items) => items.find((item) => item.kind === "table" && String(item.name).toLowerCase() === name.toLowerCase());
        // Always carry the catalogue's own spelling back: the lookup is case-insensitive,
        // but the follow-up structure query matches the name exactly, so echoing the user's
        // casing (e.g. an all-caps `LG_ORDER`) would find the table yet return no columns.
        const remember = (found, schema) => {
          const node = { ...base, name: String(found.name || name), schema: found.schema || schema || "", tableType: found.tableType };
          schemaCache.set(cacheKey, { name: node.name, schema: node.schema, tableType: node.tableType });
          return node;
        };
        const roots = await childPath({ kind: "root" });
        // Level 1: databases (PostgreSQL) or schemas (MySQL / Oracle).
        const containers = roots.filter((item) => item.kind === "database" || item.kind === "schema");
        // Prefer the console's own database so an identically named table elsewhere does
        // not shadow the one the user is actually querying.
        containers.sort((a, b) => {
          const want = String(database || "").toLowerCase();
          return (String(a.name).toLowerCase() === want ? 0 : 1) - (String(b.name).toLowerCase() === want ? 0 : 1);
        });
        for (const container of containers) {
          if (container.kind === "schema") {
            const found = matchIn(await childPath({ kind: "schema", name: container.name, database: database || container.name }));
            if (found) return remember(found, container.name);
            continue;
          }
          // A database may hold the table directly (MySQL-style) or only schemas
          // (PostgreSQL), so look at the container itself first, then one level deeper.
          const direct = matchIn(await childPath({ kind: "database", name: container.name }));
          if (direct) return remember(direct, container.name);
          const schemas = (await childPath({ kind: "database", name: container.name }))
            .filter((item) => item.kind === "schema");
          for (const schema of schemas) {
            const found = matchIn(await childPath({ kind: "schema", name: schema.name, database: container.name }));
            if (found) return remember(found, schema.name);
          }
        }
        return null;
      }

      // Screen rect of the textarea's current selection, so the structure popover can open
      // next to the table name the user selected rather than in the middle of the window.
      // A mirror element reproduces the text up to the selection start to find the caret,
      // because a textarea exposes no geometry API for its contents.
      function selectionAnchorIn(ta) {
        if (!ta) return null;
        const box = ta.getBoundingClientRect();
        if (!box.width && !box.height) return null;
        try {
          const style = window.getComputedStyle(ta);
          const mirror = document.createElement("div");
          // Mirror the exact text metrics and wrapping behaviour of the textarea.
          ["font", "fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing",
            "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
            "borderLeftWidth", "whiteSpace", "wordWrap", "overflowWrap", "tabSize"].forEach((prop) => {
            mirror.style[prop] = style[prop];
          });
          mirror.style.position = "absolute";
          mirror.style.visibility = "hidden";
          mirror.style.left = "-9999px";
          mirror.style.top = "0";
          mirror.style.width = box.width + "px";
          mirror.style.boxSizing = "border-box";
          mirror.style.whiteSpace = "pre-wrap";
          mirror.style.overflowWrap = "break-word";
          const start = ta.selectionStart;
          const marker = document.createElement("span");
          // A zero-width marker sits exactly at the selection start.
          marker.textContent = "\u200b";
          mirror.textContent = ta.value.slice(0, start);
          mirror.appendChild(marker);
          document.body.appendChild(mirror);
          const markerBox = marker.getBoundingClientRect();
          const mirrorBox = mirror.getBoundingClientRect();
          const lineHeight = parseFloat(style.lineHeight) || markerBox.height || 19;
          // Offset from the visible top-left of the textarea's content box, minus scroll.
          const x = box.left + (markerBox.left - mirrorBox.left) - ta.scrollLeft;
          const y = box.top + (markerBox.top - mirrorBox.top) - ta.scrollTop;
          document.body.removeChild(mirror);
          // Clamp into the textarea so a scrolled-away selection still yields a sane anchor.
          const left = Math.min(Math.max(x, box.left + 4), box.right - 8);
          const top = Math.min(Math.max(y, box.top + 2), box.bottom - 8);
          return { left, right: left + 2, top, bottom: top + lineHeight, source: "editor" };
        } catch {
          return { left: box.left, right: box.left + 2, top: box.top, bottom: box.top + 20, source: "editor" };
        }
      }

      // ---------------------------------------------------------------------
      // Lazy CodeMirror loader
      //
      // One <script> for the whole page: every console shares this promise, so two
      // open consoles do not fetch the artifact twice. A failure clears the cached
      // promise, so a later mount retries rather than staying broken for the session.
      // ---------------------------------------------------------------------
      const CM_SRC = API + "/vendor/codemirror.js";
      let cmLoad = null;

      function loadCodeMirror() {
        if (window.__ddbCodeMirror) return Promise.resolve(window.__ddbCodeMirror);
        if (cmLoad) return cmLoad;
        cmLoad = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = CM_SRC;
          script.async = true;
          script.onload = () => {
            if (window.__ddbCodeMirror) resolve(window.__ddbCodeMirror);
            else reject(new Error("codemirror: global missing"));
          };
          script.onerror = () => reject(new Error("codemirror: load failed"));
          document.head.appendChild(script);
        });
        cmLoad.catch(() => { cmLoad = null; });
        return cmLoad;
      }

      // The console's connection picks the dialect; anything unrecognised (or a Redis
      // connection, which shares this editor) falls back to standard SQL.
      function dialectFor(cm, type) {
        if (type === "postgres") return cm.PostgreSQL;
        if (type === "mysql") return cm.MySQL;
        if (type === "oracle") return cm.PLSQL;
        return cm.StandardSQL;
      }

      // CodeMirror needs a dark flag of its own for the styles it ships (selection
      // fill, caret, gutters). The host announces the theme by setting
      // `data-ds-dark-theme` on <body>, so this reads the same signal.
      function isDarkTheme() {
        try { return document.body.hasAttribute("data-ds-dark-theme"); } catch { return false; }
      }

      // Re-run `fn` whenever the host flips the theme, so a mounted editor picks the
      // new flag up instead of keeping the one it was created with.
      function watchTheme(fn) {
        try {
          const observer = new MutationObserver(fn);
          observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
          return () => observer.disconnect();
        } catch {
          return () => {};
        }
      }

      // Editor colours. These mirror the host's alias tokens rather than hard-coding a
      // palette, so the editor follows the app theme in both modes: light values are
      // the base, and the dark override lives in STYLE under `[data-ds-dark-theme]`.
      // Drawn from the IDEA/Darcula hues the rest of the plugin already echoes.
      //
      // Order is load-bearing, not cosmetic. `@codemirror/lang-sql` tags a plain
      // identifier as `name`, a quoted one as `special(string)`, a bind variable as
      // `special(name)` and a builtin as `standard(name)`; an element carrying a
      // specific tag also carries its general ancestor, so both classes land on it and
      // the LATER CSS rule wins (all are single-class selectors, so specificity ties).
      // The general `name` rule therefore has to come first, with each specific flavour
      // after it, or the fallback would flatten every identifier to one colour.
      function editorHighlightStyle(cm) {
        const { HighlightStyle, tags } = cm;
        return HighlightStyle.define([
          { tag: tags.name, color: "var(--ddb-cm-ident)" },
          { tag: tags.string, color: "var(--ddb-cm-string)" },
          { tag: tags.special(tags.string), color: "var(--ddb-cm-ident)" },
          { tag: tags.standard(tags.name), color: "var(--ddb-cm-builtin)" },
          { tag: tags.special(tags.name), color: "var(--ddb-cm-var)" },
          { tag: tags.keyword, color: "var(--ddb-cm-keyword)" },
          { tag: tags.typeName, color: "var(--ddb-cm-type)" },
          { tag: tags.number, color: "var(--ddb-cm-number)" },
          { tag: tags.bool, color: "var(--ddb-cm-number)" },
          { tag: tags.null, color: "var(--ddb-cm-number)" },
          { tag: [tags.lineComment, tags.blockComment], color: "var(--ddb-cm-comment)", fontStyle: "italic" },
          { tag: [tags.operator, tags.punctuation, tags.paren, tags.brace, tags.squareBracket], color: "var(--ddb-cm-punct)" },
          { tag: tags.invalid, color: "var(--ddb-cm-invalid)" },
        ]);
      }

      // Replace-all builds one change per hit and applies them in a single
      // transaction. Past this many hits the view spends long enough assembling
      // that the panel looks hung, so the sweep is refused instead of attempted.
      const REPLACE_MAX = 5000;

      // Case-fold without moving indexes. `toLowerCase()` can change the length
      // (Turkish İ), and a drifted index would select the wrong span in the editor.
      // When that happens, fold ASCII only — still length-stable.
      function caseFold(text) {
        const raw = String(text || "");
        const lower = raw.toLowerCase();
        if (lower.length === raw.length) return lower;
        return raw.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
      }

      // Start offsets of `query` in `text`, case-insensitive, non-overlapping.
      // An empty query matches nothing: the caller treats that as search off.
      // `max` lets replace-all stop collecting once it knows the sweep is too
      // large, instead of materializing every offset first and then refusing.
      function sqlMatchStarts(text, query, max) {
        const needle = caseFold(String(query == null ? "" : query).trim());
        if (!needle) return [];
        const hay = caseFold(text);
        const starts = [];
        let at = 0;
        while (at <= hay.length - needle.length) {
          const found = hay.indexOf(needle, at);
          if (found < 0) break;
          starts.push(found);
          if (max && starts.length >= max) break;
          at = found + needle.length;
        }
        return starts;
      }

      // Which match Enter should land on.
      // Forward: the match under the caret if it is not already selected, otherwise
      // the next one, wrapping to the first. Backward is the mirror, so a repeat
      // Enter walks the hits instead of re-selecting the one already on screen.
      function sqlMatchIndex(starts, needleLen, selFrom, selTo, dir) {
        const count = starts.length;
        if (!count) return -1;
        const onMatch = selTo === selFrom + needleLen && starts.indexOf(selFrom) !== -1;
        if (dir < 0) {
          const limit = onMatch ? selFrom : selFrom + 1;
          for (let i = count - 1; i >= 0; i--) {
            if (starts[i] < limit) return i;
          }
          return count - 1;
        }
        if (!onMatch) {
          for (let i = 0; i < count; i++) {
            if (starts[i] <= selFrom && selFrom < starts[i] + needleLen) return i;
          }
        }
        const origin = onMatch ? selFrom + 1 : selFrom;
        for (let i = 0; i < count; i++) {
          if (starts[i] >= origin) return i;
        }
        return 0;
      }

      function SqlEditor({ value, onChange, onRun, onBind, onLocate, onReplace, onTableName, connType }) {
        const text = value || "";
        const taRef = React.useRef(null);
        // The CodeMirror view lives in a ref, not state: it is created once and then
        // driven imperatively, and re-rendering on every keystroke would fight it.
        const hostRef = React.useRef(null);
        const viewRef = React.useRef(null);
        const cmRef = React.useRef(null);
        // CodeMirror's dark flag is a facet, not a CSS variable, so it cannot follow
        // the theme by itself: a compartment holds it and a body observer swaps the
        // value in place when the host flips.
        const themeRef = React.useRef(null);
        // Same idea for the SQL dialect: the console's connection row can arrive after
        // the editor is built (connections load asynchronously), and reconfiguring the
        // language in place keeps the text, cursor and undo history intact.
        const langRef = React.useRef(null);
        const changeRef = React.useRef(onChange);
        const runRef = React.useRef(onRun);
        const tableRef = React.useRef(onTableName);
        // `false` until the vendor script resolves; `true` only once a view exists.
        const [ready, setReady] = React.useState(false);
        // A failed load retries once (see the catch below); this counter re-runs the
        // build effect for that retry.
        const [retry, setRetry] = React.useState(0);
        const retriedRef = React.useRef(false);

        changeRef.current = onChange;
        runRef.current = onRun;
        tableRef.current = onTableName;

        const selectedSql = () => {
          const view = viewRef.current;
          if (view) {
            const { from, to } = view.state.selection.main;
            return from === to ? "" : view.state.sliceDoc(from, to);
          }
          const el = taRef.current;
          if (!el || el.selectionStart === el.selectionEnd) return "";
          return text.slice(el.selectionStart, el.selectionEnd);
        };
        // What ⌘Enter runs: the selection when there is one, the whole buffer otherwise.
        const sqlToRun = () => {
          const sel = selectedSql();
          return sel.trim() ? sel : (viewRef.current ? viewRef.current.state.doc.toString() : text);
        };
        const runNow = () => runRef.current(sqlToRun());

        // The buffer and caret the search box walks. The plain textarea is only
        // live until CodeMirror mounts; after that the view is the source of truth.
        const editorCaret = () => {
          const view = viewRef.current;
          if (view) {
            const sel = view.state.selection.main;
            return { doc: view.state.doc.toString(), from: sel.from, to: sel.to };
          }
          const el = taRef.current;
          if (el) return { doc: el.value, from: el.selectionStart, to: el.selectionEnd };
          return { doc: text, from: 0, to: 0 };
        };
        // Select `from`–`to` and scroll that span into the middle of the editor.
        // Focus stays in the search field: moving it here would make the next
        // Enter insert a newline (or run SQL) instead of walking to the next hit.
        const revealRange = (from, to) => {
          const view = viewRef.current;
          const cm = cmRef.current;
          if (view && cm) {
            const len = view.state.doc.length;
            const a = Math.max(0, Math.min(from, len));
            const b = Math.max(a, Math.min(to, len));
            view.dispatch({
              selection: { anchor: a, head: b },
              effects: cm.EditorView.scrollIntoView(cm.EditorSelection.range(a, b), { y: "center" }),
            });
            return;
          }
          const el = taRef.current;
          if (!el) return;
          const len = el.value.length;
          const a = Math.max(0, Math.min(from, len));
          const b = Math.max(a, Math.min(to, len));
          el.setSelectionRange(a, b);
          const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight) || 21;
          const line = el.value.slice(0, a).split("\n").length - 1;
          el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 2);
        };
        const locateQuery = (query, dir) => {
          const needle = String(query || "").trim();
          const { doc, from, to } = editorCaret();
          const starts = sqlMatchStarts(doc, needle);
          if (!starts.length) return { index: -1, count: 0 };
          const index = sqlMatchIndex(starts, needle.length, from, to, dir);
          const start = starts[index];
          revealRange(start, start + needle.length);
          return { index, count: starts.length };
        };

        // Replace edits through a CodeMirror transaction, not by handing a whole
        // new buffer to `onChange`: the update listener already reports the new
        // text, and a transaction keeps the caret, the scroll position and the
        // undo history intact instead of rebuilding the document.
        const applyChanges = (changes) => {
          const view = viewRef.current;
          if (view) {
            view.dispatch({ changes });
            return;
          }
          const el = taRef.current;
          if (!el) return;
          // Plain-textarea fallback, which only exists until CodeMirror resolves
          // (or forever, if it failed to load). Right to left, so the offsets
          // collected from the old buffer stay valid.
          for (let i = changes.length - 1; i >= 0; i--) {
            const row = changes[i];
            el.setRangeText(String(row.insert), row.from, row.to, "preserve");
          }
          changeRef.current(el.value);
        };
        // Replace the hit the caret stands on, then walk to the next one. The hit
        // list is the same one Enter uses, so the two can never disagree about
        // which span is being edited.
        const replaceOne = (query, replacement) => {
          const needle = String(query || "").trim();
          if (!needle) return { replaced: 0, count: 0 };
          const { doc, from, to } = editorCaret();
          const starts = sqlMatchStarts(doc, needle);
          if (!starts.length) return { replaced: 0, count: 0 };
          // Not standing on a hit: land on one the way Enter does. Replacing
          // whatever the caret happens to touch would edit text nobody pointed at.
          if (to !== from + needle.length || starts.indexOf(from) < 0) {
            locateQuery(needle, 1);
            return { replaced: 0, count: starts.length };
          }
          const insert = String(replacement == null ? "" : replacement);
          applyChanges([{ from, to, insert }]);
          // Step *past* the inserted text before looking for the next hit.
          // CodeMirror maps the old selection over the replacement, so without
          // this the next hit found can be inside the text just inserted, and
          // Enter would keep replacing the same prefix instead of advancing.
          const end = from + insert.length;
          revealRange(end, end);
          locateQuery(needle, 1);
          return { replaced: 1, count: sqlMatchStarts(editorCaret().doc, needle).length };
        };
        // One transaction for the whole sweep: one undo step, one re-render, and
        // no offset drift from replacing hit by hit.
        const replaceAll = (query, replacement) => {
          const needle = String(query || "").trim();
          if (!needle) return { replaced: 0 };
          const doc = editorCaret().doc;
          // Stop one past the cap: enough to report "too many" without building
          // an offset list for the whole script.
          const starts = sqlMatchStarts(doc, needle, REPLACE_MAX + 1);
          if (!starts.length) return { replaced: 0 };
          // A one-character query in a long script would build a change per
          // character and lock the view up; refuse instead of freezing.
          if (starts.length > REPLACE_MAX) return { replaced: 0, tooMany: true };
          const insert = String(replacement == null ? "" : replacement);
          applyChanges(starts.map((start) => ({ from: start, to: start + needle.length, insert })));
          revealRange(starts[0], starts[0] + insert.length);
          return { replaced: starts.length };
        };

        // F1 with a table name selected: hand the name (and a screen anchor for the
        // popover) up to the page. CodeMirror exposes real coordinates for a document
        // position, so no mirror element is needed here.
        const describeSelection = () => {
          const view = viewRef.current;
          if (!view || typeof tableRef.current !== "function") return false;
          const { from, to } = view.state.selection.main;
          const sel = view.state.sliceDoc(from, to).trim();
          if (!sel) return false;
          const anchor = view.coordsAtPos(from);
          return tableRef.current(sel, anchor ? { ...anchor, source: "editor" } : null);
        };

        // Build the editor once the vendor global is available. Runs once per mount:
        // the dialect and theme are both compartments so a later connection or theme
        // change reconfigures in place instead of rebuilding (which would drop the
        // text cursor and undo history).
        React.useEffect(() => {
          let alive = true;
          let view = null;
          loadCodeMirror()
            .then((cm) => {
              if (!alive || !hostRef.current) return;
              cmRef.current = cm;
              const { EditorState, EditorView, Prec } = cm;
              // Held in a compartment so the theme observer below can reconfigure it
              // without rebuilding the editor (which would lose selection and history).
              const themeCompartment = new cm.Compartment();
              themeRef.current = themeCompartment;
              const langCompartment = new cm.Compartment();
              langRef.current = langCompartment;
              const extensions = [
                cm.lineNumbers(),
                cm.highlightActiveLineGutter(),
                cm.highlightSpecialChars(),
                cm.history(),
                cm.drawSelection(),
                cm.highlightActiveLine(),
                cm.bracketMatching(),
                cm.indentOnInput(),
                cm.rectangularSelection(),
                cm.crosshairCursor(),
                cm.indentUnit.of("  "),
                cm.placeholder(t("sqlPlaceholder")),
                cm.syntaxHighlighting(editorHighlightStyle(cm)),
                langCompartment.of(cm.sql({ dialect: dialectFor(cm, connType) })),
                // `sql()` only registers the dialect's keywords as language data; this
                // extension is what actually shows them. `activateOnTyping` is on, and
                // the popup is styled under `.cm-tooltip-autocomplete` in STYLE.
                cm.autocompletion({ activateOnTyping: true, icons: false }),
                cm.EditorView.lineWrapping,
                // Rebinding-aware chords must run before CodeMirror's own keymaps:
                // Mod-Enter is bound to insertBlankLine by default, so an `_any`
                // keymap would never see it. `Prec.highest` puts this first.
                Prec.highest(EditorView.domEventHandlers({
                  keydown: (event) => {
                    if (dbChordHeld("database.runSql", event, ["Enter", "NumpadEnter"])) {
                      event.preventDefault();
                      runNow();
                      return true;
                    }
                    if (dbChordHeld("database.structure", event)) {
                      if (describeSelection()) {
                        event.preventDefault();
                        event.stopPropagation();
                        return true;
                      }
                    }
                    return false;
                  },
                })),
                cm.keymap.of([...cm.completionKeymap, ...cm.defaultKeymap, ...cm.historyKeymap, cm.indentWithTab]),
                EditorView.updateListener.of((update) => {
                  if (update.docChanged) changeRef.current(update.state.doc.toString());
                }),
                themeCompartment.of(EditorView.theme({}, { dark: isDarkTheme() })),
              ];
              view = new EditorView({
                state: EditorState.create({ doc: text, extensions }),
                parent: hostRef.current,
              });
              viewRef.current = view;
              setReady(true);
            })
            // A transient failure (host restarting, route not yet serving) gets one
            // retry rather than leaving the plain textarea for the rest of the session.
            .catch(() => {
              if (!alive) return;
              if (!retriedRef.current) {
                retriedRef.current = true;
                window.setTimeout(() => { if (alive) setRetry((n) => n + 1); }, 1500);
              }
            });
          return () => {
            alive = false;
            if (view) view.destroy();
            viewRef.current = null;
          };
        }, [retry]);

        // Keep the dialect in step with the console's connection without rebuilding.
        // The connection row often lands after this editor mounts, so this is the path
        // that actually applies the right keyword set on a normal open.
        React.useEffect(() => {
          const view = viewRef.current;
          const cm = cmRef.current;
          const compartment = langRef.current;
          if (!view || !cm || !compartment) return;
          view.dispatch({
            effects: compartment.reconfigure(cm.sql({ dialect: dialectFor(cm, connType) })),
          });
        }, [connType, ready]);

        // Follow a theme flip without rebuilding: the compartment swaps just the
        // dark flag, so selection, scroll and undo history survive the change.
        React.useEffect(() => {
          if (!ready) return undefined;
          return watchTheme(() => {
            const view = viewRef.current;
            const cm = cmRef.current;
            const compartment = themeRef.current;
            if (!view || !cm || !compartment) return;
            view.dispatch({
              effects: compartment.reconfigure(cm.EditorView.theme({}, { dark: isDarkTheme() })),
            });
          });
        }, [ready]);

        // Push external writes (restored console, programmatic edit) into the view
        // without echoing them back out as a change event.
        React.useEffect(() => {
          const view = viewRef.current;
          if (!view || !ready) return;
          const current = view.state.doc.toString();
          if (current === text) return;
          view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
        }, [text, ready]);

        React.useEffect(() => {
          if (typeof onBind === "function") onBind(sqlToRun);
          if (typeof onLocate === "function") onLocate(locateQuery);
          if (typeof onReplace === "function") onReplace({ one: replaceOne, all: replaceAll });
        });

        const onFallbackKeyDown = (e) => {
          if (dbChordHeld("database.runSql", e, ["Enter", "NumpadEnter"])) {
            e.preventDefault();
            runNow();
            return;
          }
          if (dbChordHeld("database.structure", e) && typeof tableRef.current === "function") {
            const el = taRef.current;
            const sel = el ? text.slice(el.selectionStart, el.selectionEnd).trim() : "";
            if (sel && tableRef.current(sel, selectionAnchorIn(el))) {
              e.preventDefault();
              e.stopPropagation();
            }
          }
        };

        return h("div", { className: "ddb-sql" },
          h("div", { className: "ddb-sql-wrap" },
            // The CodeMirror host stays mounted once the script resolves; until then it
            // is empty and the textarea below carries the editor. On a load failure the
            // textarea simply stays for good, which is the whole fallback.
            h("div", { className: "ddb-sql-host", ref: hostRef }),
            ready ? null : h("textarea", {
              ref: taRef,
              className: "ddb-sql-fallback",
              value: text,
              placeholder: t("sqlPlaceholder"),
              spellCheck: false,
              onChange: (e) => onChange(e.target.value),
              onKeyDown: onFallbackKeyDown,
            }),
          ),
        );
      }
      function SqlPage({ id, onHistory }) {
        const view = useBus(viewBus);
        const connections = useBus(connBus);
        const tabState = useBus(tabsBus);
        useBus(langBus);
        const item = view.consoles.find((row) => row.id === id);
        const [findOpen, setFindOpen] = React.useState(false);
        const getSqlRef = React.useRef(null);
        const locateRef = React.useRef(null);
        const replaceRef = React.useRef(null);
        const sqlSearchRef = React.useRef(null);
        const replaceInputRef = React.useRef(null);
        // ⌘F while the console has focus: the editor, the toolbar, or this box.
        // Replace has no chord of its own — it is the button next to the box.
        React.useEffect(() => {
          const onKey = (event) => {
            if (!isPlainFindKey(event)) return;
            const node = event.target;
            if (!node || typeof node.closest !== "function" || !node.closest(".ddb-sql-page")) return;
            setFindOpen(true);
            window.setTimeout(() => { try { focusFindInput(sqlSearchRef.current); } catch {} }, 0);
            event.preventDefault();
            event.stopPropagation();
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, []);
        // In-editor search. `sqlHit` is set only after Enter actually moves the
        // selection; typing alone just updates the count.
        const [sqlQuery, setSqlQuery] = React.useState("");
        const [sqlHit, setSqlHit] = React.useState(null);
        // Replace is opt-in: the row only exists while the button above it is on,
        // so the console keeps its usual height for readers who never replace.
        const [replaceOpen, setReplaceOpen] = React.useState(false);
        const [sqlReplace, setSqlReplace] = React.useState("");
        // What the last sweep did, shown in place of the counter for a moment.
        // The counter answers "where am I"; after a replace-all the question is
        // "how much did that touch".
        const [replaceNote, setReplaceNote] = React.useState("");
        const noteTimer = React.useRef(0);
        const sqlText = item ? (item.sql || "") : "";
        const sqlCount = React.useMemo(() => sqlMatchStarts(sqlText, sqlQuery).length, [sqlText, sqlQuery]);
        React.useEffect(() => {
          // A console switch starts a clean search: the old query, replacement
          // text and open replace row belong to the console that was left.
          setSqlQuery("");
          setSqlHit(null);
          setReplaceOpen(false);
          setSqlReplace("");
          setReplaceNote("");
          setFindOpen(false);
        }, [id]);
        React.useEffect(() => { setSqlHit(null); }, [sqlText, sqlQuery]);
        React.useEffect(() => { setReplaceNote(""); }, [sqlQuery]);
        React.useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current); }, []);

        // F1 in the editor: when the selected text names a table, describe it. The table
        // lives under the console's own connection and database, so the schema is resolved
        // by asking that connection which schema holds the name.
        const describeSelectedTable = (selection, anchor) => {
          if (!item || !item.connId) return false;
          // Accept a plain name, and also "schema.table" / a full statement that merely
          // contains the name, by trying each identifier in turn.
          const words = String(selection || "").split(/[^A-Za-z0-9_$\u00c0-\uffff]+/).filter(Boolean);
          const named = words.filter((word) => /^[A-Za-z_\u00c0-\uffff]/.test(word));
          if (!named.length) return false;
          (async () => {
            for (const word of named) {
              const node = await resolveTableNode(item.connId, item.database, word);
              // Anchor the popover to the selected text so it opens beside what was
              // selected instead of in the middle of the window.
              if (node) { loadStructure(anchor ? { ...node, __anchor: anchor } : node, false); return; }
            }
          })().catch(() => {});
          return true;
        };

        if (!item) return h("div", { className: "ddb-empty" }, t("pickConn"));
        const running = tabState.tabs.some((tab) => tab.consoleId === id && tab.busy);
        const closed = closedBus.getSnapshot();
        // Oracle's second picker lists schemas and empty means "stay on the login
        // schema", so it carries a schema-flavoured label rather than "Database".
        const ownerConn = connections.find((row) => row.id === item.connId);
        const oracleConn = !!ownerConn && ownerConn.type === "oracle";
        const sqlQueryOn = sqlQuery.trim() !== "";
        const sqlHitLabel = !sqlQueryOn
          ? ""
          : sqlCount === 0
            ? t("searchNoMatch")
            : (sqlHit && sqlHit.index >= 0 && sqlHit.count === sqlCount
              ? t("searchSqlPos").replace("{i}", String(sqlHit.index + 1)).replace("{n}", String(sqlHit.count))
              : t("searchSqlHits").replace("{n}", String(sqlCount)));
        const jumpSql = (dir) => {
          const fn = locateRef.current;
          if (typeof fn !== "function") return;
          setSqlHit(fn(sqlQuery, dir));
        };
        // The replacement itself is applied inside the editor, which owns the
        // buffer; this only reports back. A single replace says nothing — the
        // text under the cursor already changed, and the counter keeps its
        // meaning. A sweep reports how many spans it touched.
        const doReplace = (all) => {
          const api = replaceRef.current;
          if (!api || !sqlQueryOn) return;
          if (!all) { api.one(sqlQuery, sqlReplace); return; }
          const result = api.all(sqlQuery, sqlReplace);
          const note = result.tooMany
            ? t("replaceTooMany")
            : (result.replaced ? t("replaceDone").replace("{n}", String(result.replaced)) : t("replaceNone"));
          setReplaceNote(note);
          if (noteTimer.current) window.clearTimeout(noteTimer.current);
          noteTimer.current = window.setTimeout(() => setReplaceNote(""), 3200);
        };
        const showFind = findOpen || sqlQueryOn || replaceOpen;
        return h("div", { className: "ddb-sql-page" },
          h("div", { className: "ddb-sql-tools" },
            h("button", {
              type: "button",
              className: "ddb-tool",
              disabled: running || !item.connId,
              ...tip(t("run"), dbChordLabel("database.runSql")),
              onClick: () => runSql(id, getSqlRef.current ? getSqlRef.current() : undefined)
            }, h(RunIcon)),
            h("button", {
              type: "button",
              className: "ddb-tool",
              disabled: !running,
              ...tip(t("stop")),
              onClick: () => cancelConsole(id)
            }, h(StopIcon)),
            h("button", {
              type: "button",
              className: "ddb-tool",
              ...tip(t("closedConsoles")),
              onClick: (e) => {
                if (typeof onHistory !== "function") return;
                const rect = e.currentTarget.getBoundingClientRect();
                onHistory({ x: rect.left, y: rect.bottom + 4 });
              }
            }, h(HistoryIcon), closed.length ? h("span", { className: "ddb-history-count" }, String(closed.length)) : null),
            h("select", {
              "aria-label": t("rowLimit"),
              title: t("rowLimit"),
              value: String(maxRows),
              onChange: (e) => { maxRows = writeMaxRows(Number(e.target.value)); patchConsole(id, {}); },
            },
              ROW_LIMITS.map((n) => h("option", { key: n, value: String(n) }, t("rowLimitN", { n: String(n) }))),
            ),
            h("span", { className: "ddb-sql-spacer" }),
            h("select", {
              "aria-label": oracleConn ? t("pickDbOracle") : t("pickDb"),
              value: item.database || "",
              onChange: (e) => patchConsole(id, { database: e.target.value }),
            },
              h("option", { value: "" }, oracleConn ? t("pickDbOracle") : t("pickDb")),
              (item.dbOptions || []).map((opt) => h("option", { key: opt.value, value: opt.value }, opt.label)),
            ),
            h("select", {
              "aria-label": t("pickConn"),
              value: item.connId,
              onChange: (e) => {
                const connId = e.target.value;
                const next = connections.find((row) => row.id === connId);
                patchConsole(id, { connId, database: defaultConsoleDb(next), dbOptions: [], result: null, edit: null });
                loadConsoleDbs(id, connId);
                // A console opened from a .sql file owns that file's binding:
                // picking a data source here is the same choice as the file
                // bar's, and the editor's next save records it in the file.
                if (item.file) bindFileBinding(item.file, next, null);
              },
            },
              h("option", { value: "" }, t("pickConn")),
              connections.map((row) => h("option", { key: row.id, value: row.id }, row.name + " (" + row.type + ")")),
            ),
          ),
          showFind ? h("div", { className: "ddb-sql-find" },
            h("span", { className: "ddb-search" },
              h("input", {
                ref: sqlSearchRef,
                className: "ddb-search-input",
                value: sqlQuery,
                placeholder: t("searchSqlPlaceholder"),
                "aria-label": t("searchSqlPlaceholder"),
                title: t("searchSqlHint", { key: FIND_KEY }),
                spellCheck: false,
                onChange: (e) => setSqlQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.isComposing === true || e.keyCode === 229) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setSqlQuery("");
                    setFindOpen(false);
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "NumpadEnter") && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault();
                    jumpSql(e.shiftKey ? -1 : 1);
                  }
                },
              }),
              h("span", { className: "ddb-search-count" + (!replaceNote && sqlQueryOn && sqlCount === 0 ? " ddb-search-none" : "") }, replaceNote || sqlHitLabel),
              h("button", {
                type: "button",
                className: "ddb-search-step",
                "data-on": replaceOpen ? "true" : "false",
                "aria-expanded": replaceOpen ? "true" : "false",
                ...tip(t("replaceToggle")),
                onMouseDown: (e) => { if (e.button === 0) e.preventDefault(); },
                onClick: () => {
                  const next = !replaceOpen;
                  setReplaceOpen(next);
                  if (next) window.setTimeout(() => { const el = replaceInputRef.current; if (el) el.focus(); }, 0);
                },
              }, "⇄"),
              replaceOpen ? h("input", {
                ref: replaceInputRef,
                className: "ddb-search-input ddb-replace-input",
                value: sqlReplace,
                placeholder: t("replacePlaceholder"),
                "aria-label": t("replacePlaceholder"),
                title: t("replaceHint"),
                spellCheck: false,
                onChange: (e) => setSqlReplace(e.target.value),
                onKeyDown: (e) => {
                  if (e.isComposing === true || e.keyCode === 229) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setReplaceOpen(false);
                    try { if (sqlSearchRef.current) sqlSearchRef.current.focus(); } catch {}
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "NumpadEnter") && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault();
                    doReplace(false);
                  }
                },
              }) : null,
              replaceOpen ? h("button", {
                type: "button",
                className: "ddb-replace-btn",
                disabled: sqlCount === 0,
                ...tip(t("replaceOne"), "⏎"),
                onMouseDown: (e) => { if (e.button === 0) e.preventDefault(); },
                onClick: () => doReplace(false),
              }, t("replaceOne")) : null,
              replaceOpen ? h("button", {
                type: "button",
                className: "ddb-replace-btn",
                disabled: sqlCount === 0,
                ...tip(t("replaceAll")),
                onMouseDown: (e) => { if (e.button === 0) e.preventDefault(); },
                onClick: () => doReplace(true),
              }, t("replaceAll")) : null,
            ),
          ) : null,
          h("div", { className: "ddb-sql-body" },
            // A console that belongs to a .sql file says so: which file the text
            // is, that the next run re-reads it, and that unsaved editor changes
            // are not what runs.
            // A console that belongs to a .sql file says which file it is; the
            // data source and database are picked in the toolbar above, the
            // same pickers every console has. Picking one there binds the file,
            // so Run from the editor lands on the same database.
            item.file ? h("div", { className: "ddb-filebar" },
              h("span", { className: "ddb-filebar-path", title: item.file.rel }, item.file.rel),
              h("span", { className: "ddb-filebar-note" }, t("sqlFileRunsSaved"))) : null,
            h("div", { className: "ddb-sql-editor" },
              h(SqlEditor, {
                value: item.sql || "",
                connType: ownerConn ? ownerConn.type : "",
                onChange: (sql) => patchConsole(id, { sql }),
                onRun: (sql) => runSql(id, sql),
                onBind: (fn) => { getSqlRef.current = fn; },
                onLocate: (fn) => { locateRef.current = fn; },
                onReplace: (api) => { replaceRef.current = api; },
                onTableName: describeSelectedTable,
              }),
            ),
          ),
        );
      }

      // F1 popover: the selected table's columns, types and comments, IDEA-style. It is
      // pinned next to the tree row it describes and scrolls on its own, so a wide table
      // never pushes the studio layout around.
      function StructurePopover({ info, onClose }) {
        useBus(langBus);
        const ref = React.useRef(null);
        const [pos, setPos] = React.useState(null);
        React.useEffect(() => {
          const place = () => {
            const anchor = info.anchor;
            const node = ref.current;
            const width = node ? node.offsetWidth : 520;
            const height = node ? node.offsetHeight : 360;
            const vw = window.innerWidth || 1200;
            const vh = window.innerHeight || 800;
            const gap = 8;
            const edge = 8;
            const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
            if (!anchor) {
              setPos({ left: Math.round(Math.max(edge, (vw - width) / 2)), top: Math.round(Math.max(edge, (vh - height) / 2)) });
              return;
            }
            // Candidate placements, best first. The sidebar the editor lives in is usually
            // narrow, so opening to the SIDE keeps the SQL readable instead of covering the
            // lines under the selection; below/above are the fallbacks.
            const fitsV = (top) => top >= edge && top + height <= vh - edge;
            const fitsH = (left) => left >= edge && left + width <= vw - edge;
            const candidates = [
              // Right of the selected text, vertically centred on it.
              { left: anchor.right + gap, top: anchor.top - Math.min(24, height / 4) },
              // Left of the selected text.
              { left: anchor.left - gap - width, top: anchor.top - Math.min(24, height / 4) },
              // Below the selected text, aligned to its left edge.
              { left: anchor.left, top: anchor.bottom + gap },
              // Above the selected text.
              { left: anchor.left, top: anchor.top - gap - height },
            ];
            let chosen = null;
            for (const c of candidates) {
              if (fitsH(c.left) && fitsV(c.top)) { chosen = c; break; }
            }
            if (!chosen) {
              // Nothing fits cleanly (very small viewport): keep the vertical placement
              // below-or-above the anchor and clamp horizontally into view.
              const below = anchor.bottom + gap;
              const top = fitsV(below) ? below : clamp(anchor.top - gap - height, edge, Math.max(edge, vh - height - edge));
              chosen = { left: clamp(anchor.left, edge, Math.max(edge, vw - width - edge)), top };
            }
            // Final safety clamp so the popover is always fully on screen, then — only if
            // the clamped position happens to sit on top of the selected line AND moving
            // below it still fits — nudge it clear of the anchor. The nudge must re-check
            // the bottom bound, otherwise it would undo the clamp and push the popover off
            // screen (which is what a tall table used to do).
            let left = clamp(chosen.left, edge, Math.max(edge, vw - width - edge));
            let top = clamp(chosen.top, edge, Math.max(edge, vh - height - edge));
            const coversAnchor = left < anchor.right && left + width > anchor.left
              && top < anchor.bottom && top + height > anchor.top;
            if (coversAnchor) {
              const below = anchor.bottom + gap;
              if (below + height <= vh - edge) top = below;
            }
            setPos({ left: Math.round(left), top: Math.round(top) });
          };
          // Re-place once the content has been measured (a wide table changes the height).
          place();
          const raf = typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame(place)
            : null;
          const onResize = () => place();
          window.addEventListener("resize", onResize);
          return () => {
            if (raf !== null) { try { window.cancelAnimationFrame(raf); } catch {} }
            window.removeEventListener("resize", onResize);
          };
        }, [info, info.columns && info.columns.length, info.loading, info.error]);
        // Clicking anywhere outside the popover dismisses it, the way every other menu in
        // this plugin behaves. `mousedown` is used so the dismissal lands before a
        // drag-select inside the editor begins, and the popover's own mousedown is stopped
        // from reaching this handler so interacting with the table does not close it.
        // Keyed on `info.seq` (a new popover), not on `info` itself, so a slow /columns
        // reply swapping the object does not tear the listener down mid-interaction.
        React.useEffect(() => {
          let armed = false;
          const armTimer = window.setTimeout(() => { armed = true; }, 0);
          const onDown = (event) => {
            if (!armed) return;
            const node = ref.current;
            if (node && event.target && node.contains(event.target)) return;
            onClose();
          };
          window.addEventListener("mousedown", onDown, true);
          return () => {
            window.clearTimeout(armTimer);
            window.removeEventListener("mousedown", onDown, true);
          };
        }, [info.seq]);
        const columns = info.columns || [];
        const subtitle = [info.database, info.schema].filter(Boolean).join(" · ");
        return h("div", {
          className: "ddb-struct",
          ref,
          role: "dialog",
          "aria-label": t("structure"),
          tabIndex: -1,
          style: pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 },
          onMouseDown: (e) => e.stopPropagation(),
        },
          h("div", { className: "ddb-struct-head" },
            h("span", { className: "ddb-struct-name", title: info.name }, info.name),
            h("span", { className: "ddb-struct-tag" }, info.kind === "view" ? t("structureView") : t("structureTable")),
            info.loading ? h("span", { className: "ddb-struct-tag" }, t("loading")) : null,
            h("button", { type: "button", className: "ddb-tool", ...tip(t("structureClose"), "Esc"), onClick: onClose }, h(CloseIcon)),
          ),
          subtitle ? h("div", { className: "ddb-struct-sub" }, subtitle) : null,
          info.comment ? h("div", { className: "ddb-struct-sub" }, t("structureComment") + " · " + info.comment) : null,
          info.error
            ? h("div", { className: "ddb-struct-empty" }, info.error)
            : (!info.loading && columns.length === 0)
              ? h("div", { className: "ddb-struct-empty" }, t("structureEmpty"))
              : h("div", { className: "ddb-struct-body" },
                h("table", null,
                  h("thead", null, h("tr", null,
                    h("th", null, t("fieldName")),
                    h("th", null, t("fieldType")),
                    h("th", null, t("fieldNullable")),
                    h("th", null, t("fieldDefault")),
                    h("th", null, t("fieldComment")),
                  )),
                  h("tbody", null, columns.map((col, i) => h("tr", { key: col.name + ":" + i },
                    h("td", { className: "ddb-struct-col" },
                      col.primaryKey ? h("span", { className: "ddb-struct-pk", title: t("fieldPk") }, "🔑") : null,
                      col.name),
                    h("td", { className: "ddb-struct-type" }, (col.dataType || "") + (col.autoIncrement ? " · auto" : "")),
                    h("td", { className: "ddb-struct-null" }, col.nullable === false ? t("fieldNotNull") : t("fieldNull")),
                    h("td", { className: "ddb-struct-def" }, col.default === "" || col.default === undefined || col.default === null ? "—" : String(col.default)),
                    h("td", { className: "ddb-struct-cmt" }, col.comment ? String(col.comment) : ""),
                  ))),
                ),
              ),
        );
      }

      // A console result presented as a grid tab. `writable` comes from the host: false
      // for JOINs and other row-reshaping queries, in which case the write actions gray
      // out but export and selection stay available.
      function resultTab(result, sql) {
        const columns = (result && result.columns) || [];
        const rows = ((result && result.rows) || []).map((row) => (Array.isArray(row) ? row.slice() : columns.map((col) => row[col])));
        const target = (result && result.target) || null;
        return {
          kind: "table",
          writable: !!(result && result.writable),
          table: {
            name: target ? target.table : "",
            schema: target ? target.schema : "",
            database: (result && result.database) || "",
            connId: (result && result.connId) || "",
            type: (result && result.connType) || "postgres",
          },
          sql: sql || "",
          loading: false,
          error: "",
          columns,
          rows,
          original: rows.map((row) => row.slice()),
          kinds: rows.map(() => "old"),
          pk: (result && result.pk) || [],
          selected: {},
          selectedCol: -1,
          editing: null,
        };
      }

      function ExplorerBody() {
        const connections = useBus(connBus);
        const tree = useBus(treeBus);
        const confirm = useBus(confirmBus);
        useBus(tabsBus);
        const view = useBus(viewBus);
        const closed = useBus(closedBus);
        const structure = useBus(structBus);
        useBus(langBus);
        const [openModeState, setOpenModeState] = React.useState(openMode);
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
        const [dialog, setDialog] = React.useState(null);
        const [menu, setMenu] = React.useState(null);
        const [tabMenu, setTabMenu] = React.useState(null);
        const [renaming, setRenaming] = React.useState(null);
        const [closedMenu, setClosedMenu] = React.useState(null);
        const draftBus = React.useMemo(() => makeBus(blankDraft("postgres")), []);
        // Turning a stored connection into a draft: `schemas` is normalized to plain
        // names so the picker never sees a malformed value from an edited store file.
        const draftOf = (conn) => ({
          ...(conn || blankDraft("postgres")),
          password: "",
          schemas: (Array.isArray(conn && conn.schemas) ? conn.schemas : []).map((item) => String(item)),
        });
        const mainRef = React.useRef(null);
        const rootRef = React.useRef(null);
        // Last tree row the user selected, with its viewport rect, so F1 can pin the
        // structure popover to the row that is actually highlighted.
        const selectedRowRef = React.useRef(null);
        const treeBodyRef = React.useRef(null);
        // Set by keyboard movement. The row is not in the DOM until the render
        // that applies `active`, so the scroll and focus happen in the effect.
        const pendingTreeFocus = React.useRef(false);
        // Key repeat arrives before the render that commits `active`. The ref is
        // the cursor those repeats walk; a click's render writes the bus value back.
        const treeCursor = React.useRef(tree.active);
        treeCursor.current = tree.active;
        React.useEffect(() => {
          if (!pendingTreeFocus.current) return;
          pendingTreeFocus.current = false;
          const root = treeBodyRef.current;
          if (!root) return;
          const el = root.querySelector(".ddb-row.ddb-on");
          if (!el) return;
          try { el.scrollIntoView({ block: "nearest" }); } catch {}
          try { el.focus({ preventScroll: true }); } catch {}
          if (typeof el.getBoundingClientRect === "function") {
            const rect = el.getBoundingClientRect();
            selectedRowRef.current = {
              key: tree.active,
              anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            };
          }
        }, [tree.active]);
        React.useEffect(() => {
          if (!menu) return undefined;
          const close = () => setMenu(null);
          window.addEventListener("click", close);
          return () => window.removeEventListener("click", close);
        }, [menu]);

        React.useEffect(() => {
          if (!tabMenu) return undefined;
          const close = () => setTabMenu(null);
          window.addEventListener("click", close);
          return () => window.removeEventListener("click", close);
        }, [tabMenu]);

        React.useEffect(() => {
          if (!closedMenu) return undefined;
          const close = () => setClosedMenu(null);
          window.addEventListener("click", close);
          return () => window.removeEventListener("click", close);
        }, [closedMenu]);

        React.useEffect(() => {
          const onKey = (e) => {
            // The run chord commits pending table edits from anywhere in the
            // workspace; the SQL editor owns its own use of the same chord
            // (running the statement) and is left alone here.
            if (dbChordHeld("database.runSql", e, ["Enter", "NumpadEnter"])) {
              const node = e.target;
              const tag = node ? String(node.tagName || "").toLowerCase() : "";
              if (tag === "textarea") return;
              const tab = currentEditTab();
              // A console result shares this chord with the SQL editor. CodeMirror
              // is not a textarea, so without this check ⌘Enter in the editor would
              // commit the open SELECT * result instead of running the statement.
              const inEditor = node && node.closest && node.closest(".cm-editor, .ddb-sql-host");
              if (inEditor && tab && tab.consoleId) return;
              if (tab && tab.kind === "table") {
                e.preventDefault();
                submitEdits();
              }
              return;
            }
            // The structure chord describes the selected table, Esc dismisses the
            // popover. Both are handled in the capture phase so the host's own
            // shortcuts cannot claim them first, and both are ignored while
            // typing in a field.
            if (dbChordHeld("database.structure", e)) {
              const active = document.activeElement;
              const tag = active ? String(active.tagName || "").toLowerCase() : "";
              if (tag === "textarea") return;
              if (toggleStructure()) {
                e.preventDefault();
                e.stopPropagation();
              }
              return;
            }
            if (e.key === "Escape" && structBus.getSnapshot()) {
              e.preventDefault();
              e.stopPropagation();
              closeStructure();
            }
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, []);

        const toggle = (node) => {
          const key = nodeKey(node);
          const next = !tree.expanded[key];
          treeBus.set((prev) => ({ ...prev, expanded: { ...prev.expanded, [key]: next }, active: key }));
          if (next) loadKids(node, false);
        };

        // Single click: select the node (and expand/collapse containers, which is the
        // cheap navigation gesture). The selected node is what F1 describes, so the row's
        // rect is handed to the popover for anchoring.
        const selectNode = (node, event) => {
          const key = nodeKey(node);
          let anchor = null;
          if (event && event.currentTarget && event.currentTarget.getBoundingClientRect) {
            const rect = event.currentTarget.getBoundingClientRect();
            anchor = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }
          closeStructure();
          treeBus.set((prev) => ({ ...prev, active: key }));
          selectedRowRef.current = { key, anchor };
          // Leaves are only selected; containers also expand, which stays the cheap
          // one-click navigation gesture.
          if (node.kind !== "table" && node.kind !== "key") toggle(node);
        };

        // Double click: the "open" gesture. A table loads its first page into the bottom
        // dock, a connection opens a SQL console, and a Redis key shows its value.
        const activateNode = (node) => {
          if (node.kind === "table") { openTable(node); return; }
          if (node.kind === "key") { openKey(node); return; }
          if (node.kind === "conn") openConsole(node);
        };

        // F1 toggles the structure popover for the selected table.
        const toggleStructure = () => {
          if (structBus.getSnapshot()) { closeStructure(); return true; }
          const node = structureTargetNode();
          if (!node) return false;
          const picked = selectedRowRef.current;
          loadStructure(picked && picked.key === nodeKey(node) && picked.anchor ? { ...node, __anchor: picked.anchor } : node, false);
          return true;
        };

        const expandable = (node) => node.kind === "conn" || node.kind === "database" || node.kind === "schema" || node.kind === "redis-db";
        const iconOf = (node) => {
          if (node.kind === "conn" || node.kind === "database" || node.kind === "redis-db") return typeGlyph(node.type);
          if (node.kind === "schema") return h(SchemaIcon);
          if (node.kind === "key") return h(KeyIcon);
          return h(TableIcon);
        };
        const matches = (text) => {
          const q = tree.filter.trim().toLowerCase();
          if (q === "") return true;
          return String(text || "").toLowerCase().indexOf(q) >= 0;
        };

        // Visible rows in paint order. The skip rule matches `renderLevel`: a
        // filtered-out row stays if it is expanded, so its matching children
        // remain reachable from the keyboard.
        const flattenVisible = () => {
          const q = String(tree.filter || "").trim().toLowerCase();
          const rows = [];
          const walk = (nodes, parentKey) => {
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              const key = nodeKey(node);
              const open = tree.expanded[key] === true;
              const kids = tree.children[key];
              const label = node.name || node.id;
              const comment = node.kind === "table" ? String(node.comment || "").trim() : "";
              if (!matches(label) && !matches(comment) && !open && q !== "") continue;
              rows.push({ node, key, parentKey, open });
              if (open && kids && kids.kind === "ready") {
                walk((kids.items || []).map((item) => ({ ...item, connId: node.connId || node.id, type: node.type })), key);
              }
            }
          };
          walk(connections.map((conn) => ({ kind: "conn", id: conn.id, connId: conn.id, name: conn.name, type: conn.type })), "");
          return rows;
        };
        const flatRows = flattenVisible();
        const tabKey = flatRows.some((row) => row.key === tree.active) ? tree.active : (flatRows[0] ? flatRows[0].key : "");

        // Move the highlight only. Click still expands containers; an arrow must
        // not, or holding ↓ through a connection would load every database.
        const selectTree = (node) => {
          if (!node) return;
          const key = nodeKey(node);
          if (key === treeCursor.current) return;
          treeCursor.current = key;
          closeStructure();
          pendingTreeFocus.current = true;
          treeBus.set((prev) => ({ ...prev, active: key }));
        };
        const focusedRowKey = () => {
          const el = document.activeElement;
          if (!el || !el.closest || !treeBodyRef.current || !treeBodyRef.current.contains(el)) return "";
          const row = el.closest(".ddb-row");
          return row ? String(row.getAttribute("data-key") || "") : "";
        };
        // Prefer the cursor: a held arrow fires again before focus and `active`
        // have caught up, and reading the focused button would stay on the first row.
        const cursorKey = () => treeCursor.current || focusedRowKey() || tree.active;
        const moveTree = (delta) => {
          const rows = flatRows;
          if (!rows.length) return;
          let i = rows.findIndex((row) => row.key === cursorKey());
          if (i < 0) i = delta > 0 ? -1 : rows.length;
          const next = Math.max(0, Math.min(rows.length - 1, i + delta));
          selectTree(rows[next].node);
        };
        const descend = () => {
          const rows = flatRows;
          const i = rows.findIndex((row) => row.key === cursorKey());
          if (i < 0) { if (rows[0]) selectTree(rows[0].node); return; }
          const cur = rows[i];
          if (expandable(cur.node) && !cur.open) { toggle(cur.node); return; }
          const child = rows[i + 1];
          if (child && child.parentKey === cur.key) selectTree(child.node);
        };
        const ascend = () => {
          const rows = flatRows;
          const i = rows.findIndex((row) => row.key === cursorKey());
          if (i < 0) return;
          const cur = rows[i];
          if (expandable(cur.node) && cur.open) { toggle(cur.node); return; }
          if (!cur.parentKey) return;
          const parent = rows.find((row) => row.key === cur.parentKey);
          if (parent) selectTree(parent.node);
        };
        const openTree = () => {
          const rows = flatRows;
          const cur = rows.find((row) => row.key === cursorKey());
          if (!cur) return;
          if (cur.node.kind === "table" || cur.node.kind === "key" || cur.node.kind === "conn") activateNode(cur.node);
          else if (expandable(cur.node)) toggle(cur.node);
        };
        // The label of the row under the tree cursor, i.e. what ⌘C should copy.
        // Rows are <button>s, so the browser has no DOM selection to copy from
        // them; the chord has to put the text on the clipboard itself.
        const treeCopyText = () => {
          const cur = flatRows.find((row) => row.key === cursorKey());
          if (!cur) return "";
          return String(cur.node.name || cur.node.id || "");
        };
        // Dragging over a row label does create a real selection (e.g. to copy
        // a comment or part of a name); the browser's own copy must win then.
        // Only a selection inside the tree counts: one left behind in the
        // result grid or the editor must not turn ⌘C in the tree into a no-op.
        const treeHasTextSelection = () => {
          const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
          if (!sel || sel.isCollapsed || String(sel).trim() === "") return false;
          const node = sel.anchorNode;
          const body = treeBodyRef.current;
          return !!(body && node && body.contains(node));
        };
        // Capture, not bubble: the default action of an arrow on a focused button
        // inside `.ddb-body` is to scroll that container by a fixed step, which
        // does not match a row and leaves the highlight behind. preventDefault
        // here runs before that default.
        const onTreeKeyDown = (event) => {
          const target = event.target;
          const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
          if (tag === "input" || tag === "textarea" || tag === "select") return;
          if (dialog || menu) return;
          if (!target || !target.closest || !target.closest(".ddb-row, .ddb-body")) return;
          if (event.isComposing) return;
          // ⌘C is left to the copy event. Cancelling the keydown suppresses
          // that event, and the async clipboard API can reject after the
          // default action is already gone, so the row name is never written.
          if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
          const key = event.key;
          if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Enter" && key !== "Home" && key !== "End") return;
          event.preventDefault();
          event.stopPropagation();
          if (key === "ArrowDown") moveTree(1);
          else if (key === "ArrowUp") moveTree(-1);
          else if (key === "Home") { const rows = flatRows; if (rows[0]) selectTree(rows[0].node); }
          else if (key === "End") { const rows = flatRows; if (rows.length) selectTree(rows[rows.length - 1].node); }
          else if (key === "ArrowRight") descend();
          else if (key === "ArrowLeft") ascend();
          else openTree();
        };
        // Rows are buttons, so the browser has nothing selected to copy. ⌘C and
        // Edit → Copy both land here, where the write is still synchronous.
        const onTreeCopy = (event) => {
          const target = event.target;
          const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
          if (tag === "input" || tag === "textarea" || tag === "select") return;
          if (dialog || menu || treeHasTextSelection()) return;
          if (!target || !target.closest || !target.closest(".ddb-row, .ddb-body")) return;
          const text = treeCopyText();
          if (text === "" || !event.clipboardData) return;
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
        };

        const renderLevel = (nodes, depth) => {
          const out = [];
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const key = nodeKey(node);
            const open = tree.expanded[key] === true;
            const kids = tree.children[key];
            const label = node.name || node.id;
            const comment = node.kind === "table" ? String(node.comment || "").trim() : "";
            if (!matches(label) && !matches(comment) && !open && tree.filter.trim() !== "") continue;
            const meta = node.kind === "table" && node.tableType === "view"
              ? "view"
              : node.kind === "redis-db"
                ? String(node.keys || 0)
                : node.kind === "conn" ? node.type : "";
            const isConn = node.kind === "conn";
            const dragging = isConn && reorder !== null && reorder.id === node.id;
            // The insertion line marks the slot the dragged connection would land
            // in. A slot equal to a row's index draws above that row; the last
            // slot (== slotIds.length) draws below the final row instead.
            //
            // The class goes on the ROW, not the wrapper: a wrapper also contains
            // an expanded connection's children, so an "after" line anchored to it
            // would be painted below them instead of under the row.
            const marker = isConn && reorder !== null && reorder.id !== node.id
              ? (reorder.slot === slotIds.indexOf(node.id) ? " ddb-drop-before"
                : (reorder.slot === slotIds.length && slotIds.indexOf(node.id) === slotIds.length - 1 ? " ddb-drop-after" : ""))
              : "";
            out.push(h("div", {
              key,
              className: "ddb-node" + (dragging ? " ddb-dragging" : ""),
            },
              h("button", {
                type: "button",
                className: "ddb-row" + (open ? " ddb-open" : "") + (tree.active === key ? " ddb-on" : "") + (isConn && canReorder ? " ddb-grab" : "") + marker,
                style: { paddingLeft: 8 + depth * 14 },
                tabIndex: key === tabKey ? 0 : -1,
                "data-key": key,
                ref: isConn ? (el) => {
                  if (el) connRowRefs.current.set(node.id, el);
                  else connRowRefs.current.delete(node.id);
                } : undefined,
                // A single click only selects the node (expanding containers as before);
                // opening a table's data — or a connection's console — is a double click,
                // so browsing the tree never fires a query by accident. A click that
                // merely ends a drag is swallowed by `onSwallowClick` before it gets here.
                onClick: (event) => selectNode(node, event),
                onDoubleClick: () => activateNode(node),
                // Dragging a connection row reorders the connection list. The
                // gesture only arms here; see `onConnPointerDown` for why nothing
                // happens until the pointer actually moves.
                onPointerDown: isConn ? (event) => onConnPointerDown(node, event) : undefined,
                onContextMenu: (event) => {
                  event.preventDefault();
                  treeBus.set((prev) => ({ ...prev, active: key }));
                  setMenu({ x: event.clientX, y: event.clientY, node });
                },
              },
                h("span", { className: "ddb-chev" }, expandable(node) ? h(Chevron) : null),
                h("span", { className: "ddb-ico" }, iconOf(node)),
                h("span", { className: "ddb-name", title: comment ? label + "  " + comment : label }, label),
                comment ? h("span", { className: "ddb-cmt", title: comment }, comment) : null,
                meta ? h("span", { className: "ddb-meta" }, meta) : null,
              ),
              open && kids && kids.kind === "loading" ? h("p", { className: "ddb-note" }, t("loading")) : null,
              open && kids && kids.kind === "failed" ? h("p", { className: "ddb-note" }, kids.error || t("error")) : null,
              open && kids && kids.kind === "ready"
                ? renderLevel(kids.items.map((item) => ({ ...item, connId: node.connId || node.id, type: node.type })), depth + 1)
                : null,
            ));
          }
          return out;
        };

        const treeNodes = connections.map((conn) => ({ kind: "conn", id: conn.id, connId: conn.id, name: conn.name, type: conn.type }));
        // Drag-to-reorder for the connection rows. The tree is rebuilt from
        // `connections` on every render and rows below a connection belong to it,
        // so the gesture is tracked by connection id and only ever moves whole
        // connections — dropping a table onto another connection is not a
        // reorder, it is ignored.
        //
        // Implemented with pointer events rather than HTML5 drag-and-drop: the
        // rows are <button>s in a scroll container, and DnD's default image and
        // drop-target negotiation fight the existing click-to-select /
        // double-click-to-open gestures for no gain here.
        const reorderRef = React.useRef(null);
        const [reorder, setReorder] = React.useState(null);
        const connRowRefs = React.useRef(new Map());
        // Cancellers for a connection drag still in flight, released on unmount.
        const connDragStops = React.useRef(new Set());
        React.useEffect(() => () => {
          for (const stop of connDragStops.current) { try { stop(); } catch {} }
          connDragStops.current.clear();
        }, []);
        const DRAG_THRESHOLD = 4;
        // Reordering a filtered tree would write an order that does not match the
        // rows the user sees, so the gesture is off while a filter is set.
        const canReorder = connections.length > 1 && tree.filter.trim() === "";
        // Ids of every connection but the dragged one, in display order; the
        // dragged row is inserted at `reorder.slot` in exactly this list.
        const slotIds = reorder === null
          ? []
          : connections.map((row) => row.id).filter((id) => id !== reorder.id);
        // The saved order is written back as the full id list so a connection the
        // user never dragged keeps its position instead of sliding to the end on
        // the next load.
        const commitReorder = (others, draggedId, slot) => {
          const next = others.slice();
          next.splice(slot, 0, draggedId);
          writeLS(ORDER_KEY, JSON.stringify(next));
          const byId = new Map(connections.map((row) => [row.id, row]));
          const ordered = next.map((id) => byId.get(id)).filter(Boolean);
          // A connection that appeared between drag start and drop is not in
          // `next`; append it rather than dropping it from the tree.
          connections.forEach((row) => { if (next.indexOf(row.id) < 0) ordered.push(row); });
          connBus.set(ordered);
        };
        // A drag ends with a `click` event, which must not also select/expand the
        // connection. That click can land on a row, on the tree container (the
        // common ancestor of the press and release targets), or nowhere at all —
        // so a per-row flag would be left set and swallow the next real click.
        // One persistent capture listener consults a flag that is armed by a drag
        // and disarmed by the first click or by a short timer (the browser does
        // not always dispatch one), so a stray flag can never outlive its drag.
        // Refs, not locals: the capture listener below is installed once (`[]`),
        // so a plain `let` would leave it reading the first render's binding
        // while every later drag armed a different one — the flag never took,
        // and the click that ends a reorder reached `selectNode` and toggled the
        // connection.
        const swallowClick = React.useRef(false);
        const swallowTimer = React.useRef(0);
        const armClickSwallow = () => {
          swallowClick.current = true;
          if (swallowTimer.current) window.clearTimeout(swallowTimer.current);
          swallowTimer.current = window.setTimeout(() => { swallowClick.current = false; swallowTimer.current = 0; }, 300);
        };
        const onSwallowClick = (event) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          if (swallowTimer.current) { window.clearTimeout(swallowTimer.current); swallowTimer.current = 0; }
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        };
        React.useEffect(() => {
          window.addEventListener("click", onSwallowClick, true);
          return () => {
            window.removeEventListener("click", onSwallowClick, true);
            if (swallowTimer.current) window.clearTimeout(swallowTimer.current);
          };
        }, []);
        // `pointerdown` only arms the gesture. A plain click must still select
        // and expand the row, and a double click must still open its console, so
        // nothing is prevented or captured until the pointer actually travels
        // past the threshold. Listening on the window (rather than the row) means
        // a move that leaves the row before crossing the threshold still
        // activates the drag instead of being lost.
        const onConnPointerDown = (conn, event) => {
          if (event.button !== 0) return;
          if (!canReorder) return;
          const ids = connections.map((row) => row.id);
          const from = ids.indexOf(conn.id);
          if (from < 0) return;
          const drag = {
            id: conn.id,
            ids,
            // Slot 0..others.length is an insertion point in the list WITHOUT the
            // dragged row. Modelling it that way (rather than an index in the
            // full list) is what makes "drop on the top half" and "drop on the
            // bottom half" land on opposite sides of the target row.
            slot: from,
            startY: event.clientY,
            active: false,
          };
          reorderRef.current = drag;
          const onMove = (e) => {
            if (reorderRef.current !== drag) return;
            if (!drag.active) {
              if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
              drag.active = true;
              setReorder({ id: drag.id, slot: drag.slot });
            }
            // Once the drag is live the pointer is no longer "clicking", so the
            // browser's text selection is stopped here.
            e.preventDefault();
            reorderTo(e.clientY);
          };
          // Released by `onUp`/`onCancel`; also on unmount, so a drag in flight
          // when the pane goes away cannot leave three capture listeners on
          // `window` pointing at a dead component.
          const stopPointer = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onCancel, true);
            connDragStops.current.delete(stopPointer);
          };
          const onUp = () => {
            stopPointer();
            // A drag ends with a click event on the row it started from; that
            // click must not also select/expand the connection.
            if (drag.active) armClickSwallow();
            finishConnReorder(true);
          };
          const onCancel = () => {
            stopPointer();
            finishConnReorder(false);
          };
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
          window.addEventListener("pointercancel", onCancel, true);
          connDragStops.current.add(stopPointer);
        };
        // Other connection ids in display order, i.e. the list the dragged row
        // is being inserted into.
        const idsWithout = (ids, draggedId) => ids.filter((id) => id !== draggedId);
        // Hit-test the pointer against the rendered connection rows. Reading the
        // live DOM rather than geometry from the model keeps this correct while
        // the list is scrolled.
        const reorderTo = (clientY) => {
          const drag = reorderRef.current;
          if (!drag) return;
          const others = idsWithout(drag.ids, drag.id);
          // The slot is the first other row whose midpoint the pointer is above;
          // past every midpoint it is the end of the list.
          let slot = others.length;
          for (let i = 0; i < others.length; i++) {
            const el = connRowRefs.current.get(others[i]);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) { slot = i; break; }
          }
          if (slot === drag.slot) return;
          drag.slot = slot;
          setReorder({ id: drag.id, slot });
        };
        const finishConnReorder = (commit) => {
          const drag = reorderRef.current;
          reorderRef.current = null;
          setReorder(null);
          if (!drag || !drag.active) return;
          const others = idsWithout(drag.ids, drag.id);
          const from = drag.ids.indexOf(drag.id);
          // A drop that lands back where the row already was is a no-op, so the
          // stored order is not rewritten (and no pointless re-render happens).
          if (!commit || drag.slot === from) return;
          commitReorder(others, drag.id, drag.slot);
        };
        // Escape abandons an in-flight drag. The window listeners stay installed
        // until the pointer comes up; `finishConnReorder(false)` has already
        // cleared the ref, so that up event is a no-op.
        React.useEffect(() => {
          if (reorder === null) return undefined;
          const onKey = (e) => { if (e.key === "Escape") finishConnReorder(false); };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, [reorder]);

        // Both splitters install their move/up listeners on `window` for the
        // duration of a drag. They used to be torn down only by their own
        // `mouseup`, so a drag still in flight when this subtree unmounted left
        // both listeners attached for the life of the page — and the host does
        // swap the sidebar panel out (which is what `reconcileSidebarChrome`
        // exists to recover from), so the unmount can land mid-drag. The active
        // cancellers are tracked here and released on unmount.
        const dragStops = React.useRef(new Set());
        React.useEffect(() => () => {
          for (const stop of dragStops.current) { try { stop(); } catch {} }
          dragStops.current.clear();
        }, []);

        const startTreeResize = (event) => {
          event.preventDefault();
          const main = mainRef.current;
          if (!main) return;
          const onMove = (e) => {
            const rect = main.getBoundingClientRect();
            const w = Math.min(480, Math.max(180, e.clientX - rect.left));
            treeBus.set((prev) => ({ ...prev, treeW: w }));
          };
          const stop = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            dragStops.current.delete(stop);
          };
          const onUp = () => {
            writeLS(TREE_W_KEY, treeBus.getSnapshot().treeW);
            stop();
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          dragStops.current.add(stop);
        };
        const startDockResize = (event) => {
          event.preventDefault();
          const root = rootRef.current;
          const dock = event.currentTarget.parentNode;
          if (!root || !dock) return;
          const startY = event.clientY;
          const startH = dock.getBoundingClientRect().height;
          const rootH = root.getBoundingClientRect().height;
          dock.dataset.drag = "1";
          const onMove = (e) => {
            const next = startH + (startY - e.clientY);
            const frac = Math.min(0.82, Math.max(0.22, next / Math.max(rootH, 1)));
            treeBus.set((prev) => ({ ...prev, dockH: frac }));
          };
          const stop = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            dragStops.current.delete(stop);
          };
          const onUp = () => {
            dock.dataset.drag = "0";
            writeLS(DOCK_H_KEY, treeBus.getSnapshot().dockH);
            stop();
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          dragStops.current.add(stop);
        };
        const refreshTree = () => {
          loadConnections();
          // Reload every expanded level of every connection, not just the top one:
          // dropping the whole cache would leave a previously opened database or
          // schema node showing nothing until it was collapsed and reopened.
          connections.forEach((conn) => reloadConnTree(conn.id));
        };
        const refreshTreeRef = React.useRef(refreshTree);
        refreshTreeRef.current = refreshTree;
        React.useEffect(() => {
          const onAdd = () => { draftBus.set(blankDraft("postgres")); setDialog("create"); };
          const onRefresh = () => { refreshTreeRef.current(); };
          window.addEventListener("dsh-database-add-conn", onAdd);
          window.addEventListener("dsh-database-refresh-tree", onRefresh);
          return () => {
            window.removeEventListener("dsh-database-add-conn", onAdd);
            window.removeEventListener("dsh-database-refresh-tree", onRefresh);
          };
        }, []);

        // Delete the Redis key the user right-clicked.
        //
        // Prefer `/key/delete`: the name is one JSON field, so a space survives.
        // A host started before that route existed answers `not-found` (the alert
        // the user saw). Fall back to the already-registered console path, which
        // splits on whitespace and therefore cannot carry such a name. After DEL
        // the preview tab is closed and that db's key list is reloaded. The count
        // on the db row is patched in place: reloading the connection would flash
        // every db as "loading".
        function deleteKeyNode(node) {
          if (!window.confirm(t("confirmDeleteKey"))) return;
          const connId = node.connId || node.id;
          const id = nodeKey(node);
          const name = String(node.name || "");
          const viaQuery = () => {
            if (/\s/.test(name)) throw new Error(t("deleteKeyNeedsRestart"));
            return api("/query", { id: connId, database: node.database, sql: "DEL " + name }).then((value) => {
              const cell = value && value.rows && value.rows[0] ? value.rows[0][0] : 0;
              return { deleted: Number(cell) || 0 };
            });
          };
          api("/key/delete", { id: connId, database: node.database, key: name }).catch((error) => {
            if (String(error && error.message) !== "not-found") throw error;
            return viaQuery();
          }).then((value) => {
            closeTab(id);
            const removed = Number(value && value.deleted) || 0;
            treeBus.set((prev) => {
              const next = prev.active === id ? { ...prev, active: "" } : prev;
              if (removed <= 0) return next;
              const connKey = nodeKey({ kind: "conn", id: connId });
              const kids = next.children[connKey];
              if (!kids || kids.kind !== "ready") return next;
              const items = (kids.items || []).map((item) => {
                if (item.kind !== "redis-db" || String(item.index) !== String(node.database)) return item;
                return { ...item, keys: Math.max(0, (Number(item.keys) || 0) - removed) };
              });
              return { ...next, children: { ...next.children, [connKey]: { ...kids, items } } };
            });
            loadKids({ kind: "redis-db", connId, index: Number(node.database), name: "db" + node.database }, true);
          }).catch((error) => {
            window.alert(errText(error));
          });
        }

        // Redis keys are excluded from export/import below: those handlers dump
        // db 0 of the connection, not the row that was clicked. A key still has
        // its own actions. An all-null list must not paint the empty box that
        // used to open on a right-click.
        const menuItems = !menu ? [] : [
          menu.node.kind === "key" ? h("button", { key: "v", type: "button", ...tip(t("viewKey")), onClick: () => { openKey(menu.node); setMenu(null); } }, t("viewKey")) : null,
          menu.node.kind === "key" ? h("button", { key: "ck", type: "button", ...tip(t("copyKey")), onClick: () => {
            try { navigator.clipboard.writeText(String(menu.node.name || "")); } catch {}
            setMenu(null);
          } }, t("copyKey")) : null,
          menu.node.kind === "conn" ? h("button", { key: "q", type: "button", ...tip(t("console")), onClick: () => { openConsole(menu.node); setMenu(null); } }, t("console")) : null,
          menu.node.kind === "table" ? h("button", { key: "s", type: "button", ...tip(t("structure"), dbChordLabel("database.structure")), onClick: () => {
            const node = menu.node;
            setMenu(null);
            loadStructure(node, false);
          } }, t("structure") + (dbChordLabel("database.structure") ? "  " + dbChordLabel("database.structure") : "")) : null,
          menu.node.kind === "conn" ? h("button", { key: "e", type: "button", ...tip(t("edit")), onClick: () => {
            const conn = connections.find((item) => item.id === menu.node.id);
            draftBus.set(draftOf(conn || blankDraft(menu.node.type)));
            setDialog("edit");
            setMenu(null);
          } }, t("edit")) : null,
          menu.node.kind === "key" ? null : h("button", { key: "x", type: "button", ...tip(t("exp")), onClick: () => { exportNode(menu.node); setMenu(null); } }, t("exp")),
          menu.node.kind === "key" || menu.node.kind === "table" ? null : h("button", { key: "i", type: "button", ...tip(t("imp")), onClick: () => { importNode(menu.node); setMenu(null); } }, t("imp")),
          expandable(menu.node) ? h("button", { key: "r", type: "button", ...tip(t("refresh")), onClick: () => {
            loadKids(menu.node, true);
            treeBus.set((prev) => ({ ...prev, expanded: { ...prev.expanded, [nodeKey(menu.node)]: true } }));
            setMenu(null);
          } }, t("refresh")) : null,
          menu.node.kind === "conn" ? h("button", { key: "d", type: "button", ...tip(t("remove")), onClick: () => {
            if (!window.confirm(t("confirmDelete"))) return;
            api("/delete", { id: menu.node.id }).then(() => loadConnections()).catch(() => {});
            setMenu(null);
          } }, t("remove")) : null,
          menu.node.kind === "key" ? h("button", { key: "dk", type: "button", ...tip(t("deleteKey")), onClick: () => {
            const node = menu.node;
            setMenu(null);
            deleteKeyNode(node);
          } }, t("deleteKey")) : null,
        ].filter(Boolean);

        const setTreeVisible = (open) => {
          treeBus.set((prev) => ({ ...prev, treeOpen: open }));
          writeLS(TREE_CLOSED_KEY, open ? "0" : "1");
        };
        const [workFocus, setWorkFocus] = React.useState(() => ideaWorkFocus);
        React.useEffect(() => {
          const sync = (event) => setWorkFocus(event && event.detail === "database" ? "database" : "files");
          window.addEventListener("dsh-idea-work-focus", sync);
          return () => window.removeEventListener("dsh-idea-work-focus", sync);
        }, []);
        const [hosts, setHosts] = React.useState(() => readIdeaHosts());
        React.useEffect(() => {
          const sync = () => setHosts(readIdeaHosts());
          window.addEventListener("dsh-editor-dock", sync);
          window.addEventListener("dsh-idea-left-tool", sync);
          window.addEventListener("dsh-db-dock", sync);
          const timer = window.setInterval(sync, 400);
          sync();
          return () => {
            window.removeEventListener("dsh-editor-dock", sync);
            window.removeEventListener("dsh-idea-left-tool", sync);
            window.removeEventListener("dsh-db-dock", sync);
            window.clearInterval(timer);
          };
        }, []);
        const treeUi = h("div", { className: "ddb-tree-col", onKeyDownCapture: onTreeKeyDown, onCopy: onTreeCopy },
          h("div", { className: "ddb-header" },
            h("button", { type: "button", className: "ddb-tool", ...tip(t("add")), onClick: () => { draftBus.set(blankDraft("postgres")); setDialog("create"); } }, h(PlusIcon)),
            h("button", { type: "button", className: "ddb-tool", ...tip(t("refresh")), onClick: refreshTree }, h(RefreshIcon)),
          ),
          h("div", { className: "ddb-filter" },
            h("div", { className: "ddb-filter-box" },
              h("input", { value: tree.filter, placeholder: t("filter"), onChange: (e) => treeBus.set((prev) => ({ ...prev, filter: e.target.value })) }),
              tree.filter !== "" ? h("button", {
                type: "button",
                className: "ddb-filter-clear",
                ...tip(t("clear")),
                onClick: () => treeBus.set((prev) => ({ ...prev, filter: "" })),
              }, "×") : null,
            ),
          ),
          h("div", { className: "ddb-body", ref: treeBodyRef },
            connections.length === 0
              ? h("div", { className: "ddb-empty" }, h("p", null, t("empty")), h("div", { className: "ddb-hint" }, t("emptyHint")))
              : renderLevel(treeNodes, 0),
          ),
        );
        const workEditor = editorApi();
        const workId = workEditor && typeof workEditor.activeDatabaseTab === "function" ? (workEditor.activeDatabaseTab() || "") : "";
        const tabsUi = h("div", { className: "ddb-worktabs" },
          view.consoles.map((item) => {
            const editing = renaming && renaming.id === item.id;
            const on = workFocus === "database" && (workId === item.id || (!workId && view.page === item.id));
            if (editing) {
              return h("span", { key: item.id, className: "ddb-worktab ddb-worktab-edit" + (on ? " ddb-on" : "") },
                h("input", {
                  className: "ddb-worktab-input",
                  value: renaming.value,
                  autoFocus: true,
                  spellCheck: false,
                  onClick: (e) => e.stopPropagation(),
                  onChange: (e) => setRenaming({ id: item.id, value: e.target.value }),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      renameConsole(item.id, e.currentTarget.value);
                      setRenaming(null);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setRenaming(null);
                    }
                  },
                  onBlur: (e) => {
                    renameConsole(item.id, e.currentTarget.value);
                    setRenaming(null);
                  },
                }),
              );
            }
            return h("button", {
              key: item.id,
              type: "button",
              className: "ddb-worktab" + (on ? " ddb-on" : ""),
              title: item.title,
              onClick: () => focusConsole(item.id),
              onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
              onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeConsole(item.id); } },
              onContextMenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu(null);
                setTabMenu({ id: item.id, x: e.clientX, y: e.clientY });
              },
            },
              h("span", { className: "ddb-tab-ico", "aria-hidden": true }, h(CylinderIcon, { color: "#3d6fd9", size: 12 })),
              h("span", { className: "ddb-tab-title", title: item.title }, item.title),
              h("span", {
                className: "ddb-tab-x",
                role: "button",
                ...tip(t("closeTab"), closeChord()),
                onClick: (e) => { e.stopPropagation(); closeConsole(item.id); },
              }, "×"),
            );
          }),
          h("button", { type: "button", className: "ddb-tool", ...tip(t("newConsole")), onClick: () => openConsole(connections[0]) }, h(PlusIcon)),
          closed.length ? h("button", {
            type: "button",
            className: "ddb-tool ddb-closed-btn",
            ...tip(t("closedConsoles")),
            onClick: (e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu(null);
              setTabMenu(null);
              setClosedMenu((prev) => (prev ? null : { x: rect.left, y: rect.bottom + 4 }));
            },
          }, h(HistoryIcon), h("span", { className: "ddb-history-count" }, String(closed.length))) : null,
        );
        const activeConsole = view.consoles.some((item) => item.id === workId) ? workId : (view.page !== "explorer" && view.consoles.some((item) => item.id === view.page) && workId === "" ? view.page : "");
        const workUi = activeConsole
          ? h(SqlPage, {
              id: activeConsole,
              onHistory: (pos) => {
                setMenu(null);
                setTabMenu(null);
                setClosedMenu((prev) => (prev && pos && prev.x === pos.x ? null : pos));
              },
            })
          : null;
        const dockUi = h("div", { className: "ddb-dock" }, h(BottomPanel));
        const overlayUi = h(React.Fragment, null,
          dialog ? h(Dialog, { draftBus, onClose: () => setDialog(null) }) : null,
          confirm ? h("div", { className: "ddb-overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) confirmBus.set(null); } },
            h("div", { className: "ddb-card", style: { width: "min(640px, 100%)" }, role: "dialog" },
              h("h2", null, t("confirmSql")),
              h("div", { className: "ddb-status" }, t("confirmSqlHint")),
              h("pre", { className: "ddb-pre" }, confirm.sql),
              h("div", { className: "ddb-actions" },
                h("button", { type: "button", className: "ddb-btn ddb-btn-ghost", ...tip(t("cancel")), onClick: () => confirmBus.set(null) }, t("cancel")),
                h("button", { type: "button", className: "ddb-btn ddb-btn-primary", ...tip(t("confirmSql")), onClick: () => runConfirmed(confirm) }, t("confirmSql")),
              ),
            ),
          ) : null,
          menuItems.length ? h("div", {
            className: "ddb-menu",
            style: { left: menu.x, top: menu.y },
            onClick: (event) => event.stopPropagation(),
          }, menuItems) : null,
          tabMenu ? h("div", {
            className: "ddb-menu",
            style: { left: tabMenu.x, top: tabMenu.y },
            onClick: (event) => event.stopPropagation(),
          },
            [
              h("button", { key: "r", type: "button", ...tip(t("rename")), onClick: () => {
                const target = view.consoles.find((row) => row.id === tabMenu.id);
                focusConsole(tabMenu.id);
                setRenaming({ id: tabMenu.id, value: target ? target.title : "" });
                setTabMenu(null);
              } }, t("rename")),
              h("button", { key: "c", type: "button", ...tip(t("closeTab"), closeChord()), onClick: () => { closeConsole(tabMenu.id); setTabMenu(null); } }, t("closeTab")),
              h("button", { key: "d", type: "button", ...tip(t("deleteConsole")), onClick: () => {
                if (!window.confirm(t("confirmDeleteConsole"))) return;
                deleteConsole(tabMenu.id);
                setTabMenu(null);
              } }, t("deleteConsole")),
            ],
          ) : null,
          closedMenu ? h("div", {
            className: "ddb-menu ddb-history-menu",
            style: { left: Math.max(8, closedMenu.x), top: closedMenu.y },
            onClick: (event) => event.stopPropagation(),
          },
            h("div", { className: "ddb-history-head" }, t("closedConsoles")),
            closed.length
              ? closed.map((row, i) => {
                const title = row.title || t("console");
                const at = row.at ? new Date(row.at) : null;
                const when = at && !Number.isNaN(at.getTime())
                  ? (at.getMonth() + 1) + "/" + at.getDate() + " " + String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0")
                  : "";
                const meta = [row.database, when].filter(Boolean).join(" · ");
                return h("button", {
                  key: row.id + ":" + i,
                  type: "button",
                  className: "ddb-history-item",
                  title: meta ? title + " · " + meta : title,
                  onClick: () => { reopenConsole(row); setClosedMenu(null); },
                },
                  h("span", { className: "ddb-history-title" }, title),
                  meta ? h("span", { className: "ddb-history-meta" }, meta) : null,
                );
              })
              : h("div", { className: "ddb-history-empty" }, t("closedEmpty")),
            closed.length ? h("button", {
              type: "button",
              className: "ddb-history-clear",
              ...tip(t("closedClear")),
              onClick: () => { closedBus.set([]); setClosedMenu(null); },
            }, t("closedClear")) : null,
          ) : null,
          structure ? h(StructurePopover, { info: structure, onClose: closeStructure }) : null,
        );

        return h(React.Fragment, null,
          hosts.tree ? portalTo(treeUi, hosts.tree) : null,
          hosts.tabs ? portalTo(tabsUi, hosts.tabs) : null,
          hosts.work && workUi ? portalTo(workUi, hosts.work) : null,
          hosts.dock ? portalTo(dockUi, hosts.dock) : null,
          portalTo(overlayUi, document.body),
        );
      }

      if (typeof createRoot === "function") {
        try {
          const shellHost = document.createElement("div");
          shellHost.className = "ddb-idea-shell";
          shellHost.setAttribute("hidden", "hidden");
          document.body.appendChild(shellHost);
          const shellRoot = createRoot(shellHost);
          shellRoot.render(h(ExplorerBody));
          publishWorkTabs();
          ctx.effect(() => () => {
            try { shellRoot.unmount(); } catch {}
            try { shellHost.remove(); } catch {}
          });
        } catch (error) {
          // A workspace that cannot mount must still leave the rest of the
          // plugin working (run-file, dialogs, routes), and say so.
          console.error("dsh-idea: database workspace mount failed", error);
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "dsh-idea-database-client";
    return module.exports;
  },
});
