# UCLI Domain Context

UCLI 是一个 Windows 优先的桌面工作台与本地代理。它不替换 Claude Code、Codex 等 AI CLI 的交互方式，而是在用户与已安装 CLI 之间转发终端输入输出，并提供多会话编排、安全确认和使用留痕。

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
- 当前支持 Claude Code、Codex 与 OpenCode；其他适配器按统一 adapter 接口扩展。
- OpenCode 保持原生 TUI，通过官方 `--session` 恢复源会话，并通过 `OPENCODE_PERMISSION` 映射 UCLI 三档安全模式。
