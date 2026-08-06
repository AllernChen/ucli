<p align="center">
  <img src="resources/icons/ucli.png" width="112" alt="UCLI Logo" />
</p>

# UCLI

UCLI 是一个支持 macOS 与 Windows 的本地 AI CLI 工作台。它在用户与已安装的 Claude Code、Codex、OpenCode、U-Code 之间转发终端输入输出，保留原生 CLI 交互，同时提供多会话编排、安全确认、历史恢复和使用统计。

## 主要功能

- 原生终端代理：不重做 Claude Code、Codex、OpenCode、U-Code 的交互界面。
- 会话发现：按工作目录发现并导入 Claude Code、Codex、OpenCode、U-Code 历史会话。
- 多会话工作台：支持 1、2、4 窗格、导航收缩、会话列表隐藏、单窗格/分屏整体全屏，以及 `Tab`/`Shift+Tab` 切换会话。
- 完整历史视图：每个窗格可独立切换原生终端与只读历史，支持分页、文本选择和滚动查看最早对话，切回终端时保留原生 TUI 状态。
- 后台通知：Claude/Codex 需要确认、等待用户输入或完成任务时显示系统通知；通知标明会话与操作类型，点击后定位到对应工作台窗格。
- 会话生命周期：支持停止、关闭窗格、移除和重新添加。
- 安全规则：可信命令自动放行，高风险操作要求确认，硬黑名单始终拒绝。
- 使用留痕：记录 Token、费用、轮次、审批和模型统计；移除会话后仍保留历史统计。
- Provider 回退：Codex 历史 provider 已失效时，可使用当前可用 provider 恢复原上下文。
- 配置档案中心：为 Codex 和 Claude Code 创建独立连接档案，支持应用默认、项目默认、单会话选择与版本回滚；Codex 额外支持文件漂移修复。
- CC Switch / Codex 配置共存：UCLI 只读 `config.toml` 的 Provider 身份，不读取或写入密钥、认证、CC Switch 数据库或原生会话文件。新建 Codex 会话默认跟随当前 live 配置；历史会话可选择保留来源 Provider、跟随当前或显式指定，并在外部配置变化后于下次启动生效。
- CLI 管理：在设置页检测、安装和升级受支持的 AI CLI。
- 桌面体验：单实例、关闭到托盘、后台审批/任务完成提醒、托盘恢复和退出清理；macOS 终端支持 `Command+C`/`Command+V`。

