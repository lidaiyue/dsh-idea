dsh-idea

[English](README.md) | 中文

DSH 右栏里的极简 IDEA。

![搜索文件与 Git](screenshots/search-git.webp)

![数据库面板](screenshots/database.webp)

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
- 数据库面板：连接 PostgreSQL、MySQL、Oracle、Redis。逐层浏览模式、表和字段；在表格里预览数据，直接改单元格或新增行；把一张表、一个模式或整个库导出成 SQL（Redis 导出为 JSON），或运行脚本导入。每个连接可开一个 SQL 控制台，Redis 则是键浏览和命令控制台。密码存在 DSH 凭据库里
- 选中文件内容后，用快捷键把选区 @ 到对话（默认 `⌥⌘I` / `Ctrl+Alt+I`）；没有选区时引用当前文件

## 许可证

[MIT](LICENSE)
