dsh-idea

[English](README.md) | 中文

DSH 右栏里的极简 IDEA。

用 Agent 同时推进几个项目时，拖慢你的往往不是模型，而是旁边那个越开越沉的 IDEA：切窗口、等索引。dsh-idea 把文件、编辑、跳转和多仓库 Git 放进 DeepSeek Harness 的右栏。Agent 在写，你在同一块屏幕上看、改、提交，不用为了看一眼代码再跳回 IDEA。它跑在 PWA 里，几乎不额外占资源，就是为了在这条工作流里把 IDEA 换掉。

![搜索文件与 Git](screenshots/search-git.webp)

## 安装

```sh
dsh plugin --profile web add /absolute/path/to/dsh-idea
```

装上后重启 `dsh web`，再刷新页面。

## 特性

- 工作区文件树：按层浏览，新建、重命名、删除文件和文件夹
- 文本编辑：语法着色、查找、保存
- Markdown 预览，可在预览和源码之间切换
- 支持搜索文件名及文件内容跳转
- 语言服务器：跳转到定义、实现，并查找引用。可执行文件在 `PATH` 中即启用，没有则状态栏提示
  - JavaScript / TypeScript：`npm install -g typescript-language-server typescript`
  - Python：`npm install -g pyright`
  - Rust：`rustup component add rust-analyzer`
  - Go：`go install golang.org/x/tools/gopls@latest`
  - C / C++：安装 `clangd`（一般随 LLVM）
  - Java：安装 `jindex`（[java-index](https://github.com/slgobinath/java-index)）
  - Lua：安装 `lua-language-server`
- Git：分支与历史、diff、提交、拉取、推送。工作区根如果是仓库会管理它；下一层各自带 `.git` 的目录也会列出，在面板里切换
- 运行面板：启动和停止自动发现的应用（Maven/Gradle 的 Spring Boot、JS monorepo 里具体的 dev 脚本、并列的独立前端）以及 `.dsh/run.json` 里声明的项。Option+F12 / Alt+F12 开关面板
- 在编辑器里直接运行 `.sql`：打开 SQL 文件后点文件栏（文件名那一行右侧）的「运行」，或按 `⌘⏎` / `Ctrl+⏎`（与 SQL 控制台一致，可在快捷键面板改键）。跑哪个库：脚本会打开成它自己的 SQL 控制台，在控制台工具条上选连接和数据库（与普通控制台同一处选择器），选择同时绑定到文件；文件里写了 `-- datasource:` 或用过一次后会自动带上，脚本在 SQL 控制台里执行，结果显示在结果面板。脚本属于哪个连接按这个顺序定：文件里的 `-- @dsh-connection`（本插件写入）、JetBrains 风格的 `-- datasource: <连接名>`、唯一的那个连接；都没有时打开一个未绑定连接的控制台让你选，再运行。每次运行都重新读取磁盘上的文件，跑的是已保存的内容
- 快捷操作：状态栏打开快捷键列表，点击按键重新录制，也可清除或恢复默认。键位存在本插件里，不依赖其他插件
- 选中文件内容后，用快捷键把选区 @ 到对话（默认 `⌥⌘I` / `Ctrl+Alt+I`）；没有选区时引用当前文件

## 许可证

[MIT](LICENSE)
