# dsh-idea 性能测量脚本 / Performance harness

把 2026-11-17/18 审查用过的方法收成可复用脚本：独立的 headless Edge（或 Chrome）+ CDP，连到已经在跑的 `dsh web`，测长任务和插件 SELF。本目录不改插件客户端代码，也不启动或重启 `dsh web`。

This packages the audit method (not the historical numbers) so it can be rerun later. It never starts or restarts `dsh web`.

## 前提 / Prerequisites

- `dsh web` **已经在跑**，默认 `http://127.0.0.1:3080`。脚本发现服务没起来会直接失败，不会替你启动。
- 至少有 **已存在的会话**。脚本只点现有的 `.YDXeBa_sessionRow`，**不会新建会话，也不会发消息**。
- macOS 上安装了 Microsoft Edge（优先）或 Google Chrome。可用 `--browser` 指定二进制路径。
- Node.js 22+（需要内置 `WebSocket`；当前开发机是 Node 24）。**没有 npm 依赖**，不要为此去装包或改 `node_modules`。
- 默认视口是 **1440×900**。不设视口时对话 DOM 会偏少，切会话的结论无效。脚本会在导航前设置视口，对不上就失败。

## 怎么跑 / How to run

在 `plugins/dsh-idea` 目录下：

```bash
# 只做连通性检查：登录、列出已有会话、记录构建标记 / 历史泵 / 高亮规则
node scripts/perf/measure.mjs smoke

# 单个套件
node scripts/perf/measure.mjs session-switch
node scripts/perf/measure.mjs chat-scroll
node scripts/perf/measure.mjs editor-lifecycle
node scripts/perf/measure.mjs git-run
node scripts/perf/measure.mjs large-file

# 按顺序跑全部套件（git-run 会等约 16s 确认轮询停止；large-file 更久）
node scripts/perf/measure.mjs all
```

常用参数 / flags（也可用环境变量）：

```bash
node scripts/perf/measure.mjs session-switch \
  --url http://127.0.0.1:3080 \
  --viewport 1440x900 \
  --outdir /tmp/dsh-idea-perf
```

| 参数 | 环境变量 | 默认 |
| --- | --- | --- |
| `--url` | `DSH_IDEA_PERF_URL` | `http://127.0.0.1:3080` |
| `--viewport` | `DSH_IDEA_PERF_VIEWPORT` | `1440x900` |
| `--outdir` | `DSH_IDEA_PERF_OUTDIR` | `/tmp/dsh-idea-perf` |
| `--browser` | `DSH_IDEA_PERF_BROWSER` | 系统里的 Edge，其次 Chrome |
| `--token-log` | `DSH_IDEA_PERF_TOKEN_LOG` | `~/.dsh/dsh-web.log` |
| `--switches` |  | 每轮切会话次数，默认 7 |
| `DSH_IDEA_PERF_SAFE_CWD` | 额外允许 large-file 写临时文件的目录，用 `:` 分隔 |  |

登录 token 只在运行时从 log 里读取，**不会**打到终端，也不会写入结果 JSON。不要把 `dsh-web.log` 里的 token 贴进文档或 issue。

## 套件 / Suites

| 套件 | 做什么 |
| --- | --- |
| `smoke` | 连上已运行的服务，列出已有会话，记录 `__dshIdeaBuild`、`dsh.files.historyPump` / `__dshIdeaHistoryPump`、高亮规则是否只挂在 `.dce-paint` 上。 |
| `session-switch` | 先收起右栏，快速切换已有会话。先 warmup 一轮，结论看后面的稳态轮。 |
| `chat-scroll` | 滚动**已有**对话，不是流式输出（脚本不会发消息）。 |
| `editor-lifecycle` | 打开右栏后必须调用 `__dshEditorPanel.open()` 才会挂上编辑器；再收起右栏，切走再切回。检查已画的树是否还在，切回时不要白做目录 / git 请求。 |
| `git-run` | 打开再关闭 Git / Run，分别等 16s 和约 4.5s，断言 `git/state`、`git/log`、`run/list`、`run/tail` 的轮询已停。 |
| `large-file` | 在安全的已有会话工作区（`Personal/dsh` 或 `/tmp`，不会打开 EPF/MM、BNGS、Luna 等业务仓库）生成中等、接近和超过 `PAINT_TEXT_MAX`（20 万字符）的临时 JS，测量打开 / 首屏 / 滚动 / 查找 / 打字+撤销，然后删除临时文件。打字必须全部撤销，不允许 `/write`。 |
| `all` | 按上表顺序跑完。 |

历史审查里做过的「同页去掉 / 加回插件样式」A/B/A 是一次性因果对照，没有收成常规套件。

## 如何解读 / How to read results

标准输出是一份不含密钥的摘要。完整 JSON 写在 `--outdir` 下按本地时间（Asia/Shanghai）命名的子目录里，例如 `/tmp/dsh-idea-perf/2026-11-18T10-15-12/`。

- **长任务**：`PerformanceObserver` 的 `longtask`，阈值 ≥50ms。关注 `count`（个数）、`sum`（合计毫秒）、`max`（单次最大）。先跑 warmup，**结论只用后面的稳态轮**。
- **插件 SELF**：CPU profile 采样间隔 100µs，只计 SELF。官方口径是：**只有非组合的** `/plugins/dsh-idea/` URL 算插件时间。`/plugins/??...&rev=...` 这种 combo 宿主帧**不算**插件时间，即使函数名看起来像本插件。
- **历史泵**：`__dshIdeaHistoryPump` 应为 `off`（除非你故意在 `localStorage["dsh.files.historyPump"]` 打开）。
- **高亮规则**：应是 `.dce-paint::highlight(...)`，裸的 `::highlight()` 应为 0。计数时先去掉 `.dce-paint::highlight(` 再数剩下的 `::highlight(`，避免把限定规则误判成裸规则。
- **视口**：摘要里会打印实际视口。切会话时如果不是你指定的尺寸，这组数不能和以前的 1440×900 基线比。

## 安全与清理 / Safety and cleanup

脚本会：

- 使用全新的 `--user-data-dir`（`/tmp/dsh-idea-perf-edge-*`），不会附着到你正在用的浏览器窗口。
- 只切换已有会话，不新建，不发消息，不保存文件，不重启 `dsh web`。
- `large-file` 只在安全 cwd 写可删除的临时 JS，测完删除；若观察到 `/write` 会判失败。
- 结束时只杀掉**本次**启动的 Edge/Chrome 子进程和本次临时 profile。不会杀你日常使用的浏览器，也不会清理「另一次还在跑的审查」的进程。

如果某次运行中途崩溃，可能留下 `/tmp/dsh-idea-perf-edge-*`。确认没有正在跑的测量后，可以手动删这些目录，并结束对应的 headless 进程。不要用「杀掉所有 Edge」的方式清理。

## 文件结构 / Layout

```
scripts/perf/measure.mjs          入口
scripts/perf/lib/config.mjs       默认值和参数
scripts/perf/lib/cdp.mjs          启动浏览器、CDP、token、清理
scripts/perf/lib/page.mjs         长任务、profile、网络、快照、UI 操作
scripts/perf/suites/*.mjs         各套件
```

方法论的历史记录和当时的数字仍在 `docs/performance-context.md` 第 9、10 节。本脚本编码的是方法，不是那些数字。
