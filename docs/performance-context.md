# dsh-idea 性能排查上下文

- 日期：2026-11-17（Asia/Shanghai）
- 对象：`dsh-idea` 1.6.1 工作区（仓库 HEAD 仍是旧提交，见「仓库状态」）
- 目的：后续会话先读本文件，避免重复排查；只有拿到新证据再改代码。

## TL;DR

1. 插件里最可疑的全局负载是 **默认开启的「整段会话历史自动加载」**，以及 **Run / Git 面板关闭或隐藏后仍在跑的轮询**。这些已全部改掉（见第 2 节）。
2. 服务端已确认在发新代码（构建标记、chunk 内容、重启时间都核对过，见第 3 节）。
3. 右栏收起、编辑器未挂载时切会话仍慢。原因不是编辑器或 Git，而是样式表里没有祖先的 `::highlight()`：Chromium 会给整页每个元素算高亮样式。同页对照：这 18 条规则在时，7 次切换约 11–13 个 ≥50ms 长任务（合计约 800ms）；删掉或改成 `.dce-paint::highlight()` 后长任务为 0，规则加回去又出现。已收进 `.dce-paint`（见 2.8）。构建标记改为 `2026-11-17.perf4`。
4. 切会话的 `Session reference ... is released` 报错是 **DSH 宿主右栏插件的竞态**，不在本仓库，基本无害（见第 5 节）。
5. 2026-11-18 按用户可感路径复测（见第 9 节）。**没有新的、可落地的热点**，未改代码，构建标记仍为 `2026-11-17.perf4`。
6. 2026-11-18 补测大文件打开 / 滚动 / 查找 / 打字（见第 10 节）。50k 对照在 `perf4` 下长任务为 0；180k / 250k 打开时稳态约 0–1 个 ≥50ms 长任务（约 52–75ms），主要是大块 `<pre>` + textarea 布局。滚动、查找、打字的稳态长任务为 0。没有可落地的插件脚本热点，**未改代码**。测量中途工作区里的 `lib/client.js` 被其他改动换成 `2026-11-18.ux1`（不是本次审查改的）。

## 1. 用户症状

- 「一打开/启用 dsh-idea，整个 DSH 就没那么流畅」，不只是右栏。
- 第一次切换历史会话时 Console 报 `Sidebar Session opening failed: Error: Session reference "..." is released`。
- 右栏面板打开时体感更明显；具体是聊天流式输出、滚动、输入还是编辑器，尚未细分。

## 2. 已实施的优化

### 2.1 全量历史泵改为默认关闭

- 位置：`lib/client.nav.js`，`installHistoryPump`（约 726–830 行）。
- 原行为：插件 apply 时无条件安装；订阅当前会话，反复 `loadOlder()` 直到 `hasMore: false`，等于把 DSH 刻意分页的聊天记录整段拉回。DSH 的分页是每页最多 500 条消息（`dsh-api-session-controller/lib/types/client/sessions/session.js` 里 `HISTORY_PAGE_OPTIONS`）。
- 代价：长会话每次打开/切换都要多发多次 `/events` 请求，服务端要解压、序列化整页消息（占用同一个事件循环），客户端 transcript 全量保留。
- 现在：默认 **off**；只有 `localStorage["dsh.files.historyPump"]` 为 `"on" / "1" / "true"` 才安装。
- 回退：`localStorage.setItem("dsh.files.historyPump", "on")` 后刷新。
- 诊断标记：`window.__dshIdeaHistoryPump` 为 `"on" | "off"`。

参考数据：出问题的那个工作区有约 143 个 session 目录，最大的约 3928 个事件 / 3.5MB（zstd 压缩后）。全量加载不是小数目。

### 2.2 Run 面板轮询

- 位置：`lib/client.run.js`。
- 原行为：
  - `RunDock` 挂载后每 **700ms** 一轮，`LIST_EVERY = 5`（约每 3.5s 一次 `/list`，会触发 run 配置自动发现，发现缓存 10s）；
  - 关闭面板只改 `data-dsh-run-dock` + localStorage，**不卸载**，组件和 700ms 轮询一直活到刷新页面；
  - 每次渲染对最多 200KB 日志重新 `stripAnsi`，无关状态变化也会重算。
- 现在：
  - `closeDock()` 会 `teardown()`（真正 unmount），并停掉 ensure 重试；
  - 轮询前检查 `isOpen()`、`document.hidden`、`mount.host.isConnected`（约 539 行），面板关闭或编辑器已卸载就完全不打请求；
  - `output` / `stripAnsi` 用 `useMemo`（约 587–590 行），按 `log.text` / `log.err` 缓存。
- 代价：重新打开 Run 面板会重新拉一次列表和日志（关闭后状态本来也不可见）。

### 2.3 Git 轮询与 `uiBus.visible`

- 位置：`lib/client.git.js`，`syncVisible`、`followTimer`、`boot`（约 4352–4385 行）。
- 原行为：两个 15s tick 用缓存 `uiBus.visible` 判断；关闭编辑器 tab 或收起右栏不会通知本插件，`visible` 会一直保持 `true`，于是继续 `/state`（内部 4 个 git 子进程）。反过来，页面恢复时 `visible` 也可能是 false，导致恢复后不加载。
- 现在：tick 每次用 `gitVisible()` 从 DOM 重读，并顺带把 `uiBus.visible` 纠正到真实值；不可见时直接 return。
- 影响：多仓库大仓库上每 15s 的 `git status -u` 不会再在面板关闭后继续跑。

