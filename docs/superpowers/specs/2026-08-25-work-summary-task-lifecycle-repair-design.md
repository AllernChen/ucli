# 工作总结任务生命周期修复设计

- 日期：2026-08-25
- 状态：待用户复核
- 关联决策：`docs/adr/0003-summary-reports-are-the-canonical-work-summary.md`

## 背景

工作总结闭环已经将 `summary_reports` 收敛为报告、版本、生成状态和会话绑定的唯一业务真相源，但真实 Claude 验收和现有界面暴露出五个未闭环问题：

1. Claude 2.1.220 在新的独立工作目录中先显示工作区信任门禁。当前 PTY 投递把文本和回车作为一个写入发送；第一次回车只确认信任，重试又可能只把文本留在输入框而没有提交，最终以 `SUMMARY_TURN_NOT_CONFIRMED` 失败。
2. 交互式启动在材料准备和会话创建完成后才返回。准备期间虽然数据库已有报告，但 renderer 收到的进度事件只有 `reportId`，不会把未知报告加载进列表，因此任务不会立即出现。
3. 左侧列表把缺失的 `runPhase` 回退成“等待生成”。旧的已完成报告允许 `runPhase = null`，所以业务终态被错误展示。
4. 旧任务卡名称规则 `工作总结（周期）YYYY-MM-DD HH:mm` 在报告 UI 重构时丢失，当前自动会话仅命名为 `工作总结（周期）vN`。
5. 报告删除没有同时移除该 run 独占的 UCLI 会话；报告也没有可持久化的任务名称和备注，所以任务管理并未闭环。

诊断使用真实失败报告、数据库状态、workspace manifest 和不调用模型的 Claude PTY 本地命令探针完成。Chromium network service/SSL 日志与报告失败时间线不构成因果关系。

## 目标

- Claude 在首次进入新的总结工作区时能够有界、可确认地提交生成指令。
- 新任务创建后立即出现在左侧列表，并随主进程状态事件实时更新，无需手动刷新。
- 所有报告都按数据库 `status` 显示正确中文状态；`runPhase` 只提供运行阶段细节。
- 恢复旧任务默认命名规则，并允许用户编辑任务名称和备注。
- 删除任务时删除报告记录、受控 workspace 和该报告独占的 UCLI 会话记录；活动任务先安全取消。
- 继续保持 `summary_reports` 为唯一业务真相源，不恢复 renderer 轮询或旧 `summaryTasks` 双真相源。

## 非目标

- 不提供 Markdown 报告正文编辑。
- 不删除 Claude、Codex 等 CLI 自己保存的源 transcript；“删除任务”只移除 UCLI 拥有的报告、workspace 和工作台会话记录。
- 不改变版本创建、当前版本选择、Markdown 安全校验或 HTML 派生规则。
- 不用无限重试或自动重放失败的模型调用。

## 方案选择

采用“报告即任务”的统一模型：任务名称、备注、状态、版本和会话绑定全部由 `summary_reports` 投影。关联的 UCLI session 是运行资源，不是任务元数据真相源。

未采用的方案：

- 继续把任务名称和备注保存在 session：旧报告和 headless 报告没有 session，会重新形成双真相源。
- 只在 renderer 派生名称并增加按钮：无法持久化编辑，也无法可靠联动清理会话。
- 恢复旧 `summaryTasks` store：它依赖 session/taskNote 和文件状态，违反 ADR 0003。

## 数据模型

为 `summary_reports` 增加两个向后兼容字段：

- `title TEXT`：用户可编辑的任务名称。新报告创建时写入默认名称；旧记录为 null 时在仓库投影层按相同规则派生，不要求破坏性回填。
- `task_note TEXT NOT NULL DEFAULT ''`：用户备注，默认空字符串。

默认名称使用报告创建时间和周期标签：

```text
工作总结（每周）2026-08-25 09:50
```

版本号不写入名称，在列表中作为独立 `vN` 标签展示，避免用户重命名后破坏版本语义。

输入约束：

