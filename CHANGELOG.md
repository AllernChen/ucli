# Changelog

本项目的重要变更记录在此文件中。

## [Unreleased]

## [0.7.4] - 2026-08-05

### Fixed

- Windows upgrades now close legacy same-name UCLI processes before invoking an older uninstaller, including hidden tray and path-unavailable remnants.
- The scoped installer process check now uses the extension-free PowerShell process name and is covered by real-process regression tests.

## [0.7.3] - 2026-08-05

### Fixed

- Windows NSIS upgrades now detect and close only `UCLI.exe` from the selected installation directory, avoiding false process conflicts with other UCLI installations or portable copies.

## [0.7.2] - 2026-08-04

### Fixed

- 补齐 Codex runtime 的 renderer IPC 转发，修复工作台启动时报 `ipc.getCodexRuntime is not a function`、从而中断会话与分屏恢复的问题。

## [0.7.1] - 2026-08-04

### Fixed

- 修复 UCLI 重启后工作台已有空窗格未回填保存会话的问题；2/4 分屏会直接恢复上次分配的会话，无需先切换分屏。

## [0.7.0] - 2026-08-04

### Added

- Codex 现在支持显式配置目录；优先级为 UCLI 设置、`CODEX_HOME`、用户目录下的 `.codex`。配置只读，UCLI 不会写入 CC Switch 或 Codex 的配置、认证和原生会话文件。
- Codex 会话可选择“来源 Provider”“跟随当前”或“显式指定”策略；设置页会显示已脱敏的当前 Provider 和可用 Provider，并监听外部配置变化。

### Changed

- 新建 Codex 会话默认跟随当前 live 配置，导入的历史会话默认保留来源 Provider；Provider 已不可用时会回退到当前配置并在界面提示。正在运行的会话不会因外部配置变化自动重启。

### Fixed

- UCLI 重启时会按工作目录和创建时间恢复缺失的 Codex 原生会话 ID，重新打开会话时使用 `codex resume <id>`，不再误建新会话。

## [0.6.0] - 2026-08-01

### Added

- 新增 U-Code 一等适配器，支持原生 TUI、新建/恢复、按工作目录发现历史会话、完整历史视图与 Gateway 转发。
- 设置页支持检测、安装和升级 `ucode`；安装与升级直接使用 `AllernChen/U-Code` 的 GitHub Latest Release 原生二进制，不依赖 npm。
- U-Code 支持 UCLI 三档权限映射，以及逐会话模型、Token、轮次与费用可用性统计。

### Changed

- OpenCode 系谱适配核心改为运行时配置，在共享权限、统计、历史和 Gateway 解析能力的同时，隔离 OpenCode 与 U-Code 的可执行文件、配置环境变量和原生会话数据。

### Fixed

- Codex Gateway 现在识别新版 `custom_tool_call` 审批事件，将 1/2/3 选项推送到飞书，并把飞书数字回复映射回 Codex TUI。

## [0.5.3] - 2026-07-31

### Added

- 终端链接支持点击直接打开，简化了链接处理逻辑。

## [0.5.2] - 2026-07-31

### Added

- 工作台左侧会话列表展示飞书转发状态；会话卡片与窗格使用飞书渠道图标。

### Fixed

- 新建飞书会话根卡后立即初始化可直接回复的话题，避免首次需要手动引用回复。
- 未选择转发的飞书图标灰度显示；已选择转发时恢复彩色状态。

## [0.5.1] - 2026-07-31

### Added

- 会话卡片和工作台窗格提供统一的 Gateway 转发快捷入口；全局 Gateway 开关仍只位于工作台头部。

### Fixed

- 明确区分会话“已选择”与“正在转发”状态，防止在 Gateway 未就绪时产生误导。
- 防止同一会话重复提交转发切换；失败后恢复服务端状态并显示错误提示。

## [0.5.0] - 2026-07-30

### Added