### 2.4 LSP 空闲回收 + 受控 warmup

- 服务端：`lib/lsp/index.js`
  - 新增 `IDLE_MS = 5 分钟`、`SWEEP_MS = 30s`。
  - `armReaper()` 只装一个 `unref()` 的 interval；`reap()` 只停超过 5 分钟没有 `clientFor` 请求的 client，并从 `clients/lastUsed` 删除。
  - `clientFor` 命中/新建都会 `touch(key)`；`exit`、`stop()` 清理 `lastUsed` 和 interval。
  - 背景：jdtls / clangd / gopls / rust-analyzer 以前从第一次跳转活到页面卸载，大工程会持续吃 CPU/内存。
- 客户端：`lib/client.js` 的 warmup effect（约 2786–2805 行）
  - 延迟 `WARM_DELAY_MS = 1200ms`，切 tab 会取消（避免只是扫一眼就拉起服务器）。
  - `WARM_SKIP_LANGS = { java, c, cpp, rs, go }` 不自动 warmup（这些 server 启动即导入整个工程模型）；第一次「跳转定义/引用」仍会按需启动。
  - 文档大于 `WARM_MAX_TEXT = 256KB` 不自动 warmup。
  - 代价：上述语言第一次跳转要付冷启动；这是用性能换的。

### 2.5 编辑器绘制上限（没有做真正的视口虚拟化）

- 位置：`lib/client.js` 的 `paint` memo（约 2408 行）/ 语法高亮 effect（约 2701 行）。
- 事实：Chromium 下编辑器走的是 **一个 text node + CSS Custom Highlight API**（`HIGHLIGHT_API` 分支），不是每 token 一个 span 的 `innerHTML`；所以「整块 innerHTML」不是当前浏览器的瓶颈。
- 现在设置了两条上限：
  - `PAINT_TEXT_MAX = 200000`：超过 200KB 的文档不做 tokenize（直接单 text node；原阈值是 400KB）。
  - `SYNTAX_RANGE_MAX = 8000`：每次按键要重建的 `Range` 对象超过 8000 个就放弃彩色，只显示纯文本。
- 未做：按行/视口的完整虚拟化。`<pre>` + 透明 textarea 的几何是这套编辑器的基础，硬套虚拟化风险大；如果后续要动，先有 profile 证明高亮 Range 或 textarea 是瓶颈再说。
- 非 Highlight API 的兜底路径仍然是整块 `innerHTML`，大文件上没优化（当前目标浏览器基本不走到）。

### 2.6 切会话时不再顺手做 Git / 目录列表

用户补充：插件打开时快速切会话仍有轻微延迟。对得上的路径：

- 右栏按会话挂载编辑器。`ensureDock()` 以前只要编辑器页在，就把整棵 Git `Dock`（提交表）`createRoot` 进 `.dce-gitpane`，CSS 再用 `display:none` 藏起来。关着 Git 也会在每次切到「有编辑器标签」的会话时付这笔 DOM。
- `onSelectionMaybeChanged` 每次会话变化都同步调用 `syncSession()` → `load()`（发现仓库 + `/state` + `/log`）。Git 停在打开、或 `uiBus.visible` 还没被 15s tick 纠正时，连切会把这些请求堆到正在打开会话的同一个事件循环上。
- `gitVisible()` 只看「dock 打开 + 当前标签是编辑器」。收起右栏时编辑器标签仍算 active，所以 tick 会把 `visible` 纠正回 true，收起之后继续刷。
- 编辑器订阅的是主舞台会话，不是这个标签自己的会话。切走的那一页会在卸载前把 cwd 改成新会话的，并再列一次目录。

现在：

- `ensureDock()` 在 dock 关闭时直接返回，并卸掉已经挂上的树。提交框的状态在 `commitBus` 上，卸树不丢草稿。
- 选择变化后 **200ms** 才 `syncSession()`；dock 没开就连定时器都不排。200ms 内又切走则取消，只刷新最后停住的会话。
- `gitVisible()` 额外要求右栏 `isExpanded()`。收起后 tick 和选择回调都不打 git。
- 编辑器只用自己的 `sessionId` 读 cwd。目录列表等标签真正可见再延后 160ms；切走时清掉定时器，返回后如果页面已卸载就不再 `setState`。
- 诊断标记：`window.__dshIdeaBuild` 为 `"2026-11-17.perf2"`。

### 2.7 右栏收起时不再绘制编辑器 / diff

用户确认：硬刷新后标记已是 `perf2`，切会话没有 `git/state` 或 `git/log`，右侧面板都没打开，延迟仍在。

宿主右栏在收起时并不卸载当前标签。面板只是被平移到画面外，标签 body 继续挂着（`dsh-client-ui-sidebar-right`：`visible` 在 `layout.expanded === false` 时为 false，但 dock 里的 body 仍提交）。会话如果曾经打开过编辑器或 diff，每次切过去都会：

- 卸掉上一页的整棵编辑器 DOM，再挂上一页的；
- 编辑器的 layout effect 读取 `scrollHeight`，把刚换上的对话一起排进去。

这和「面板看起来是关的」不矛盾，也解释了为什么没有 Git 请求。

现在：

