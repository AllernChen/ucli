# 协议事实参考

本机验证（2026-07-23）。claude 2.1.198、codex-cli 0.142.0、OpenCode 1.17.18、Node 24.9、Windows 10 LTSC 2021。

## Claude Code（`claude`）

### 启动参数
```
claude --output-format stream-json --input-format stream-json --verbose --permission-mode default --settings <临时settings.json>
```
- `stream-json` + `--print` 模式**必须**加 `--verbose`，否则报错 `--output-format=stream-json requires --verbose`。
- `--session-id <uuid>`：可指定会话 ID（存在）。
- `--resume <id>` / `--continue`：恢复会话。
- `--permission-mode` 取值：`acceptEdits` `auto` `bypassPermissions` `default` `dontAsk` `plan`。
- `--settings <file-or-json>`：加载**附加** settings（auth/model 仍从默认加载，不污染用户全局配置）。
- `--allowedTools` / `--disallowedTools`：按调用覆盖。
- `--bare` 会跳过 hooks（不要用）。
- **无** `--permission-prompt-tool` 标志（2.1.198 不存在）→ 用 PreToolUse hook 拦截。

### stream-json 消息形状（每行一个 JSON）
- `system` `subtype:"init"`：含 `session_id` `tools[]` `model` `cwd` `permissionMode`（驼峰）`claude_code_version`。
- `assistant`：`message.content[]` 为 `text` 或 `tool_use`（`{type,id,name,input}`）；`message.usage`（本条消息）。
- `user`：`message.content[]` 为 `tool_result`（`{type,tool_use_id,content,is_error}`）。
- `result` `subtype:"success"`：`usage`（**本轮汇总**，已验证）、`total_cost_usd`、`modelUsage[<model>].costUSD`、`num_turns`、`session_id`、`permission_denials[]`、`stop_reason`、`duration_ms`。
- `stream_event`（`--verbose`）：含 Anthropic 流式事件 `content_block_delta`（`text_delta` / `input_json_delta` / `thinking_delta`）等，用于实时渲染。

