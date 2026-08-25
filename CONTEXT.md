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

## 工作总结报告所有权与生命周期

- **总结报告（summary report）**：数据库 `summary_reports` 中的版本化业务记录，是周期、状态、执行器、档案、模型、会话关联和规范 Markdown 的唯一真相源。相同周期重跑创建新版本，不覆盖历史版本。
- **生成 run**：一次报告版本的主进程生命周期，按 `queued → running → completed/failed/interrupted/cancelled` 收口；`turn_started` 是提示词投递确认门槛，终态与恢复均以数据库记录为准。
- **总结工作区（workspace）**：仅属于该 run 的受控派生目录，用于准备输入和临时输出；它不是报告真相源，完成后 Markdown 已原子保存到数据库，工作区清理不得删除报告内容。
- **总结会话（session）**：该 run 唯一绑定的原生 CLI/UCLI 会话。报告版本、工作区和会话一一对应，重跑或并发运行不得复用彼此会话。
- **总结任务元数据**：任务名称和备注属于 `summary_reports`；关联 UCLI session 只同步显示，不成为恢复真相源。
- **删除总结任务**：先收口活动 run，再删除报告、受控 workspace 和独占 UCLI session 投影；CLI 原生 transcript 永远不在该删除范围内。
- **数据库真相（DB truth）**：报告、当前版本、状态恢复和调度去重只读取 `summary_reports`；renderer 只投影该记录，不能以文件存在、计时器或会话显示状态判定完成。
- **渲染器投影（renderer projection）**：预览、Markdown/HTML 导出从选定 `reportId` 的数据库 Markdown 派生；本地主题可确定性渲染，自定义 HTML 必须经过既有安全校验。
- **旧记录导入（legacy import）**：旧 `workLogs` 仅被只读、幂等地导入为非当前的完成报告；原文件不被覆盖、删除或作为运行状态依据。

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