当前适配 Claude Code、Codex、OpenCode 和 [U-Code](https://github.com/AllernChen/U-Code)。OpenCode 与 U-Code 均支持原生 TUI、新建/恢复会话、按目录发现历史、完整历史视图、三档权限映射，以及逐会话模型、Token、轮次统计；CLI 导出未提供费用时会显示“不可用”，不会误报为 `$0`。两者的可执行文件、配置环境和原生会话数据彼此隔离。

## 配置档案

0.8.1 的一级页面“配置档案”支持 Codex 与 Claude Code。Codex 支持两种可保存档案：

- 引用档案：引用 Codex `config.toml` 中已有的 Provider，不复制 Provider 端点、请求头或密钥。
- UCLI 托管档案：保存 Base URL、模型、推理强度和上下文窗口，并为该档案生成 UCLI 自有的 Codex profile 文件。API Key 使用操作系统安全存储加密，只在启动目标 Codex 进程时注入该进程的环境。

Claude Code 支持三种连接方式：

- Claude 登录态：使用 Claude Code 已有的订阅登录，本会话不继承 API Key、Bearer Token 或云服务商路由变量。
- Anthropic API Key：可使用 Anthropic 官方地址或填写自定义 Base URL；该档案会覆盖当前 Claude 订阅登录用于本会话。
- Bearer Token 网关：必须填写 Base URL，适合兼容 Anthropic 协议的企业网关。

档案只对由 UCLI 启动或重启的会话生效。选择“系统当前”时保留当前环境和 CLI 自身配置；Bedrock、Vertex 与 Foundry 继续使用系统配置。UCLI 不读取 Claude OAuth token，不修改 Claude 全局设置，也不读取或写入 Codex/ChatGPT 的 OAuth 登录状态、`auth.json` 或 CC Switch 数据库。

托管 API Key 与 Bearer Token 使用操作系统安全存储加密，只在启动目标 Claude Code 子进程时注入，并启用子进程凭据清理；密钥不会进入命令行、临时设置、页面状态、会话记录、日志或诊断报告。历史会话默认保持历史连接，除非用户明确选择具体档案或“跟随当前”。运行中的会话切换档案不会自动重启，用户可以选择下次重启生效或立即重启。Claude Code 交互模式不支持可靠的 fallback model 参数，因此 UCLI 只提供首选模型；若组织策略替换模型，会在会话中显示实际模型。

OpenCode 和 U-Code 在 0.8.1 中继续沿用各自系统配置；配置档案页面只展示它们的安装状态、版本和路径。

## 下载与安装

Windows 与 macOS 版本均可从 [GitHub Releases](https://github.com/AllernChen/ucli/releases) 下载：

- `UCLI-Setup-<version>-x64.exe`：Windows 安装版。
- `UCLI-Portable-<version>-x64.exe`：Windows 便携版。
- `UCLI-<version>-<arch>.dmg`：macOS 安装镜像。
- `UCLI-<version>-<arch>.zip`：macOS 压缩包。

当前 Windows 与 macOS 本地构建产物均未进行代码签名。Windows 首次运行可能出现 SmartScreen 提示；macOS 首次运行可能被 Gatekeeper 拦截。请仅使用可信源码或 Release 产物。

## 快速开始

1. 安装并启动 UCLI。
2. 在“设置”页面检测本机 AI CLI；U-Code 的安装和升级由 UCLI 从 [GitHub Latest Release](https://github.com/AllernChen/U-Code/releases/latest) 下载对应平台的原生二进制。
3. 在“会话”页面新建会话并选择工作目录。
4. UCLI 会扫描该目录对应的原生历史会话，可选择导入或新建。
5. 在工作台选择 1、2、4 窗格管理多个会话。

## 会话操作语义

| 操作 | CLI 进程 | UCLI 记录 | 原生会话 | 用量与审计 |
| --- | --- | --- | --- | --- |
| 关闭 | 继续运行 | 保留 | 保留 | 保留 |
| 停止 | 终止 | 保留，可恢复 | 保留 | 保留 |
| 移除 | 终止 | 从工作台移除 | 保留 | 保留 |

## 数据位置

UCLI 的生产数据默认保存在：

```text
macOS:  ~/Library/Application Support/ucli/ucli.db
Windows: %APPDATA%\ucli\ucli.db
```

开发版使用同一系统数据根目录下独立的 `ucli-dev` 目录，不会与安装版争用单实例锁或数据库。UCLI 不会删除 Claude Code、Codex、OpenCode、U-Code 自己保存的原生会话。

## 本地开发

要求 Node.js 与 npm。macOS 请在目标架构的 Mac 上构建；Windows 建议在 Windows 10/11 x64 环境构建。

```sh
npm install
npm run dev
npm test
npm run build
npm run dist
npm run verify:release
```

`npm run dist` 自动为当前操作系统打包，输出到 `dist/`。也可使用 `npm run dist:mac` 或 `npm run dist:win` 显式选择目标平台。
`npm run verify:release` 按当前系统校验构建产物、版本、命名规则和更新元数据的 SHA-512。Windows 完整人工发布验收见 [docs/release-acceptance.md](docs/release-acceptance.md)。

## 安全说明

安全规则用于减少重复确认并拦截已知高风险操作，但不能替代用户判断、系统权限隔离或数据备份。执行删除、发布、权限变更等高影响操作前，请核对命令和目标范围。

## License

[MIT](LICENSE)