- `EditorApp` 用 `tab.visible` 判断。这次挂载还没出现在屏幕上时，只留一个 `data-dce-idle` 的空壳，不建文件树、文本框和 `.dce-gitpane`。
- 一旦这次挂载出现过，就保持整棵树。收起动画需要原来的节点跟着滑出去；若在收起的瞬间拆掉，滑出的是空面板。
- `dsh-editor-dock` 跟着这次「真正绘制」走，而不是只在 mount 时发一次。否则 Git / Run 会在面板还不存在时找它，展开之后不再找。
- diff 标签同样：不可见时不请求 diff、不建 `DiffView`；出现过之后保留，避免收起时被掏空。
- 诊断标记：`window.__dshIdeaBuild` 为 `"2026-11-17.perf3"`。

代价：右栏收起时切到一个从未在本页展开过的会话，编辑器是空的，展开那一下才建树。本来就不可见，没有可看的内容被丢掉。文件标签仍是组件状态，切走本来就会卸掉。

### 2.8 高亮伪类不再作用到整页

用户确认 `perf3` 之后切会话仍然慢，并且右栏面板都没打开。关掉整个 `dsh-idea` 就正常。后续测量（新 headless 配置，不碰用户的浏览器配置）对得上：

- 右栏收起时切会话，页面上没有 `.dce-root`，也没有本插件的网络请求。插件自己的脚本采样只有几毫秒。
- 长任务来自宿主给对话做布局（`scrollMetrics` 读 `scrollHeight`）。插件能把这件事变贵的，是启动时就插进 `document.head` 的样式。
- 同一次页面里来回改 `style[data-plugin="dsh-idea"]`：18 条未限定祖先的 `::highlight()` 在时，7 次切换有 11–13 个 ≥50ms 长任务（合计约 790–810ms，单次最高约 108ms）。只删这 18 条，长任务变 0。原样加回去，长任务回到 13 个 / 约 810ms。改成 `.dce-paint::highlight()`（规则仍在），长任务又是 0。

高亮范围只画在 `<pre class="dce-paint">` 的文本节点上（语法、查找、符号出现次数都是），所以选择器可以挂在这个类上，颜色不变。不要再把 `::highlight()` 写成没有类的全局规则。

- 诊断标记：`window.__dshIdeaBuild` 为 `"2026-11-17.perf4"`。

## 3. 诊断标记与验证方法

### 3.1 页面侧标记

硬刷新（Cmd+Shift+R）后，DevTools Console 运行：

```js
window.__dshIdeaBuild         // 期望 "2026-11-17.perf4"
window.__dshIdeaHistoryPump   // 期望 "off"
```

- 两个都有且值对：页面已加载新 client / nav chunk。
- `undefined` 或泵为 `"on"`：页面还是旧的，硬刷新；仍不变就看 Console 报错。

### 3.2 网络侧

- 关闭 Run 面板后，Network 过滤 `plugins/dsh-idea/run/tail` 应该**没有任何新请求**；`/list` 也不再周期性出现。
- 关掉编辑器 tab / 收起右栏后，`plugins/dsh-idea/git/state` 不应再每 15s 出现。
- 打开长会话时，`/events`（或 session 事件）不应再自动连续翻页直到最老；只应有首屏那一页。

### 3.3 主机侧

```sh
ps aux | grep -E "jdtls|clangd|typescript-language-server|pyright|gopls|rust-analyzer"
ps ax -o pid,lstart,etime,%cpu,rss,command | grep "dsh web"
```

2026-11-17 16:45 左右实测：`dsh web` 新进程（16:42:59 启动）空闲约 0.7% CPU / 353MB RSS；**没有**任何 LSP 常驻进程。也就是说当时主机侧没有后台燃烧，卡顿（如果仍存在）更可能在浏览器端。

### 3.4 命令验证

```sh
cd dsh-idea
node --check lib/client.js
node --check lib/client.nav.js
node --check lib/client.git.js
node --check lib/client.run.js
node --check lib/lsp/index.js
npm test          # 46 tests, 含新增 test/lsp.test.js
```

### 3.5 服务端是否真的在发新代码（不重启服务器的核对办法）

DSH 的插件 JS 不走 `/plugins/dsh-idea/client.js`（直接访问 404），而是组合 URL：

1. 从 `~/.dsh/dsh-web.log` 取最近一次启动打印的 `token`；
2. `curl -L -c/-b <cookie jar> "http://127.0.0.1:3080/?token=$TOKEN"` 换到 cookie，再取 `GET /`；
3. 在 HTML 里找 `plugins/??dsh-idea/client.js&rev=<rev>` 的单资源 URL（或包含 dsh-idea 的大 combo URL），`curl -b` 取回来；
4. grep `__dshIdeaBuild`、`__dshIdeaHistoryPump`、`syncVisible`、`mount.host.isConnected`。

2026-11-17 核对结果：单资源 bundle 里 `__dshIdeaBuild = "2026-11-17.perf1"`，nav chunk 有新的 flag 逻辑和 `__dshIdeaHistoryPump`，git chunk 有 `syncVisible`，run chunk 有 `mount.host.isConnected` 保护。

## 4. 已验证 / 未验证

已验证：