### 多轮
同一 stdin/stdout 循环：收到 `result` 后，写一行 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}` 即开启下一轮。进程保持存活。

### 权限拦截（PreToolUse hook）
- hook 在 settings.json `hooks.PreToolUse` 配置，`matcher:"*"`，命令为 `node "<runner>"`。
- hook 从 stdin 收 `{session_id, tool_name, tool_input, cwd, ...}`，stdout 输出：
  ```json
  {"continue":true,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny","permissionDecisionReason":"..."}}
  ```
- headless 下 `ask` 不可靠 → hook 永远返回 allow/deny，弹窗语义在引擎内经 IPC 到 UI 实现。
- 环境变量 `UCLI_HOOK_PORT`、`UCLI_SESSION_ID` 由适配器在 spawn 时注入。
- 待验证：`permissions.allow` 规则是否短路 hook（precedence）。当前设计不在 settings 放 allow 规则，hook 对所有工具调用生效。

### 中断（Windows）
shell:true spawn 的子进程是 cmd.exe，`child.kill()` 只杀 cmd。用 `taskkill /PID <pid> /T /F` 杀整树。会话可通过 `--resume` 恢复。

## Codex（`codex`）

### 两种非交互接口
- `codex exec --json`：一次性 JSONL（单轮，结束即退出）。
- `codex app-server --listen stdio://`：**状态化 JSON-RPC 2.0**（GUI 用这个）。可用 `codex app-server generate-json-schema --out <dir>` 生成协议 schema。

### JSON-RPC 流程
1. `initialize` `{clientInfo:{name,version}}` → 握手。
2. `thread/start` `{cwd, model, sandbox:"workspace-write", approvalPolicy:"untrusted", approvalsReviewer:"user"}` → 响应 `result.thread.id`（**不是**扁平的 `threadId`，已验证）即 `threadId`。
3. 每轮：`turn/start` `{threadId, input:[{type:"text",text}]}`。
4. 中断：`turn/interrupt` `{threadId}`。恢复：`thread/resume` `{threadId}`。

### 关键通知（ServerNotification，无 id）
- `item/agentMessage/delta` `{delta,itemId,threadId,turnId}`：助手文本增量。
- `item/reasoning/summaryTextDelta`：推理摘要增量。
- `item/commandExecution/outputDelta`、`item/fileChange/outputDelta`：输出增量（**base64**）。
- `item/fileChange/patchUpdated`：文件 patch。
- `item/started` / `item/completed`：item 生命周期（含完整 item 对象，tagged union：commandExecution/fileChange/agentMessage/...）。
- `thread/tokenUsage/updated` `{threadId,turnId,tokenUsage:{last,total,modelContextWindow?}}`；`total` 为**累计**；`TokenUsageBreakdown = {inputTokens,outputTokens,cachedInputTokens,reasoningOutputTokens,totalTokens}`。
- `turn/completed` `{turn:{id,status,items[],durationMs,...}}`。

### 审批（ServerRequest，有 id，必须响应）
- `item/commandExecution/requestApproval`：params `{threadId,turnId,itemId,command,cwd,commandActions[],networkApprovalContext?,reason,startedAtMs}`。
- `item/fileChange/requestApproval`：params `{threadId,turnId,itemId,grantRoot,reason,...}`。
- `item/permissions/requestApproval`：params `{threadId,turnId,itemId,cwd,permissions{fileSystem,network},reason}`。
- 响应 `{"jsonrpc":"2.0","id":<id>,"result":{"decision":<...>}}`，decision 取值：
  `accept` / `acceptForSession` / `{acceptWithExecpolicyAmendment:{...}}` / `{applyNetworkPolicyAmendment:{...}}` / `decline`（拒绝，agent 继续）/ `cancel`（拒绝并中断本轮）。
- 引擎 verdict `allow`→`accept`，`deny`→`decline`。

### 配置
`$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。`-c key=value` 覆盖。`-s/--sandbox` 取值 `read-only` `workspace-write` `danger-full-access`。`--skip-git-repo-check` 允许在非 git 目录运行。

## OpenCode（`opencode`）

### 原生 TUI 与恢复

- `opencode`：在当前工作目录启动原生 TUI。
- `--session <ses_...>` / `-s <ses_...>`：恢复指定源会话。
- `--model <provider/model>` / `-m <provider/model>`：按 provider/model 选择模型。
- UCLI 只通过 PTY 转发输入输出，不重做 OpenCode 交互页面。

### 历史发现

`opencode session list --format json --max-count 200` 返回：

```json
[
  {
    "id": "ses_...",
    "title": "会话标题",
    "created": 0,
    "updated": 0,
    "projectId": "...",
    "directory": "F:\\projects\\ucli"
  }
]
```

UCLI 按规范化后的 `directory` 精确匹配工作目录；空输出代表没有历史会话。

### 会话导出与逐会话用量

- `opencode export <sessionID> --sanitize` 输出单个源会话的 JSON；`--sanitize` 会脱敏目录、标题、提示词、工具输入输出和 reasoning，适合保留为测试 fixture。
- 顶层 `info` 给出会话累计 `cost` 与 `tokens`（`input`、`output`、`reasoning`、`cache.read`、`cache.write`），以及当前模型 `model.id` / `model.providerID`。
- 每条 assistant message 的 `info` 也有本消息的 `cost`、`tokens`、`modelID`、`providerID` 与 `finish`。其 `parts[type=step-finish]` 是同一消息用量的重复表示，解析时不能和 `message.info.tokens` 双重累计。
- `finish: "stop"` 表示完成用户可见的一轮；`finish: "tool-calls"` 是工具调用后的中间消息，不单独作为完成轮次。
- 会话累计顶层 `info.tokens` 等于各 assistant message `info.tokens` 的字段和。适配器优先使用顶层累计值；模型拆分和完成轮次从 assistant messages 读取。
- `opencode stats --project <cwd>` 在 `projectID: "global"` 的会话上可以返回 0，因此它只能作为聚合展示，不能用来归属 UCLI 的单个会话。

### 权限

- `OPENCODE_CONFIG_CONTENT`：内联 JSON 配置。UCLI 用其中的 `permission` 字段传入会话级权限，动作是 `allow` / `ask` / `deny`；它在项目配置之后加载，因此不会修改用户文件，也不会被项目配置覆盖。
- OpenCode 使用简单通配符且最后匹配规则生效；UCLI 按 allow → high-risk → deny → 硬黑名单的顺序生成规则。
- OpenCode 不执行正则权限模式。无法无损转换的高风险/拒绝正则会回退为对相应工具逐次确认，避免静默放行。
- UCLI 解析 OpenCode 输出中的 OSC 9 attention 序列；完成通知同时以累计会话导出的 `finish:"stop"` 轮次为准，避免依赖单一终端提示。

### Windows PTY

npm 安装生成的 `opencode.cmd` 在 `cmd.exe` + ConPTY 链路中会无输出且无法干净退出。UCLI 从 shim 所在目录解析 `node_modules/opencode-ai/bin/opencode.exe` 并直接交给 `node-pty`；Scoop/Chocolatey 等直接提供 EXE 的安装方式优先使用 PATH 中的 EXE。

## 统一适配器事件（归一化）
`init` `message`(partial/final) `reasoning` `tool_call` `tool_result` `command_output` `file_diff` `token_usage`(cumulative) `turn_complete` `error` `exit`。适配器把上述原生消息翻译成这套形状，UI 渲染器只认这套。

## DeepSeek Harness 0.11.1 管理协议

### Web-only 界面与旧会话

DeepSeek Harness 的公开项目和 `@deepseek-ai/dsh@0.1.0-rc.6` 没有 CLI TUI。UCLI 0.11.1 因此只创建 `surfacePreference: "web"` 会话，不启动 DSH TUI、PTY、bridge server、Unix socket 或 named pipe。历史 `tui` / `legacy-tui` 配置稳定返回 `DSH_TUI_UNAVAILABLE`；用户确认后只能以相同 cwd 新建一条独立的 DSH Web 会话，原记录和原生数据不做原地转换。

Web 会话不进入通信 Gateway；任何历史 generation 也会在恢复时清除旧 route、queue、decision 和 action token。公开结果固定为 `DSH_WEB_GATEWAY_UNSUPPORTED` 或 `DSH_LEGACY_GATEWAY_UNAVAILABLE`。

### Runtime manager

Runtime manager 管理由 UCLI 拥有的 `<userData>/runtimes/deepseek-harness/current`，并与 DSH_HOME 做 lexical、canonical 双重隔离。运行时固定为 `@deepseek-ai/dsh@0.1.0-rc.6`，包 integrity 必须匹配官方 npm metadata；只接受同一可信 Node 安装旁的 npm 与 pnpm `10.30.3`。renderer 的 install、upgrade、repair、remove 均为零参数固定 IPC，不能提交路径、版本、registry、package 或 command。

安装、升级与修复先写入带不可猜所有权标记的 staging，验证 root、关键目录、manifest、entry、lock、realpath containment 和无 symlink/junction 后才原子提升。已有 current 只在 exact owner 匹配时可替换；失败时恢复原 Runtime，回滚或 backup cleanup 未确认时保留可重试的内部状态。每次破坏性操作先停止并确认所有被拥有的 DSH Web 进程树；卸载只删除 exact owned Runtime，绝不删除 DSH_HOME。

公开状态只包含 `revision`、`supportedVersion`、managed/system 的 bounded 版本与健康状态、`selected`、唯一 `action`、`busy` 和稳定 `errorCode`。不会包含安装路径、DSH_HOME、registry 输出、命令、stdout/stderr 或原始异常；renderer 只接受 revision 更新较新的 canonical state。

### Profile 与 legacy bridge 隔离

profile 是 DSH 原生配置对象，不是 UCLI 会话 surface。UCLI 只用固定 argv 初始化官方 base profile，并在完成后重新验证 exact base/custom/noninteractive 且没有任何 legacy bridge dependency、bundle、patch 或 manifest 残留。

`@ucli/dsh-bridge@0.11.0` 和 `resources/deepseek-harness/ucli-dsh-bridge-0.11.0.tgz` 仅为 legacy bridge 隔离与清理兼容而保留：0.11.1 不加载、不安装、不升级它。用户明确确认“移除旧 bridge”后，主进程使用固定 argv，并只在 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml` 四项的事务边界内修改；失败恢复原 bytes、mode 与原缺失状态，清理失败保留内部重试状态。profile、插件、`node_modules`、凭据、sessions 和 DSH_HOME 均不得被递归删除。

### Web 生命周期

Web 以固定 argv `dsh web --host 127.0.0.1 --port 0` 启动，不注入任何 `UCLI_DSH_BRIDGE_*` 环境。readiness 只接受一条完整的 exact `http://127.0.0.1:<port>` loopback 行；启动流总预算为 16 KiB，超时为 60 秒。iframe 使用固定 CSP、最小 sandbox 和 `no-referrer`；权限、历史和统计只归 DSH 原生界面。

stop、restart、remove 和应用退出先停用界面，再确认同一 owned process tree 完整退出。两个并发 Web 会话必须使用不同动态端口和独立生命周期；root 退出但子进程仍在时保持 stopping，不复用 controller，也不报告假成功。

### DSH Skills 来源与优先级

同名 Skill 以较小 rank 为优先，保留所有来源并标记“生效”或“被来源遮蔽”：

| rank | 物理来源 | 展示 |
| ---: | --- | --- |
| 100 | 项目 `.dsh/skills` | DSH 项目专属 |
| 200 | 项目 `.agents/skills` | Codex / DSH 项目共享 |
| 400 | `$DSH_HOME/skills` | DSH 用户专属 |
| 500 | 用户 `.agents/skills` | Codex / DSH 用户共享 |
| 600 | UCLI 随包内置来源 | 内置（只读） |

项目范围规范化到最近的 Git root；Codex 与 DSH 同时选择项目 `.agents/skills` 时只建立一条安装记录和一个物理副本。DSH direct root、共享 root、flat Markdown 与内置来源都执行 regular-file、大小、portable name、realpath 和 link containment 校验；自定义/内置报告来源只读，不允许 adopt、update 或 remove。

### 稳定错误

Runtime manager 公开：`DSH_RUNTIME_ACTION_INVALID`、`DSH_RUNTIME_BUSY`、`DSH_RUNTIME_PATH_UNSAFE`、`DSH_RUNTIME_PATH_CONFLICT`、`DSH_NPM_UNAVAILABLE`、`DSH_RUNTIME_INSTALL_FAILED`、`DSH_RUNTIME_ROLLBACK_FAILED`、`DSH_RUNTIME_BACKUP_CLEANUP_FAILED`、`DSH_RUNTIME_REMOVE_REJECTED`、`DSH_RUNTIME_REMOVE_FAILED`。

profile 与迁移公开：`DSH_PROFILE_INVALID`、`DSH_PROFILE_NOT_READY`、`DSH_PROFILE_INITIALIZE_FAILED`、`DSH_PROFILE_ROLLBACK_FAILED`、`DSH_BRIDGE_NOT_INSTALLED`、`DSH_BRIDGE_REMOVE_FAILED`、`DSH_BRIDGE_ROLLBACK_FAILED`、`DSH_TUI_UNAVAILABLE`。

Web 公开：`DSH_WEB_START_TIMEOUT`、`DSH_WEB_READY_URL_INVALID`、`DSH_WEB_GATEWAY_UNSUPPORTED`、`DSH_LEGACY_GATEWAY_UNAVAILABLE`。所有错误只返回 allowlist code 和 bounded 状态，不附带路径、stdout/stderr、命令或 provider 数据。

## 通信 Gateway 协议

### 架构与边界

通信 Gateway 是 UCLI 主进程内的平台无关转发层。`GatewayRuntime` 只依赖
`GatewayChannel`、路由存储和下述 UCLI 端口，不导入飞书 SDK 或飞书事件类型。
`FeishuChannel` 是当前唯一的 Channel 实现，通过飞书长连接 WebSocket 接收事件，
通过飞书开放平台 API 发送消息、回复、更新卡片和添加/移除表情回复；不需要公网
Webhook 服务。

```text
Claude / Codex / OpenCode Adapter
          │ 归一化生命周期与决策事件
          ▼
GatewayOrchestratorPort ── GatewayRuntime ── GatewayRouteStore
                                  │
                                  ▼
                           FeishuChannel
                                  │ WebSocket + Open API
                                  ▼
                                飞书
```

Gateway 端口只允许九类操作：列出会话、读取会话、发送普通任务、打断会话、响应
结构化决策、读取决策上下文、读取最新方案快照、读取最新结果快照、订阅 Gateway
事件。Gateway 不能远程创建、恢复、停止或删除 CLI 会话，也不能从飞书切换总开关
或会话转发开关。

### 适配器生命周期与决策契约

适配器必须基于 provider 的明确证据产生以下 Gateway 事件：

- `session_ready`、`session_resumed`、`session_stopped`；
- `turn_started`、`turn_completed`、`turn_failed`、`turn_interrupted`；
- `decision_required`，其中包含稳定的 `decisionId`、决策类型、标题、脱敏摘要、
  可选项和响应模式。

静默、Token 变化、终端提示符或任意一条 assistant 消息都不能被推断为任务完成。
普通飞书文本任务只经 `sendTurn(sessionId, text)` 进入 CLI；权限选择、方案执行/
修订/拒绝等结构化答复只经 `respondDecision(sessionId, decisionId, response)` 返回。
Gateway 不转发终端流、reasoning、tool call、Token 用量或一般 AI CLI 消息。

方案摘要由 UCLI 对 Markdown 做确定性结构提取，优先保留标题、目标和步骤；不调用
LLM。完整方案和完整结果只保存在进程内快照中，用户点击卡片后按块发送。

### 精确路由优先级

入站消息按以下顺序解析，命中第一项即停止：

1. 回复的消息 ID 对应当前连接指纹下的已知消息路由；
2. root message ID 对应已选会话根消息；
3. thread ID 对应已选会话线程；
4. 仅限私聊：当前恰好有一个“已选择且状态为 idle/running”的会话时，允许无引用
   文本回退到该会话。

群聊永远不使用第 4 项；未知 root/thread、普通群消息和存在多个候选会话的私聊
都会被拒绝。系统不会回退到“最近会话”，也不会按会话名称模糊匹配。卡片操作使用
一次性随机 token 绑定精确的会话、决策和动作；操作人还必须命中 Open ID 白名单。

### 持久化与内存数据

持久化数据仅包括：全局期望开关、非秘密配置、系统安全存储加密后的 App Secret、
会话选择、连接指纹、本地确认后自动发现的目标 ID 与首位操作人 ID、根消息/线程 ID、
消息到会话的路由元数据，以及不含
正文的决策审计（类型、结果来源和时间）。诊断只导出掩码目标、状态和行数。

内存数据包括：普通任务正文和队列、待决策正文、完整方案、完整结果、卡片动作
token、飞书事件载荷和 AI 输出。进程退出后这些内容不恢复，也不会为了“补发”而
落库。重连只同步当前根状态、当前待决策和最近完成摘要，不重放普通任务。

### 状态机

Gateway 连接状态：

```text
off ──开启──> connecting ──未绑定──> waiting_binding ──本地确认──> connected
                   │                    │
                   ├──已绑定────────────┴──────────────────────> connected
                   └──失败──> error <───────────────────────────┘
connected ──长连接抖动──> reconnecting ──恢复──> connected
任意开启态 ──关闭──> off
```

`desiredEnabled` 是持久化的用户意图，`phase` 是实际状态。关闭 Gateway 仅停止通信
通道并使远程 token 失效，不停止任何 CLI 进程，也不清除会话选择。

未绑定时，Feishu Channel 仅接收私聊中的 `绑定 UCLI`，或群聊中 `@机器人` 后发送
`绑定 UCLI`。Gateway 从该事件读取用户 Open ID 或群聊 Chat ID，生成不含原始 ID 的
本地绑定候选；只有用户在 UCLI 设置抽屉确认后，目标与发起人才分别保存为转发目标和
首位操作人。候选未确认时不创建会话根消息、不转发会话状态，也不接受普通任务。
解除绑定会清除目标和操作人，但保留 App ID 与加密 App Secret，并重新进入
`waiting_binding`。

每个会话队列状态：

```text
idle ──首个任务──> running
running ──新任务──> waiting（最多 5 个）
running ──完成──> 下一个 waiting 变为 running；无等待则 idle
running ──中断──> paused ──继续──> running
paused ──清空──> idle
```

第六个等待任务返回 `queue_full`。任务正文与队列都不持久化。

### 决策一致性与有效期

Gateway 不设置决策有效期，不存在五分钟自动拒绝。AI CLI/provider 仍在等待时，
决策会一直保持 pending，直到桌面端或飞书端明确响应、provider 自行取消、会话
停止，或 Gateway 进程退出。

桌面端和飞书端采用 first-writer-wins：第一个进入 resolving 并被 provider 接受的
响应成为唯一结果；随后响应返回 `already_resolved` 或 `invalid_action_token`。
胜出后所有远程按钮立即失效，飞书卡片更新为已处理。provider 拒绝响应时，决策可
恢复 pending；审计写入失败不能撤销 provider 已接受的结果。

原生终端中的方案、问题或终端提示输入也先在同一决策注册表中登记为桌面端胜出，
再写入 PTY；因此不会留下仍可点击的飞书卡片。不同会话即使产生相同
`decisionId`，也按 `(sessionId, decisionId)` 隔离。

关闭单个会话的转发时，UCLI 先在本地清空队列、失效 token、停用消息路由并清除
root/thread，再尽力更新远端卡片；重新开启会创建新的会话入口。关闭全局 Gateway
同样先停止接收入站，再尝试远端状态更新和断开，网络错误不能使关闭操作失败开放。
当适配器明确报告已有桌面 turn 在运行时，飞书任务在内存队列中等待该 turn 明确
完成，不能依赖终端输出或 UI 的 running 标签推断占用。