- 新增全球通信网关内核原语：网关通道、路由、适配器语义与配置持久化。
- 为 Claude Code、Codex CLI 和 OpenCode 暴露统一网关能力接口。
- 新增飞书（Feishu）入站网关通道与网关运行时集成。
- UCLI 工作台新增网关控制面板，支持查看和绑定飞书入站通道。

### Fixed

- 修复权限决策在网关场景下保持 pending 状态的问题。

## [0.4.10] - 2026-07-29

### Fixed

- Added visible software-update download progress, transfer details, and explicit installation handoff status.

## [0.4.9] - 2026-07-29

### Added

- 工作台每个会话窗格新增独立的完整历史视图；Claude Code、Codex 和 OpenCode 原生历史统一分页加载，可选择文本并独立滚动，切回后原生 TUI 状态保持不变。

### Fixed

- OpenCode complete-history views now use the local unsanitized export; statistics continue to use the sanitized export.
- Removed the global application header from the workbench while preserving its local workbench controls.
- 修复全屏 TUI 使用 xterm alternate buffer 时无法依靠终端 scrollback 查看早期对话的问题。
- 修复 OpenCode 恢复会话只显示当前 TUI 输出、未加载完整源会话历史的问题。
- 修复 2/4 分屏首次启动以及侧栏、分屏和全屏切换后 PTY 尺寸同步滞后导致的内容裁剪和重绘不完整。

## [0.4.8] - 2026-07-29

### Fixed

- Prevented Ctrl+V from being forwarded twice by the terminal key handler.
- Removed fixed Claude Code and Codex provider tags from the page header.

## [0.4.7] - 2026-07-28

### Added

- Settings now provides a safe support-diagnostics report with UCLI runtime, AI CLI availability, and local persistence status.
- Packaged installer builds can manually check, download, and install signed GitHub Release updates from Settings; portable and development builds remain manual-download only.

### Security

- Diagnostic exports deliberately exclude conversation content, session metadata, paths, logs, rules, secrets, and raw CLI output.

## [0.4.6] - 2026-07-28

### Added

- Configurable workbench and terminal keyboard shortcuts, including Tab / Shift+Tab pane switching and Ctrl-click session-to-new-pane.
- Ctrl-click (Windows/Linux) or Command-click (macOS) terminal web links, with main-process HTTP(S)-only external URL protection.
- Persisted window bounds, maximized state, navigation collapse, and workbench session-list visibility.

### Fixed

- Restoring a window saved on a disconnected display now falls back to a visible default window.
- Closing or removing a workbench pane now compacts remaining sessions safely and clears the persisted ID for a lone closed pane.
- Preserved macOS paste behavior and disabled/legacy-cleared shortcut compatibility.

## [0.4.5] - 2026-07-27

### Fixed

- OpenCode 历史会话恢复改为仅传递源会话 ID 启动原生 TUI，不再覆盖历史会话的模型与供应商配置；TUI 内仍可使用 `/session` 手动切换。
- 修复 OpenCode 1.18.x 因 `permission.webfetch`、`permission.websearch` 被生成为模式对象而报 `ConfigInvalid`；不支持细粒度模式的网络权限现在映射为整个工具的动作值。
- 修复 Windows 下从命令行或其他父进程启动 UCLI 后，父进程关闭输出管道会触发 `EPIPE: broken pipe` 并导致 Electron 主进程退出的问题。

## [0.4.4] - 2026-07-27

### Changed

- 工作台项目和会话列表改为按创建时间稳定排序，不再因会话活跃状态变化而跳动。
- 收窄默认高危规则，仅对递归删除、Git 推送和破坏性清理、发布、提权、递归权限修改、下载后执行以及敏感凭据修改等操作要求确认。
- 安全规则模式下，OpenCode 默认允许访问工作目录外；普通删除、`.env` 编辑和常规网络查询不再默认打断用户。

### Fixed