- 上面 5 个文件的语法检查通过；`npm test` 46/46。
- 运行中的服务确实在发新 client / nav / git / run 代码（见 3.5）。
- 服务端在 16:42:59 重启过（新 PID），所以 `lib/lsp/index.js` 的空闲回收已随新进程加载。
- 主机空闲、无 LSP 常驻。
- 切会话报错来自宿主 `dsh-client-ui-sidebar-right`，不在本插件栈里（见第 5 节）。

未验证 / 待用户反馈：

- 用户页面是否真的加载了 `2026-11-17.perf1`（标记检查还没回报）。
- 用户说「还是没有什么变化」时，是否已经硬刷新过、是否开着长文件/Run/Git、卡顿具体发生在哪个动作。
- 优化前后的实际体感/长任务数据（没有浏览器 Performance profile）。
- LSP 空闲回收在真实 jdtls 上的效果（当天没有 LSP 进程）。

## 5. 宿主侧行为（重要，避免误判）

### 5.1 client bundle 的加载与「为什么改了没变化」

- `@deepseek-ai/dsh-client-modules`：client bundle 按 **rev（文件 mtime/ctime/size 的哈希）** 组合，bundle URL 带 `rev`，响应是 `immutable` 长缓存；组合后的 bundle 会**缓存在宿主内存里**，文件变了要靠 HMR 或重启才会重新组合。
- `@deepseek-ai/dsh-client-hmr`：每 **500ms** stat-poll 每个插件的 `client.js`；变化时 `clientModules.rebuilt(id)` 并通过 `/plugins/events` SSE 广播 `rebuilt`。
- HMR 重新加载入口模块时会清掉该 owner 的 chunk 缓存（`loadCache` 里 `owner/client.*`），所以正常情况下 `client.nav.js` / `client.git.js` / `client.run.js` 也会被重新拉取。
- 但：页面如果没连着 SSE、或者服务端刚重启、或者加载顺序刚好卡在两次写文件之间，chunk 可能仍是旧的。**服务端重启后最稳的是硬刷新页面**，不要指望 HMR 一定到位。
- `index.html` 没有 `cache-control` 头，普通刷新可能复用旧 HTML（连带旧 rev）；硬刷新最保险。
- 改动 `lib/client*.js` 只需刷新页面；改动 `lib/index.js`、`lib/lsp/*`、`lib/nav/*`、`lib/git/*`、`lib/run/*` 等服务端代码需要重启 `dsh web`。**重启会中断当前 web 会话**（本会话就跑在这个进程里），必须先征得用户同意。

### 5.2 `Session reference "..." is released` 报错

现象：

```
Sidebar Session opening failed: Error: Session reference "session-..." is released
    at ClientSessionReference.release (client.js:3792)
    at SidebarSessionView.dispose (client.js:2035)
```

来源（全部是宿主全局安装包，不是本仓库）：

- 打印：`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:1984`（`SidebarSessionView` 构造时的 `reference.ready.catch`）。
- 释放：同文件 `dispose()`（约 2029–2036 行）。
- 拒绝原因：`@deepseek-ai/dsh-api-session-controller/lib/client.js:3792`。
- 触发链：`@deepseek-ai/dsh-client-ui-session/lib/client.js` 的 `publishMain()`（约 929 行）在切换会话的瞬间，可能短暂发布「没有 mainView 保留的会话」；右栏 `views.select(undefined)` 随后把所有没有 retained tabs 的 view `prune → retire → release`，如果该 view 的 `ready` 还没 settle，就以 “is released” 拒绝。

影响：

- 已被 `.catch` 吞掉，不会抛穿 React，不会崩溃/白屏。
- 被释放的是正在打开又被丢弃的右栏 view；下一次 `select` 会重新 retain/打开。最坏是右栏闪一下或短暂空白，切走再切回/刷新即可。
- 不涉及主对话事件流，不丢会话数据、草稿或编辑内容。
- 与卡顿无直接关系，也不涉及本插件的 `sessions.retain/release`（本插件只用 `sessions.binding` / `sessions.list`）。

何时需要在意：每次切会话都报、或右栏持续空白/tab 打不开。那属于宿主 bug；不要改全局 `node_modules`（升级会覆盖），应报给 DSH 或等版本修复。

## 6. 仍待办 / 开放假设

下一步优先级：

1. **确认页面 bundle**：硬刷新（Cmd+Shift+R，不用重启 `dsh web`）后 `__dshIdeaBuild` 应为 `"2026-11-17.perf4"`，`__dshIdeaHistoryPump` 为 `"off"`。`style[data-plugin="dsh-idea"]` 里的高亮规则应是 `.dce-paint::highlight(...)`，不应再有没有类名的 `::highlight(...)`。
2. 若确认是新代码，收集：
   - 卡顿发生的具体动作（聊天流式输出/滚动、聊天输入、编辑器打字、右栏滚动、打开/切会话、菜单动画）；
   - 右栏收起时是否还卡；
   - 10 秒 long-task 记录：

     ```js
     (() => {
       const rows = [];
       new PerformanceObserver((list) => {
         for (const e of list.getEntries()) rows.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
       }).observe({ type: "longtask", buffered: true });
       window.__dshLongTasks = rows;
     })();
     // 复现后
     console.table(window.__dshLongTasks);
     console.log("nodes", document.getElementsByTagName("*").length,
                 "heapMB", performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : "n/a");
     ```
