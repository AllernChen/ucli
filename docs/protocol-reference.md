# 协议事实参考

本机验证（2026-07-02）。claude 2.1.198、codex-cli 0.142.0、Node 24.9、Windows 10 LTSC 2021。

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

## 统一适配器事件（归一化）
`init` `message`(partial/final) `reasoning` `tool_call` `tool_result` `command_output` `file_diff` `token_usage`(cumulative) `turn_complete` `error` `exit`。适配器把上述原生消息翻译成这套形状，UI 渲染器只认这套。