- title 去除首尾空白后长度为 1–120，拒绝换行、NUL 和其他不安全控制字符。
- task note 最长 1000 字符，允许普通换行，拒绝 NUL 和不安全控制字符。
- renderer、日志和 IPC 不接收 workspace 路径、prompt、transcript 或 CLI 原始输出。

## Claude 投递协议

`ClaudeAdapter.sendTurn()` 继续以 transcript 中本轮 user 记录作为唯一送达证据，但把一次盲写改成有界提交状态机：

1. 记录 `sinceMs` 和 prompt fingerprint，发送一次文本与回车，等待最多 8 秒。
2. 如果没有 transcript，只发送一次回车，用于提交可能已经停留在输入框中的文本，再等待最多 8 秒；此阶段不得重打文本，避免重复模型调用。
3. 如果仍未确认，按 Claude 已公开的清空输入快捷键清理输入，重新写入一次文本；给 TUI 一个短且有界的输入处理窗口，再发送独立回车，最后等待最多 8 秒。
4. 任一阶段发现匹配 transcript 后立即停止后续输入，并主动扫描 gateway transcript，及时发出同一 turn 的 `turn_started`。
5. 全部阶段均未确认时返回 false，由现有安全映射持久化为 `SUMMARY_TURN_NOT_CONFIRMED`。

外层共享 delivery deadline 调整为 30 秒，必须严格长于 Claude 最坏约 25 秒的内部有界协议。终止、取消、进程退出和错误事件仍可立即抢先结束，不等待完整 deadline。

该改动只影响 Claude 的交互式 PTY 送达确认；其他 adapter 保持自己的既有投递协议。

## 实时状态投影

交互式 job 在 queued report 注册为 active 后立即发布一次 `preparing` 进度事件，不等待材料准备或 session 创建。

renderer store 收到进度事件时：

- 已知 report：立即更新内存中的 `status`、`runPhase` 和进度文案。
- 未知 report：按 `reportId` 通过现有 `summary:get-report` 拉取安全报告投影并插入列表；同一 report 的并发拉取合并为一个 promise，期间只保留最新进度。
- 终态事件：继续重新读取完整报告，以获得 Markdown、错误码、当前版本和最终元数据。
- 报告已被删除：忽略后续迟到事件，不复活任务。

进度事件仍保持窄契约，不携带 prompt、transcript、绝对路径或完整 Markdown。renderer 不增加轮询器；首次加载和错过事件后的页面重新挂载仍直接读取数据库状态。

## 状态展示

新增单一展示映射，首先读取报告 `status`：

- queued → 等待生成
- running → 正在生成
- awaiting_confirmation → 等待确认
- completed → 已完成
- failed → 生成失败
- cancelled → 已取消
- interrupted → 已中断
- skipped_empty → 无可总结内容

`runPhase` 只细化非终态进度，例如“正在准备材料”“正在启动 AI CLI”“正在投递生成指令”“正在验证报告”。当 `status` 已是终态时，缺失或迟到的 `runPhase` 不得覆盖终态文案。因此历史 `completed + runPhase null` 必须稳定显示“已完成”。

## 任务编辑

增加窄 IPC `summary:update-task`，输入仅包含 `reportId`、`title` 和 `taskNote`，返回更新后的安全报告投影。

主进程在同一数据库事务中：

1. 校验目标报告存在且字段满足边界。
2. 更新 `summary_reports.title/task_note`。
3. 如果报告绑定了仍存在且未被其他报告引用的 UCLI session，同步其工作台显示名称和 task note。

报告字段是规范值。关联 session 缺失时不阻止报告编辑；以后列表、重启恢复和导出均以报告字段为准。编辑不修改报告 Markdown、版本、周期或源 CLI transcript。

## 任务删除

现有 `summary:delete` 扩展为删除完整任务生命周期资源：

1. 读取目标报告并记录其 `sessionId`。
2. 若报告仍在运行，执行现有 cancel 流程并有界等待 run 收口和 adapter 停止；无法安全停止时返回安全错误，保留任务供重试，不做半删除。
3. 在一个数据库事务中删除目标 `summary_reports` 记录、按既有规则提升同周期最高的剩余 completed 版本为当前版本，并移除该报告独占的 UCLI session 记录。若 session 被其他报告引用则保留并记录所有权异常。
4. 事务提交后删除受控 workspace。清理失败只记录白名单 operational event，交由 orphan maintenance 后续回收，不恢复已提交的数据库删除。