3. 若 profile 指向编辑器：优先看打开的文件大小、textarea 全量文本的布局/滚动、highlight Range 数量；不要先上虚拟化。
4. 若 profile 指向聊天：考虑长 transcript 的 DOM/折叠策略、右栏全屏覆盖时聊天仍持续渲染、长时间运行后的内存增长（先对比刷新前后）。

已排查、基本可排除（当前证据）：

- `dsh-quota` 的 1s 定时器：`document.visibilityState === "hidden"` 时提前 return，且只有标签文本变化才 `setState`。
- `dsh-keyboard-shortcuts` 的全局 keydown：每键 O(命令数)，没有 IO。
- 本插件的 4 个 client chunk 在启动时全部加载（`immediately: true` + `bootChunk`），约 547KB；是启动成本，但不是持续卡顿，**未改**。
- 两处 250ms 的 `registerType` 重试 interval 在注册成功后清除；**未改**。

不要重复做的事：

- 不要再把历史泵改回默认开启。
- 不要再加没有 `visibility` / 关闭 / 挂载判断的轮询。
- 不要再对 jdtls/clangd/gopls/rust-analyzer 做「打开文件就 warmup」。
- 不要为了「感觉」继续加缓存/节流；下一步要的是 profile 或标记值。

## 7. 关键文件、常量、开关

| 项 | 位置 | 值 / 行为 |
| --- | --- | --- |
| 构建标记 | `lib/client.js` | `window.__dshIdeaBuild = "2026-11-17.perf4"` |
| 高亮伪类 | `lib/client.js` `STYLE` | `.dce-paint::highlight(...)`。不要改回没有类的 `::highlight()`，那会让切会话时长任务回到约 70ms |
| 收起不绘制 | `lib/client.js` `EditorApp`、`lib/client.git.js` `GitDiffBody` | 右栏收起且这次挂载还没出现在屏幕上时不建树；出现过则保留，好让收起动画还有内容 |
| 历史泵开关 | `lib/client.nav.js` `installHistoryPump` | 默认 off；`dsh.files.historyPump = on/1/true` 才开 |
| 历史泵状态 | 同上 | `window.__dshIdeaHistoryPump = "on" \| "off"` |
| Run 轮询 | `lib/client.run.js` | `POLL_MS = 700`、`LIST_EVERY = 5`；关闭时 teardown；轮询前查 open/hidden/connected |
| Git 轮询 | `lib/client.git.js` | 两个 15s tick；`gitVisible()` = dock 打开且编辑器在前且右栏展开。切会话的刷新延迟 200ms，dock 关闭不打请求。`ensureDock` 在 dock 关闭时不挂树 |
| LSP 回收 | `lib/lsp/index.js` | `IDLE_MS = 5min`、`SWEEP_MS = 30s` |
| warmup 跳过 | `lib/client.js` | `WARM_SKIP_LANGS`（java/c/cpp/rs/go）、`WARM_MAX_TEXT=256KB`、`WARM_DELAY_MS=1200` |
| 语法上限 | `lib/client.js` | `SYNTAX_RANGE_MAX=8000`、`PAINT_TEXT_MAX=200000` |
| LSP 回收测试 | `test/lsp.test.js` | 新增，覆盖 reap / stop |

## 8. 仓库状态（后续会话注意）

- `git log` 的 HEAD 还是 1.5.2 时期的提交；工作区里叠加了大量 **原本就未提交** 的 1.6.1 改动（Run 面板、Git pull/commit 改动、README、package.json、`lib/run/`、`lib/client.run.js`、`test/` 等，其中一些是 untracked）。
- 因此 `git diff` / `git status` **不能**用来判断「本次性能优化改了什么」；以本文件第 2、7 节为准。
- 本次优化没有 commit，也不应擅自 commit/push。
- 正在运行的 `dsh web` 就是承载当前会话的进程；重启会断开会话，必须先问用户。


## 9. 2026-11-18 复测（perf5 审查，未改代码）

- 日期：2026-11-18（Asia/Shanghai）
- 方法：全新 `--user-data-dir` 的 headless Edge + CDP，连接已在跑的 `http://127.0.0.1:3080`。只切换已有会话，不新建会话、不发消息，结束后杀掉本次 Edge 进程。长任务：`PerformanceObserver` type `longtask`，阈值 50ms；先 warmup 一轮，结论用之后的稳态轮。因果对照在同一页做「有 → 去掉 → 加回」。CPU profile：`Profiler` interval 100µs，只报 SELF，组合 URL（`/plugins/??...&rev=...`）不把宿主函数算进本插件。
- `dsh web` **未重启**。页面上的标记是 `window.__dshIdeaBuild === "2026-11-17.perf4"`，`window.__dshIdeaHistoryPump === "off"`。
- 有效视口是 **1440×900**。第一次未设视口时节点只有约 1609、对话几乎没铺开，7 次切会话稳态长任务为 0，这组数不能代表「对话可见」；下面的切会话数字都以 1440×900、切到带长 transcript 的会话为准（切过后约 5315 个节点，对话滚动容器约 6512×824）。

### 9.1 右栏全关、快速切会话（7 次 `.YDXeBa_sessionRow`）

稳态（warmup 之后）：

| 轮次 | 长任务个数 | 合计 | 最大 |
| --- | --- | --- | --- |
| 第一次测量 warmup（冷） | 7 | 391ms | 72ms |
| 第一次测量稳态 | 3 | 176ms | 66ms |
| 第二次测量 warmup | 4 | 236ms | 69ms |
| 三次「四份样式都在」的 with1 平均 | 3 | 150ms | 62ms |