- 修复 OpenCode 无法转换默认 `curl/wget | shell` 正则时退化为所有 Bash 命令都要求确认的问题。
- 修复 Windows 命令规则大小写敏感，以及 `~/.aws/**` 等用户目录规则无法匹配绝对路径的问题。
- 升级时仅替换未修改过的 0.4.3 默认规则，保留用户自定义的安全策略。

## [0.4.3] - 2026-07-26

### Fixed

- 修复离开工作台页面后 xterm 实例被销毁、返回时对话内容消失；工作台现在跨路由保留终端滚动区，并在返回时重新适配窗格尺寸。

## [0.4.2] - 2026-07-26

### Fixed

- 修复 macOS 产物中的 `node-pty` `spawn-helper` 缺少可执行权限，导致新建 Codex、Claude Code 或 OpenCode 会话时报 `posix_spawnp failed`。
- macOS GUI 启动时恢复登录 Shell 的 `PATH`，使打包应用可以发现 `~/.npm-global/bin` 等终端配置中的 CLI 安装目录。

## [0.4.1] - 2026-07-26

### Added

- 新增 macOS DMG/ZIP 打包目标、平台对应的发布产物校验，以及本地构建说明。
- macOS 终端支持 `Command+C`/`Command+V`，并使用系统等宽字体作为首选。

### Changed

- `npm run dist` 改为构建当前操作系统产物，并保留 `dist:win`、`dist:mac` 显式命令。
- macOS 菜单栏托盘图标使用模板图像，以适配浅色和深色外观。

## [0.4.0] - 2026-07-24

### Added

- OpenCode 原生 TUI、历史发现/恢复、会话级权限映射，以及逐会话模型、Token、轮次统计。
- 费用可用性语义：官方导出未提供费用时显示“不可用”，与真实 `$0` 区分。

### Fixed

- OpenCode 安全规则改为官方 `OPENCODE_CONFIG_CONTENT` 覆盖，项目配置不能绕过当前会话的安全档位。
- OpenCode 历史发现兼容 Windows 路径大小写、分隔符、中文目录与异常输出，并限制为最近 30 条。

### Release artifacts

- `UCLI-Setup-0.4.0-x64.exe` — SHA-256: `D393388E7AC867C91AEC029CEEC1F10F31424A52854FC39AC7E39EC7DD708A34`
- `UCLI-Portable-0.4.0-x64.exe` — SHA-256: `A5DF275763C58C4C8E6C5A1DA5CEE084FB75928DD5AA72AF36A078B34B37B983`

### Added

- 新增 OpenCode 原生 TUI 适配器，支持新建、停止、恢复和多窗格交互。
- 设置页支持检测、安装和升级 OpenCode。
- 通过 `opencode session list --format json` 按工作目录发现并导入 OpenCode 历史会话。
- 将 UCLI 三档安全模式和规则映射到 OpenCode 原生权限配置，并继续强制危险命令黑名单。
- 新增 Windows OpenCode PTY 冒烟测试；npm 安装场景会绕过在 ConPTY 中阻塞的 `opencode.cmd`，直接启动真实 EXE。

## [0.3.1] - 2026-07-24

### Added

- 新增日志模块 (`electron/logger.js`)：记录主进程执行路径到 `ucli.log`，方便排查工作台布局持久化等运行时问题。
- 新增 `log:write` IPC 通道：允许渲染进程通过主进程日志模块统一写日志。

### Changed

- 工作台布局持久化流程增加详细日志：跟踪 `saveWorkbench` / `loadWorkbench` 调用、IPC 传输、DB 写入和磁盘刷新全过程。
- `saveWorkbench` / `loadWorkbench` 不再静默吞错误——所有异常记录到日志。

## [0.3.0] - 2026-07-24

### Added

- 支持会话名称编辑：在会话卡片和工作台侧边栏点击名称即可重命名，实时持久化到数据库。
- 工作台布局持久化：分屏数、窗格会话分配在重启后自动恢复，不再需要每次手动设置。