删除确认文案区分终态任务和活动任务：活动任务使用“取消并删除”。删除入口同时出现在左侧任务卡和报告详情；列表删除成功后选择提升的当前版本或下一条任务。

这里的“移除 UCLI session”遵循现有会话领域语义：停止进程、关闭/解除工作台绑定并从 UCLI 会话列表隐藏，不删除 CLI 原生会话或 transcript。

## UI 结构

左侧每个报告版本是一张任务卡，展示：

- 可编辑任务名称；
- `vN`、当前版本标记和中文状态；
- 执行 CLI、创建时间和可选备注摘要；
- 查看对话、重试、编辑、删除等与当前状态匹配的操作。

右侧继续使用规范报告详情和 Markdown 预览。编辑使用小型 modal，只编辑名称和备注。删除使用二次确认，不提供正文编辑入口。

## 错误与恢复

- Claude 送达失败继续使用 `SUMMARY_TURN_NOT_CONFIRMED` 和安全中文文案。
- 编辑输入非法使用统一的 `INVALID_SUMMARY_IPC`，不得把原始输入写入日志。
- 活动任务无法取消或停止时使用白名单删除失败码，任务保持可见。
- 数据库事务失败时不删除 workspace 或 session 投影。
- workspace 删除失败由 maintenance 重试，并只记录 reportId、phase 和安全 code。
- 应用重启时继续把未完成 run 标为 interrupted，不自动重放模型调用。

## 测试策略

按垂直切片执行 RED→GREEN：

1. Claude adapter 公共 `sendTurn()`：首次输入无 transcript、回车补交仍无 transcript、最终重打后确认；确认后不再写入；进程终止时立即失败；主动 gateway 扫描只产生一个 `turn_started`。
2. interactive runtime/job：30 秒外层窗口容纳 Claude 最坏协议，其他终止事件仍立即收口；queued/preparing 在耗时准备前发布。
3. persistence/repository：迁移幂等；默认名称；编辑字段验证和事务同步；旧 title null 可派生；完成报告允许 runPhase null。
4. renderer store：未知 report 的首次进度会自动加载并插入；并发事件合并；终态刷新；删除后的迟到事件不复活。
5. mounted UI：旧完成报告显示“已完成”；任务名称、备注编辑可持久化；列表和详情均可删除；活动任务显示“取消并删除”。
6. 删除集成：报告、当前版本提升、独占 UCLI session 和 workspace 清理形成闭环，CLI 原生 transcript 不在删除范围。
7. 全量 `npm test`、生产构建、release verifier 和 `git diff --check`。

## 人工验收

在自动化门禁通过后执行：

1. 使用 Claude 在一个新的独立总结 workspace 创建下一版本；确认任务立即以“正在准备”出现，无需刷新。
2. 确认 Claude 首次工作区信任后生成指令进入 transcript，报告最终完成且状态实时变为“已完成”。
3. 确认历史日总结 `completed + runPhase null` 显示“已完成”。
4. 确认默认名称符合旧规则，重命名和备注在应用重启后仍存在。
5. 删除一个终态任务，确认报告、workspace 和 UCLI 会话入口消失，上一完成版本按规则成为当前版本。
6. 创建一个活动任务并执行“取消并删除”，确认进程先停止、任务不复活、没有删除 CLI 原生 transcript。
7. 对 Claude、Codex、OpenCode、U-Code 分别执行既有工作总结验收；安装包验收仍作为发布闭环门槛。

## 兼容与回滚

- 数据库字段为增量迁移，旧程序会忽略它们；旧报告 title 为 null 时仍能派生名称。
- 如果 Claude 新协议产生回归，可回滚 adapter 状态机和 30 秒 deadline，不需要回滚数据库字段。
- 编辑能力可独立隐藏而不影响报告读取。
- 删除是用户确认后的不可逆 UCLI 操作；CLI 原生 transcript 保留，报告删除语义与现有界面保持一致。