也就是说，在**对话可见、transcript 较长**时，perf4 之后稳态并不是 0，而是大约 2–3 个略高于 50ms 的长任务（单个约 50–66ms）。这与 perf4 当时「较轻页面上改完选择器后为 0」不矛盾：那次对照的是裸 `::highlight()` 的 11–13 个 / ~800ms；本次没有再引入那种全页税。

CPU profile（7 次切会话，interval 100µs）：

- 宿主 `scrollMetrics` SELF 36.4ms，`updateLimit` 19.9ms（两者都在组合 bundle 里，函数名属于 `dsh-client-ui-sidebar-documentpreview` 等宿主包）。
- 只属于本插件独立 chunk 的 SELF 合计 **0.4ms**：`workspaceLabelOf` 0.1、`WorkspaceBadge` 0.1、`RunChip` 0.1、`client.git.js` 里的 `sessionsService` 0.1。
- 捕获阶段的 keydown、会话 header 上的 badge/chip 订阅，在这条路径上构不成长任务。

同页样式 A/B/A（只动 `style[data-plugin]` 为 `dsh-idea` / `dsh-files-navigator` / `dsh-idea-run` / `dsh-git-manager` 的四张表；各 3 个循环）：

| 集合 | with（去掉前）平均 | without 平均 | 加回后平均 | 是否「去掉变快、加回变慢」 |
| --- | --- | --- | --- | --- |
| 四张一起 | 3 / 150ms | 2 / 118ms | 2 / 133ms | 3 轮里只有 1 轮符合，不成立 |
| 只 `dsh-idea` | 2 / 115ms | 3 / 170ms | 2 / 109ms | 相反：去掉后更慢，加回后回到较快一侧 |
| 其余三张 | 2 / 96ms | 2 / 133ms | 3 / 163ms | 不成立；后半段整体有变重的漂移 |

因此：**不能**根据「感觉样式还贵」去懒加载或再改选择器。高亮规则在页面上仍是 `.dce-paint::highlight(...)`，没有裸的 `::highlight()`（用选择器字面值核对，不是把 `.dce-paint::highlight` 误判成裸规则）。

切会话期间（右栏关、Git/Run 关）没有 `plugins/dsh-idea` 的 `git/state`、`git/log`、`run/list`、`run/tail`。Network 探针（`GET /plugins/dsh-idea/package.json`）是通的，不是漏听请求。

### 9.2 聊天滚动（已有 transcript，不是流式输出）

右栏关闭，滚动最主要的对话容器（`wSkVaW_scrollBody`，约 6512×824）：长任务 **0 / 0 / 0**。未做样式 A/B/A（基准已经是 0，加回无法变慢）。**没有发消息，流式输出未测。** 右栏全屏盖住对话也未单独测。

### 9.3 打开编辑器后收起，再切走切回

- 打开右栏但还没打开编辑器：`.dce-root` 为 0，`[data-dce-idle]` 为 0。符合「切到会话不会自动挂编辑器」。
- `__dshEditorPanel.open()` 之后：`.dce-root === 1`，树还在（`rootHasTree: true`），没有打开具体文件所以 `pre.dce-paint` 为 0。
- 点「收起右侧边栏」之后：`rightOpen === false`，但 `.dce-root` 仍为 1、树仍在。收起动画没有被掏空。
- 保持收起，切到另一个会话：`.dce-root` 和 `[data-dce-idle]` 都是 0。再切回来（仍收起）仍都是 0。期间 **没有任何** `plugins/dsh-idea` 请求（没有目录列表，没有 `git/state`）。

### 9.4 Git 打开再关掉

- `window.__dshGitPanel.open()` 后 3s 内请求：`git/repos` 1 次、`git/state` 2 次、`git/log` 1 次。`data-dsh-git-dock` 变为 `"1"`。
- `close()` 之后：dock 标记回到 `"0"`。随后 **16s** 内（覆盖 15s tick）**零**次 `git/state` / `git/log`。
- 关闭后 `.dce-gitpane` 占位节点还在（编辑器布局里预留的空槽，`childElementCount === 0`，HTML 长度 0），轮询已停。

### 9.5 Run 打开再关掉

- `window.__dshRunPanel.open()` 后约 2s：`run/list` 1 次，然后大约每 700ms 一次 `run/tail`（该窗口里 3 次）。
- `close()` 之后：`.drun-pane` 为 0，`data-dsh-run-dock` 为 `"0"`（teardown）。随后 **3s** 内零次 `run/list` / `run/tail`。

### 9.6 启动成本

从 navigate 到会话列表出现约 872ms（整页，含宿主）。`performance` 里本插件相关资源：

- `dsh-idea/client.js` 走组合 bundle（`/plugins/??...&rev=...`，与大量宿主 client 打在一起）：该请求 transfer 约 725KB、decoded 约 3.3MB、耗时 43ms。**不能把这个体积算成插件自己的。**
- 独立 chunk：`client.nav.js` transfer 28KB / decoded 89KB / 2ms；`client.git.js` 62KB / 214KB / 3ms；`client.run.js` 14KB / 42KB / 2ms。
- 启动阶段长任务 2 个（56ms + 193ms），发生在整页加载，没有「关掉本插件」的对照，不能归因到这四个 chunk。