### Changed

- 会话卡片重新设计：精简短 ID，合并目录和时间行，减少视觉分割线，整体更清爽。
- 工作台顶部工具栏简化：按钮更紧凑，筛选器缩小，卡片网格自适应列宽。

## [0.2.1] - 2026-07-23

### Added

- 新增数据库只读诊断脚本和 Windows 发布验收命令。
- 新增数据库损坏恢复提示，显示损坏文件的保留位置和备份恢复结果。
- 全部页面支持将 UCLI 菜单导航收缩为图标栏，工作台会话列表可独立隐藏。
- 工作台支持单个会话窗格全屏，以及保持 2/4 窗格布局的分屏整体全屏；可通过按钮或 `Esc` 退出。
- UCLI 隐藏、最小化或失去焦点时，Claude/Codex 的人工审批、用户输入请求和本轮任务完成都会触发 Windows 原生通知；通知显示会话与操作类型，点击后直接定位到工作台对应会话。

### Fixed

- 修复全零、截断、非 SQLite 或内部页损坏的 `ucli.db` 导致导入会话报 `file is not a database`。
- 数据库只有在完成初始化后才发布给会话 IPC，避免损坏实例泄漏到 `session:create`。
- 损坏主库自动隔离为带时间戳的 `.corrupt-*.bak`，优先恢复上一份有效 `ucli.db.bak`。
- 数据库保存改为同目录临时文件落盘后原子替换，并保留紧邻上一版有效快照。
- 修复 2、4 窗格下无法向上滚动查看历史内容：分屏切换保留原终端缓冲，Codex 使用保留 scrollback 的 inline 模式。
- 修复 Codex 原生 TUI 审批未进入 UCLI 通知链路、Claude 持续输出时完成扫描被反复推迟，以及同一次完成被多个信号重复通知的问题。

### Release artifacts

- `UCLI-Setup-0.2.1-x64.exe`
  - SHA-256: `D401E84BC79799622288AD504A8F6154F1C3DC6A01516715C8A0446F202052DE`
- `UCLI-Portable-0.2.1-x64.exe`
  - SHA-256: `8FE81C4999BD39450E9A4CE4F0DD0060F5178D19A92C95FD249BB221C84B4D6F`

## [0.2.0] - 2026-07-22

### Added

- 新增 1、2、4 窗格多会话工作台和 `Tab`/`Shift+Tab` 会话切换。
- 新增 Windows 托盘、单实例唤回和退出清理。
- 新增 CLI 检测、安装和升级入口。
- 新增 UCLI Logo，用于应用、窗口、托盘和安装包。
- 新增会话、模型、Token、费用和审批统计留痕。

### Changed

- 移除会话改为软删除：从工作台隐藏，但保留原生会话和历史统计。
- Codex 历史 provider 不可用时回退到当前可用 provider。
- 开发版与安装版使用独立数据目录、缓存目录和单实例锁。

### Fixed

- 修复 Claude Code 中文工作目录历史会话无法发现或回放的问题。
- 修复 Codex provider 已失效时无法恢复历史会话的问题。
- 修复 Codex TUI 持续刷新导致原生会话 ID 与统计扫描长期推迟的问题。
- 修复工作台高度持续增长、布局切换后终端不回放等多会话交互问题。
- 修复 Electron preload 模块格式和 Windows Chromium 缓存启动问题。

### Release artifacts

- `UCLI-Setup-0.2.0-x64.exe`
  - SHA-256: `F0E35EA0324AF021DC3097FD84FFCD2BFCBF67A35B8E05EB4EB92734F71F8021`
- `UCLI-Portable-0.2.0-x64.exe`
  - SHA-256: `E1DCC8F286F19DD4B73C8CF1C04ABBB3742895E4519420872A7CD49924C5384D`

### Known limitations

- 当前发布目标为 Windows x64。
- 当前 Windows 产物未进行代码签名，可能触发 SmartScreen 提示。
