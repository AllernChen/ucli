# ADR 0003：工作总结报告是唯一业务真相源

- 状态：已接受
- 日期：2026-08-24

## 决策

`summary_reports` 是工作总结报告、版本、当前版本、生成状态、调度去重和重启恢复的唯一业务真相源。`workLogs` 只作为旧数据的只读兼容导入源；导入必须幂等，不得删除或覆盖原文件，也不得把旧绝对路径写入数据库。

每次生成都创建独立的 report/version、workspace、UCLI `sessionId` 和原生 CLI 会话。不同 run 不复用会话或工作目录，其状态和产物不能互相覆盖。

Markdown 是唯一规范产物。报告完成前，主进程必须验证 workspace 中的 Markdown 并原子提交到数据库；HTML、打印和文件导出全部从已入库 Markdown 在本地派生，不再调用 CLI 做格式转换。

主进程拥有 `queued → running → completed/failed/interrupted/cancelled` 生命周期和交互式 run phase 状态机。renderer 只提交参数并渲染数据库报告及主进程进度，不持有生成计时器、文件轮询器、CLI 启停或完成判定。

Gateway 的 `turn_started` 是生成指令已送达的确认事件；`turn_completed`、`turn_failed` 和 `turn_interrupted` 驱动后续验证或终态转换。无法确认送达或超时时必须 fail-closed，并且只向数据库、日志和 renderer 暴露白名单错误码及安全文案。

应用启动时，未完成的 run 统一转为 `interrupted`，但不自动重放。用户可以显式重试并创建新版本；禁止自动重放，以避免重复 AI 调用和不可预期的成本。

## 被取代的路径

以下旧路径不再参与新工作总结的运行或完成判定：

- 同周期生成复用共享会话或共享工作目录；
- 以 `workLogs` 文件、文件名或 mtime 作为报告状态和完成依据；
- renderer 轮询文件、维护任务状态机或控制 CLI 生命周期；
- 调用 AI CLI 将 Markdown 转换为 HTML；
- 重启后自动恢复或重放未完成的 AI 生成。

旧数据库报告继续保留，旧 `workLogs` 文件只通过兼容导入进入规范报告仓库。

## 原因

共享会话、文件状态和 renderer 内存会形成相互冲突的真相源，导致版本覆盖、永久运行、历史错绑和重复提醒。把持久状态与规范 Markdown 收敛到数据库，并把每次生成隔离为独立 run，可使生成、版本、预览、导出、提醒、历史和失败恢复都由同一套可验证事实驱动。

## 实现约束

- execution mode、run phase、终态和安全错误码使用封闭契约；未知 phase 必须拒绝。
- prompt、transcript、工具 payload、凭据和绝对 workspace 路径不得进入数据库、日志或 renderer IPC。
- completed 只能来自校验通过且已原子入库的 Markdown；workspace 只是受控的临时输入/输出边界。
- legacy import 不设为当前版本，不改变原文件，并以稳定导入键保证幂等。
