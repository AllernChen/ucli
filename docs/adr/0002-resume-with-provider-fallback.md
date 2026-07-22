# ADR 0002：历史会话恢复时允许 provider 回退

- 状态：已接受
- 日期：2026-07-22

## 决策

UCLI 导入 Codex 历史会话时读取 `session_meta.model_provider`，但不修改源 transcript：

- 历史 provider 在当前 `~/.codex/config.toml` 中仍可用时，继续使用它。
- 历史 provider 已删除或改名时，恢复到当前配置 provider；未显式配置时使用 Codex 内置 `openai`。
- UCLI 将源 provider 与实际恢复 provider 一并持久化，并在导入界面显示切换提示。
- 传给 Codex 的 provider 必须通过标识符白名单，并使用 `resume -c model_provider=<provider>` 覆盖。

## 原因

Codex transcript 会保存创建会话时的 provider。用户切换供应商或删除旧 provider 后，直接 `resume` 会在 TUI 启动阶段失败。恢复会话应保留对话上下文，同时允许运行时供应商变化。

## 历史可见性

已经添加到 UCLI 的原生会话仍出现在目录扫描结果中，但标记为“已添加”且不可重复选择。移除 UCLI 记录后可以从同一源会话重新添加。