按任务要求：**不为了体积去拆** `immediately` / `bootChunk`。

### 9.7 未测或无法下结论的路径

- **流式输出**：禁止发消息，未测。
- **大文件打字 / 滚动 / 查找 / 双击符号**：编辑器打开后没有打开具体文件（空壳，没有 `pre.dce-paint` / textarea），未对用户仓库里的文件做 `openFile`。没有 profile 证明 Range 或 textarea 是瓶颈，**不做虚拟化**。
- **右栏全屏盖住对话时的滚动**：未单独测。
- **大目录树、Search Everywhere、大 diff 在面板可见时的渲染**：未打开文件树或 diff。面板不可见时已确认不会发出搜索或目录、`git/state`、`run/*` 请求。
- Git 提交草稿在卸树后仍保留：本次没有输入草稿；该路径代码未改。

### 9.8 结论

没有新的、经得起同页 A/B/A 或 SELF 时间证明的热点，因此 **不改 `lib/client*.js`，构建标记保持 `2026-11-17.perf4`**。已修好的行为在本次页面上都还在：历史泵默认 off、高亮只挂在 `.dce-paint`、收起不掏空已画的树、切走再切回且右栏仍收起时不重新挂编辑器、Git/Run 关闭后不再轮询。剩余的切会话长任务（重 transcript 上 2–3 个约 50–66ms）主要是宿主给对话做布局，本插件脚本 SELF 只有零点几毫秒；再动样式或加缓存/节流没有证据。

## 10. 2026-11-18 大文件编辑测量（未改代码）

- 日期：2026-11-18 10:07–10:08（Asia/Shanghai）。
- `dsh web` **未重启**，进程仍是 PID 31712。独立 headless Edge，新的 `--user-data-dir`，视口 **1440×900**。
- 只用已有会话：侧栏「plugins」工作区下的既有会话，cwd 为 `/Users/lucas/Documents/Projects/Personal/dsh/plugins`。没有新建会话，没有发消息，没有打开或改 EPF/MM、BNGS、Luna 等业务仓库。
- 测量文件写在该工作区的 `.perf-large-tmp/`（`perf-mid-50k.js` / `perf-near-180k.js` / `perf-over-250k.js`），测完已删除。全程没有 `plugins/dsh-idea/write` 请求。打字后用 `execCommand("undo")` 还原，缓冲区离开时是干净的。
- 调用方式：`__dshEditorPanel.open()`，再 `openFile(rel)`。页面上出现了 `pre.dce-paint`（单 text node）。
- 进入页面时标记是 `window.__dshIdeaBuild === "2026-11-17.perf4"`，`window.__dshIdeaHistoryPump === "off"`。高亮规则仍是 18 条 `.dce-paint::highlight(...)`，没有裸的 `::highlight()`（先去掉 `.dce-paint::highlight(` 再数剩余的 `::highlight(`，避免把限定规则误判成裸规则）。

### 10.1 中途构建切换（重要）

本审查没有改 `lib/client*.js`。大约在 10:07:40（Asia/Shanghai），工作区里的 `plugins/dsh-idea/lib/client.js` 被**其他改动**写成 `window.__dshIdeaBuild = "2026-11-18.ux1"`（mtime 对得上；本进程没有写这个文件）。`dsh web` 未重启，但随后的 combo 从 `rev=78dc54acd1f7` 变成了 `rev=280959e4f3b1`，页面标记变成 `ux1`。

因此：

- 50k 的打开、滚动、稀有词查找、以及「function」查找的热身轮，是在 **perf4** 上测的。
- 50k 的「function」查找后两轮、以及 50k 打字：热更新把编辑器卸掉了（`pre.dce-paint` 变为 0，路径回到「从左侧选择文件」），**无效，未计入结论**。
- 180k / 250k 的打开、滚动、查找、打字是在 **ux1** 上测的。

本节只报告测到的数字，不把 ux1 的改动说成本次审查的结论，也不改构建标记。

### 10.2 文件与绘制状态

| 文件 | 字符 / 行 | 与上限的关系 | 语法高亮 |
| --- | --- | --- | --- |
| 50k 对照 | 50,000 / 1,725 | 低于 `PAINT_TEXT_MAX=200000` | 2,807 个 Range（`dce-k` 1296、`dce-s` 437、`dce-c` 216、`dce-n` 858），低于 `SYNTAX_RANGE_MAX=8000`，有颜色 |
| 180k 近上限 | 180,000 / 6,155 | 仍低于 200k，会做 tokenize | 高亮总数为 0。按 50k 的密度外推约 1 万个 Range，超过 8000 后布局 effect 弃掉彩色；`paintDocument` / `paintLine` 仍会跑，profile 里大约 3ms |
| 250k 超上限 | 250,000 / 8,542 | 超过 200k，不做 tokenize | 单 text node，高亮 0（符合设计） |

查找探针 `PERF_NEEDLE_7f3a` 在三个文件里各出现 16 次。公共查询 `function` 在 50k 上是 215 次，在 180k / 250k 上顶到 `USAGE_MAX=400`。

编辑器滚动容器 `.dce-scroller`：50k 高约 31,094px，180k 约 110,834px，250k 约 153,800px；可视高度 764px。

### 10.3 打开 / 首次绘制

