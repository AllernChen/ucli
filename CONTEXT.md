# UCLI Domain Context

UCLI 是一个支持 macOS 与 Windows 的桌面工作台与本地代理。它不替换 Claude Code、Codex 等 AI CLI 的交互方式，而是在用户与已安装 CLI 之间转发终端输入输出，并提供多会话编排、安全确认和使用留痕。

## 核心术语

- **源会话**：由 Claude Code、Codex 等 CLI 自己保存的原生会话。UCLI 不删除源会话。
- **源 provider**：历史会话创建时记录的模型供应商；恢复 provider 可以在源 provider 已失效时切换。
- **工作台会话**：UCLI 对源会话或新 CLI 进程的管理记录，可被分配到 1、2、4 个终端窗格。
- **关闭窗格**：仅从当前工作台窗格退出；CLI 会话和 UCLI 记录保持不变。
- **停止会话**：终止当前 CLI 进程，但保留 UCLI 会话记录和当前窗格；用户可稍后恢复。
- **移除会话**：停止进程、关闭窗格并从 UCLI 会话列表隐藏；源会话以及已经产生的审计与用量统计保留。
- **安全规则模式**：可信操作自动放行，高风险操作要求用户确认，硬黑名单始终拒绝。

## 当前边界

- 桌面端负责工作台、目录选择、会话管理、规则、设置和统计。
- 终端窗格保持 AI CLI 原生交互体验。
- 当前支持 Claude Code、Codex、OpenCode、U-Code 与 DeepSeek Harness；其他适配器按统一 adapter 接口扩展。
- OpenCode 保持原生 TUI，通过官方 `--session` 恢复源会话，并通过 `OPENCODE_CONFIG_CONTENT` 的会话级 `permission` 映射 UCLI 三档安全模式；该覆盖不修改用户配置文件。
- U-Code 复用 OpenCode 兼容协议，但通过独立的 `ucode` 可执行文件、`UCODE_CONFIG_CONTENT`、`UCODE_CLIENT` 和 U-Code 原生数据目录运行；不得使用 OpenCode 进程读取或恢复 U-Code 会话。
- DeepSeek Harness 固定兼容 `@deepseek-ai/dsh@0.1.0-rc.6`。UCLI 不捆绑或下载 TUI；桥接 TUI 只能来自用户已有的兼容 profile，Web 是可用的本地回退界面。

## DeepSeek Harness 双平面与所有权

- **终端平面**：桥接 TUI 的 PTY 字节原样进入 xterm，负责全屏绘制、键盘输入与 resize；UCLI 不解析 ANSI 来推断会话语义。
- **控制平面**：`@ucli/dsh-bridge@0.11.0` 通过会话独占、认证的 pipe/socket 传递确定 schema 的生命周期、已提交回复、工具、权限、统计、快照与控制 RPC。
- 每个能力只有一个单一所有者。桥接 TUI 的权限、历史、统计与 Gateway 归 UCLI；Web 的这些能力全部归 DSH 原生界面。能力缺失、畸形、桥断开或 native session ID 不一致时均 fail-closed。
- endpoint、token、provider 凭据、prompt、transcript 与 tool payload 不进入数据库、日志、诊断或 renderer IPC。会话持久化只允许 `surfacePreference` 与 TUI `profileName`。
- DSH project Skills 只继承 Codex 的项目 `.agents/skills` 投影，不创建 DSH_HOME 下的副本、独立扫描源或第二条安装记录。