「等到 `pre.dce-paint` 达到目标长度」大约 100–110ms（含 `/read`）。下面的长任务是热身之后的稳态，含随后约 400ms 的结算等待。

- **50k（perf4）**：热身和 3 轮稳态长任务均为 **0**。`/read` 每次都会打。100µs profile 里，按「非 combo 的 `/plugins/dsh-idea/` URL」计的插件 SELF 是 **0**。combo 帧 `.../directory-picker-native/client.js,dsh-idea/client.js&rev=78dc54acd1f7` 里能看到 `paintLine` 0.8ms、一个匿名帧 11.6ms；按既有规则 combo 宿主帧不算插件时间。样本里大部分是 idle / program / GC。
- **180k（ux1）**：热身 1 个长任务 63ms；稳态 0、0、1×59ms。profile：combo `??dsh-idea/client.js&rev=280959e4f3b1` 匿名约 29.9ms，`paintDocument` 1.6ms + `paintLine` 1.6ms。非 combo 插件 SELF 仍是 0。
- **250k（ux1）**：热身 1×63ms；稳态 1×52ms、1×75ms、1×73ms。profile：同一 combo 匿名约 38.5ms，几乎没有 tokenize（符合超 `PAINT_TEXT_MAX`）；能见到 `escapeHtml` / `openRel` 的零点几毫秒。非 combo 插件 SELF 仍是 0。

180k 与 250k 打开时都会出现约 50–75ms 的长任务，但 250k 已经不做 tokenize，说明瓶颈更像是给超高的 `<pre>` + textarea（按行数 × 18px 估算高度）做布局，而不是 Range 或高亮脚本。没有 profile 证明插件脚本本身是稳定热点，**不做虚拟化，也不改高度估算**。

### 10.4 滚动

键盘或程序地改 `.dce-scroller.scrollTop`（同步连跳 7 档，以及分步等待的 paced 滚动）。50k / 180k / 250k 的热身和稳态长任务均为 **0**，非 combo 插件 SELF 为 0。

### 10.5 查找

用 Meta+F 打开查找条（`__dshEditorHotkeys` 上没有 `find`），再输入查询。

- 稀有词（16 次命中）：三个文件的热身和稳态长任务均为 0；着色也是 16 个 `dce-hit`。
- `function`：50k 热身（perf4）215 次命中，长任务 0。该文件后两轮作废（见 10.1）。180k / 250k 均顶到 400 次，热身和稳态长任务为 0。

### 10.6 打字

每个文件插入 `X` `Y` `Z` 三个字符，再全部 undo，不保存。

- **50k**：热更新后没有 textarea，未测。
- **180k（ux1）**：三次都变成脏（长度 180003），undo 3 次恢复干净。长任务 0。稳态 profile 里 combo 匿名约 43.2ms、`paintDocument` 2.2ms（累计在整段插入窗口上，不是单次 ≥50ms 长任务）。非 combo 插件 SELF 为 0。无 `/write`。
- **250k（ux1）**：同样脏 250003、undo 恢复。长任务 0。combo 匿名约 53.9ms，加上 `escapeHtml` 0.2ms；仍没有 ≥50ms 长任务。无 `/write`。

### 10.7 符号跳转

在 50k 文件上调用了 `__dshEditorHotkeys.goto("goToDefinition")`。800ms 内没有弹出选择列表，长任务为 0。生成的临时 JS 没有可用的工程 LSP，**不能当作符号跳转的性能结论**。

### 10.8 未测或作废

- 50k 打字，以及 50k「function」查找的后两轮：热更新卸掉了编辑器。
- 流式输出、全屏右栏盖住对话、大目录 / Search Everywhere / 大 diff：本次仍未测。
- 没有对真实业务文件打字或保存。
- 符号跳转没有可脚本化的有效结果。

### 10.9 结论

没有新的、能用重复长任务和插件 SELF 对上的、值得改 `lib/client*.js` 的热点，因此 **不改客户端代码**。本次审查也没有改构建标记。已经成立、仍需保持的行为在这次页面上还在：历史泵默认 off、高亮只挂在 `.dce-paint`、单 text node、`PAINT_TEXT_MAX` / `SYNTAX_RANGE_MAX` 上限仍生效。

剩余风险：大约 140k–200k 的稠密 JS 仍会 tokenize，然后因超过 8000 个 Range 放弃彩色；打开 180k 以上文件时，首次布局可能有一次约 50–75ms 的长任务。若以后要动虚拟化或高度估算，需要专门证明 textarea / 布局（而不是 tokenize 脚本）是用户可感瓶颈。

## 11. 可复用测量脚本（2026-11-18）

把第 9、10 节用过的方法收成了仓库内脚本，路径：`scripts/perf/`。说明见 `scripts/perf/README.md`。本节只记录怎么跑，不改写前面的结论或数字。

在 `plugins/dsh-idea` 目录、且 `dsh web` 已经在跑时：

```bash
node scripts/perf/measure.mjs smoke
node scripts/perf/measure.mjs session-switch
node scripts/perf/measure.mjs all
```

默认连 `http://127.0.0.1:3080`，视口 1440×900，结果写到 `/tmp/dsh-idea-perf/<时间戳>/`。脚本不会启动或重启 `dsh web`，不会新建会话、发消息或保存文件。Token 只在运行时从 `~/.dsh/dsh-web.log` 读取，不会写进结果或终端。
