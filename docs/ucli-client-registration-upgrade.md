# UCLI 0.12.0 服务端接入升级实施方案

> **供实施代理使用：** 按任务逐项执行，每项先写失败测试，再实现最小闭环并独立验证。

**目标：** 在不影响 UCLI 独立模式的前提下，完成设备注册链接、凭证续期、服务端模型和服务端 Skills 的完整接入。

**架构：** Electron 主进程新增独立 `serverConnection` 子系统，统一管理注册链接、服务端凭证、状态机、本机模型代理和 Skills 目录。渲染进程只接收脱敏 DTO。

**技术栈：** Electron、Node.js、Vue 3、Pinia、sql.js、Electron `safeStorage`、Node Test Runner。

**协议：** `docs/ucli-client-protocol.md`

## 全局约束

- 客户端目标版本固定为 `0.12.0`。
- 服务端正式发布基线为 UCLI Server `0.3.1`，提交 `1cd51df59d06ae0e8ab9c60cb6fea9e0d9f6a0c5`，生产运行时镜像为 `sha256:daedf2b364c94aa6a1b1cfc6ed6f91350f98ac248f0a79767e87271c25e28c9b`。
- 当前控制面文档域为 `https://ucli.example.invalid`，模型网关基址为 `https://ucli.example.invalid/gateway`。
- 只实现 `#link=`，拒绝旧 `#token=`、设备码和 query 传密。
- 只维护一个当前服务端连接；服务端失败不得影响本地能力。
- link secret、access token 和本机代理 bearer 不得持久化。
- 服务端模型不得自动成为默认模型，失效时不得静默回退。
- 服务端 Skill 不自动安装或更新，断开后不删除已安装副本。
- 模型协议只接受 `openai_responses`、`openai_chat` 和 `anthropic_messages`；Bootstrap 每个模型的 `protocols` 必填且非空，模型选择不得依赖 `models[0]`、模型名称、供应商或目录顺序。

---

## 1. 交付基线

| 项目 | 值 |
| --- | --- |
| 客户端实施仓库 | `F:\projects\ucli` |
| 客户端当前版本 | `0.11.6` |
| 目标版本 | `0.12.0` |
| 服务端版本 | UCLI Server `0.3.1` |
| 服务端合并提交 | `1cd51df59d06ae0e8ab9c60cb6fea9e0d9f6a0c5` |
| 服务端生产运行时镜像 | `sha256:daedf2b364c94aa6a1b1cfc6ed6f91350f98ac248f0a79767e87271c25e28c9b` |
| 部署验证日期 | 2026-08-30 |
| 网络边界 | 公司可信内网，当前明确使用 HTTP |

服务端 Device Grant Link、Bootstrap、Gateway 和 Skills 已部署。客户端开发可以使用 mock fixtures，但最终结论必须来自目标内网真实联调。

## 2. 产品范围

UCLI 未连接服务端时，本地模型、已安装本地 Skills、本地数据和本地会话全部可用。注册后才增加服务端模型、Skills 目录和后续服务端能力。

客户端不实现用户注册、密码登录、管理员授权创建、URL 重新生成或设备管理。

一个服务端连接只对应当前设备的一项授权。新连接只有在 Redeem 成功且 refresh token 安全落盘后，才能替换旧连接。

解析失败、用户取消、Preview/Redeem 失败、网络失败或安全存储失败都必须保留旧连接。

## 3. 当前客户端基线

| 现有能力 | 当前实现 | 0.12.0 接入点 |
| --- | --- | --- |
| 主进程生命周期 | `electron/main.js`、`primaryInstanceGate.js` | 冷启动 argv、第二实例 argv、macOS `open-url` |
| 数据库 | `electron/persistence/db.js` 的 sql.js、事务和原子 flush | 新增服务端表；关键操作立即 flush |
| 安全存储 | `ProfileSecretStore` 使用 Electron `safeStorage` | 复用加密模式，单独保存 refresh token |
| AI CLI 档案 | `electron/aiCliProfiles/` | 聚合只读服务端模型投影 |
| Codex 文件 | 只识别 `ucli-<32hex>.config.toml` | 增加独立 `ucli-server-*` 所有权规则 |
| Skills | `electron/skills/` 已有 ZIP 和原子安装校验 | 增加服务端目录与下载适配器 |
| 设置界面 | `Settings.vue`、Pinia、preload IPC | 新增连接卡片和注册确认流程 |
| 安装包 | NSIS、portable、DMG/ZIP | 安装版协议注册；portable 不注册 |

当前第二实例回调只激活窗口，不传递 argv。必须先扩展 `runPrimaryInstanceGate`，否则运行中的 UCLI 会丢失 `ucli://` 链接。

当前数据库事务只修改内存 SQLite。installationId、连接切换和 refresh 轮换必须在事务后立即检查 `db.flush()`，不能依赖 5 秒延迟写入。

## 4. 模块架构

在主进程新增 `electron/serverConnection/`：

```text
浏览器 / 设置页链接
        │
        ▼
Deep Link + Link Parser
        │
        ▼
Registration Attempt ── Preview / Redeem
        │
        ▼
Connection Manager ───── Credential Store
        │
        ├──────────────► Model Projection
        ├──────────────► Skills Catalog Adapter
        ├──────────────► Expiry Reminder
        └──────────────► Local Gateway Proxy ──► CLI
```

| 模块 | 文件 | 单一职责 |
| --- | --- | --- |
| 链接接收 | `deepLink.js` | 冷启动、第二实例和 macOS URL 事件 |
| 链接解析 | `linkParser.js` | 校验两类 URL，输出 origin 与不透明 link secret |
| 注册尝试 | `registrationAttempts.js` | 管理 attemptId、秘密、阶段和超时 |
| 协议客户端 | `deviceGrantClient.js` | Preview、Redeem、Refresh、Bootstrap |
| 凭证存储 | `credentialStore.js` | safeStorage 加解密、候选连接和立即 flush |
| 连接管理 | `connectionManager.js` | 当前连接、刷新、恢复、断开和状态事件 |
| 本机代理 | `localGatewayProxy.js` | 回环认证、路径白名单和流式转发 |
| 模型投影 | `modelProjection.js` | Bootstrap 模型到只读 CLI 档案 |
| Skills 适配 | `skillsCatalogAdapter.js` | 目录、撤销、下载和现有安装器衔接 |
| 提醒 | `expiryReminder.js` | 服务端时钟、阈值状态和系统通知 |
| IPC | `ipc.js` | 请求校验和脱敏响应 |

## 5. 链接入口与解析

三个入口汇合到同一流程：

1. 浏览器点击“连接 UCLI”，系统唤起 `ucli://`。
2. 设置页粘贴完整浏览器 URL。
3. 设置页粘贴完整 `ucli://` URL。

浏览器 URL：

```text
https://ucli.example.invalid/connect#link=<secret>
```

自定义协议 URL：

```text
ucli://connect?server=https%3A%2F%2Fucli.example.invalid#link=<secret>
```

`parseConnectionInput(input)` 输出 `{ serverOrigin, linkSecret }`。link secret 保持原始大小写和字节语义，不做二次解码或派生。

解析器拒绝旧 token fragment、query 传密、重复 link、非 HTTP(S)、用户信息、路径注入和额外 fragment 参数。

HTTP 只因用户显式打开可信内网链接而接受。客户端不得跨源重定向，也不得把该信任扩展到其他自动发现地址。

## 6. 注册状态机

### 6.1 注册事务状态

| 状态 | 进入条件 | 允许动作 |
| --- | --- | --- |
| `STANDALONE` | 从未连接或主动断开 | 本地能力；开始注册 |
| `CONNECTED` | 当前连接可用 | 本地和服务端能力；连接新服务端 |
| `PREVIEWING` | 已解析新链接 | 请求 Preview；旧连接不变 |
| `AWAITING_CONFIRMATION` | 两个状态均为 AVAILABLE | 展示两类状态和有效期 |
| `REDEEMING` | 用户确认 | 单飞 Redeem |
| `REDEEM_RECOVERY` | Redeem 结果不明或落盘失败 | 10 分钟内直接重试 Redeem |
| `COMMITTING` | Redeem 成功 | 安全保存候选连接并原子切换 |

### 6.2 Preview

UCLI 被唤起后必须重新 Preview。浏览器 Preview 不能替代客户端 Preview。

确认页展示服务端、组织、成员、`link.status/expiresAt`、`authorization.status/expiresAt` 和 `serverTime`。

只有 link 与 authorization 都为 `AVAILABLE` 才能首次确认。`CONSUMED` 不允许开启新的注册事务。

同 installationId 的 10 分钟恢复由仍存活的原 attempt 直接重试 Redeem，不重新通过 Preview 判断。

### 6.3 Redeem 与切换顺序

1. 从独立安装记录读取已落盘 installationId。
2. 用 attempt 中的 link secret 调用 Redeem；同一 attempt 禁止并发。
3. 加密新 refresh token，并写入 `candidate` 连接。
4. 立即 flush，确认候选凭证已经安全落盘。
5. 在事务中把 candidate 提升为 current，并移除旧 current。
6. 撤销旧连接的运行时 access token 和本机代理 bearer。
7. 清除 attempt、link secret 和所有导航副本。
8. 使用新 access token 调用 Bootstrap。

Bootstrap 失败不回滚已经安全提交的新连接。连接进入网络或授权降级状态，保留 refresh token，以便恢复后重新 Bootstrap。

若 Redeem 成功但 candidate 落盘失败，旧连接继续作为 current。attempt 在 10 分钟窗口内保留相同 installationId 与 link secret，供用户重试 Redeem。

## 7. 本机数据模型

### 7.1 server_installation

单例记录保存 installationId、默认设备名和创建时间。断开、注册失败、替换连接和普通升级都不删除它。

installationId 在首次 Redeem 前通过数据库事务写入并立即 flush。失败时不得继续注册。

### 7.2 server_connections

允许一条 `current` 和注册期间的一条 `candidate`，但只有 current 能启用服务端能力。

记录包括 origin、refresh token 密文、账号/组织摘要、授权时间、服务器时钟偏移、同步时间、connection revision、降级原因和提醒标记。

refresh token 密文不放入 `ai_cli_profile_secrets`，避免 ProfileCenter 的密钥操作影响服务端连接。

### 7.3 规范化服务档案与模型目录

`server_service_profiles` 每个规范化 HTTP(S) origin 与 organization ID 只保存一行。稳定 `profile_id` 只由该 origin 与组织 ID 派生，因而不包含 model 或 adapter；记录组织展示名、connection revision 和档案可用状态。

`server_service_models` 以 `(service_profile_id, model_id)` 为键保存嵌套子模型：展示名、正安全整数 context size、服务端声明的非空公开协议数组、模型可用状态、目录顺序，以及仅属于该模型的 Codex 文件摘要。协议不在本地补全或猜测；`openai_chat` 模型保持目录可见，但不创建托管启动项。

`ai_cli_profile_bindings` 增加可空 `model_id`：服务档案绑定必须保存精确的 `profile_id + model_id`，本地档案绑定继续保存 `model_id = NULL`。会话同时保留其模型和服务档案选择；启动时以精确 `(serviceProfileId, modelId, adapterId)` 验证，而非从档案、模型名称、供应商或目录顺序补全。

升级在单个事务中检测旧 `server_model_profiles` 表，按规范化 origin/组织归并档案，并把旧 Codex/Claude 行分别映射为 `openai_responses`/`anthropic_messages` 后合并同一模型的已声明协议。只有旧档案、adapter 和历史 session model 形成精确且唯一的来源关系时，才回填 session 的统一服务档案选择；不能证明来源的历史会话原样保留并在后续启动时 fail closed。绑定只有唯一映射时才迁移为 `profile_id + model_id`，歧义或畸形的服务端绑定会删除而不是猜测。迁移可重入，全部写入成功后才移除旧表。

Codex 文件按服务档案与模型分别派生为自有 `ucli-server-*` artifact；不同模型不会共享文件或摘要。服务端投影不保存本机代理 endpoint 或 bearer。代理端口和会话凭证在启动 CLI 前生成。

### 7.4 server_skill_versions 与 server_skill_packages

`server_skill_versions` 缓存目录版本、slug、展示信息、字节数、SHA-256、发布时间、下载地址的脱敏结构和撤销状态。

`server_skill_packages` 关联已安装 `skill_packages` 与服务端版本，用于重连后恢复来源、检查更新和传播撤销风险。

不得持久化下载 Authorization、临时文件路径或带秘密参数的 URL。

## 8. 凭证与刷新生命周期

注册前确认 `safeStorage.isEncryptionAvailable()`。不可用时阻止 Redeem，不得明文保存。

access token 只存在内存，并在到期前 60 秒 Refresh。refresh token 每次成功 Refresh 后轮换。

收到新 refresh token 后，在同一数据库事务替换密文和授权元数据，并立即 flush。成功前暂停新的 Refresh。

若 flush 暂时失败，进入内部 `PERSISTENCE_PENDING`，在受控内存保留新 token 并重试。不得把旧 token 恢复为当前凭证。

若进程在新 token 落盘前终止，下一次启动可能收到 `invalid_grant`。客户端按协议清除失效连接并要求新授权，不伪造恢复成功。

应用启动、恢复前台、系统休眠恢复和用户点击重试时可以立即恢复。网络失败按 30 秒、1 分钟、2 分钟、5 分钟、15 分钟退避并加入抖动。

## 9. 连接展示状态

| 状态 | 含义 |
| --- | --- |
| `disconnected` | 未连接或凭证已清除 |
| `connecting` | 正在注册、刷新或 Bootstrap |
| `connected` | 授权有效且最近同步成功 |
| `unreachable` | 网络、HTTP 5xx 或本地持久化暂不可用 |
| `expiring` | 授权有效，进入 7 天提醒窗口 |
| `disabled` | 授权已禁用 |
| `expired` | 授权已到期 |
| `deleted` | 授权已删除 |
| `account inactive` | 账号或成员关系不可用 |
| `org inactive` | 组织不可用 |

`PERSISTENCE_PENDING` 对 UI 映射为 `unreachable`，原因显示“凭证尚未安全保存”，不能误报为网络问题。

`grant_disabled`、`grant_expired`、`account_inactive` 和 `organization_inactive` 保留连接元数据并低频探测恢复。

`invalid_grant`、`grant_deleted` 和已连接设备的 `invalid_device` 清除服务端凭证并转为 `disconnected`，但保留 installationId。

## 10. 稳定错误映射

客户端按响应 `code` 分支，不依赖 `message`。Preview/Redeem 业务错误为 HTTP 400；Refresh、Bootstrap、Skills 和网关生命周期错误为 HTTP 401。

| 错误码 | 客户端动作 |
| --- | --- |
| `invalid_link` | 保留 current，提示获取新授权链接 |
| `link_expired` | URL 已到期，不触发授权到期提醒 |
| `link_revoked` | URL 已撤销，提示获取新 URL |
| `link_consumed` | URL 已使用或恢复窗口结束 |
| `invalid_device` | 注册输入时修正；已连接时清除服务端凭证 |
| `invalid_grant` | 清除无效服务端连接，要求新授权 |
| `grant_disabled` | 停用服务端能力，保留元数据等待启用 |
| `grant_expired` | 停用服务端能力，显示授权到期时间 |
| `grant_deleted` | 清除服务端凭证，要求新授权 |
| `account_inactive` | 停用服务端能力，提示账号或成员关系不可用 |
| `organization_inactive` | 停用服务端能力，提示组织不可用 |

`grant_bound` 只属于管理端 URL 生成。公开接口使用 `link_consumed`；客户端不兼容旧绑定错误别名。

网络失败、超时和 HTTP 5xx 统一为可恢复的服务端不可达，不清除凭证。

模型路由失败只有在 HTTP `503`、`Cache-Control: no-store`、`X-UCLI-Request-ID`、JSON 结构、稳定 `code` 和 `retryable` 全部匹配时才可作为稳定诊断接受。允许的组合仅为 `model_protocol_unavailable` / 不可重试、`model_channel_unavailable` / 可重试、`upstream_unavailable` / 可重试。其余组合 fail closed；三类稳定 503 都不是授权失败，不清除凭证、不改变授权状态，并保留本地模型、Skills、会话和数据。

连接成功与模型/Skills 目录同步错误分区处理。Bootstrap、凭证和授权状态只由连接生命周期错误改变；模型目录投影或 Skills 同步失败只撤销其各自在线能力并保留当前连接和本地能力。模型缺失、移除、不可用或 adapter 协议不兼容同样只使该精确服务选择不可启动，绝不替换为其他模型或本地默认项。

## 11. 本机模型代理

服务端 access token 默认 900 秒过期，而 CLI 子进程环境不能随 Refresh 安全轮换，因此不能把服务端 token 直接写入模型档案。

代理只绑定 `127.0.0.1` 随机端口。每个 CLI 会话获得高熵 bearer，绑定 session ID、connection revision 和生命周期。

本机允许路径：

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /anthropic/v1/messages`

请求必须由显式协议选择固定路径：`openai_responses` 到 `/v1/responses`，`openai_chat` 到 `/v1/chat/completions`，`anthropic_messages` 到 `/anthropic/v1/messages`。选择模型前，Bootstrap 与 Gateway 模型目录中同一模型的协议集合必须一致且都包含所选协议；不得从模型身份或目录顺序推断。

向上游拼接时必须保留 Bootstrap `gateway.baseUrl` 的 `/gateway` pathname。不能使用会把基址路径替换掉的绝对 URL 构造。

代理移除客户端 Authorization、Cookie 和逐跳头，统一向服务端注入 Bearer access token。服务端的 `x-api-key` 兼容入口不作为 UCLI 首选路径。

响应流式透传。POST 不自动重放；GET 在强制 Refresh 后最多重试一次。

断开、连接替换、授权失效、会话结束或退出时立即撤销对应本机 bearer。

## 12. 服务端模型投影

`profileService` 聚合用户档案和 `sourceKind: server` 的只读服务档案。每个规范化 origin/组织只展示一个服务档案，模型作为嵌套目录公开；服务端投影拒绝创建、编辑、密钥、修复、回滚和删除操作。

服务档案 DTO 包含组织、状态、支持的 adapter 和模型的安全字段。模型只保留 ID、展示名、context size、服务端声明协议和可用状态；不会向 renderer 公开 connection revision、artifact hash、凭证、headers 或原生配置内容。ProfileCenter 与会话选择器显示“组织提供”。

Codex 仅可选择声明 `openai_responses` 的模型，Claude 仅可选择声明 `anthropic_messages` 的模型。仅 `openai_chat` 的模型仍可见，但在 0.12.0 不可由两个托管 adapter 启动。一个模型可声明两种托管协议并被对应 adapter 选择；模型/协议兼容性从显式声明校验，不从名称、供应商或目录顺序推断。

用户档案继续从 `ProfileSecretStore` 获取密钥；服务端投影由 connection manager 在启动前签发本机会话 bearer。Codex 启动前为精确的服务档案/模型对创建或更新隔离的 `ucli-server-*` 文件，并显式传递模型；Claude 复用现有 Bearer 环境适配器并显式传递模型。

服务档案可以成为用户明确设置的应用、项目或会话选择，但这些位置都持久化精确 `(serviceProfileId, modelId)`。缺少、移除、不可用或协议不兼容的模型不能启动，且不会静默回退到系统模型、其他模型或本地档案。新建会话、导入/恢复历史会话、运行中档案切换和交互式总结使用同一 runtime resolver。

## 13. 服务端 Skills

服务端 Skills 作为 `SkillsCenter` 新来源展示，并标识组织、版本、URL 状态之外的授权可用状态和撤销状态。

目录同步只下载元数据。安装或更新必须由用户明确触发。

下载到 `userData/server-skills/.staging`。校验通过后，以本地 ZIP 形式进入现有 `sourceLoader` 和 `skillsService`，不另建解压器。

下载校验顺序：

1. catalog 和 downloadUrl 与 API origin 同源。
2. 路径严格匹配 `/api/v1/skills/:versionId/download`。
3. 禁止跨源重定向，限制 120 秒超时和临时文件配额。
4. 校验 `sizeBytes` 与实际下载字节数。
5. 校验目录 SHA-256、`x-ucli-sha256` 和实际 ZIP 摘要。
6. 复用现有文件数、单文件、解压总量、路径穿越和 manifest 校验。
7. 复用既有冲突、漂移、投影和原子安装流程。

安装记录保存 `sourceType: server` 和稳定版本映射，不保存 staging 路径。更新重新从 catalog 获取 downloadUrl。

`REVOKED` 禁止新安装和更新，已安装副本显示风险但不删除。`DEPRECATED` 可继续使用并显示迁移提示。

断开只移除在线目录和下载入口，不删除已安装 Skill。重连后按 origin、组织、slug 和 version 恢复关联。

## 14. 双有效期与提醒

URL 有效期只决定当前注册链接是否可用，不创建长期提醒。

设备授权有效期决定服务端能力，并在到期前 7 天、3 天、1 天和当天提醒。

每次 Preview、Redeem、Refresh 和 Bootstrap 更新服务器时间快照。授权提醒使用服务端时钟偏移，不直接信任本机墙钟。

应用恢复时跨过多个阈值，只通知最接近到期的一次，并将更宽阈值标为已跨过。

授权延期后重建提醒；变为永久授权后清空提醒。离线时显示最后同步时间，不声称状态实时。

## 15. 深链与安装包

扩展 `primaryInstanceGate.js`，让第二实例处理器接收 argv 和 workingDirectory。`main.js` 在窗口创建前暂存链接，并在服务初始化后消费。

macOS 在 `ready` 前注册 `open-url`。所有平台覆盖冷启动和运行中唤起。

深链先在主进程解析并创建 attempt，再打开确认页。完整 URL 和 fragment 不得进入日志或 renderer route。

Windows NSIS 按当前用户注册 `ucli://`。升级更新 executable 路径；卸载只在注册值仍指向当前安装目录时删除。

portable 不写协议注册表，也不能覆盖安装版协议归属。设置页粘贴链接是 portable 的标准入口。

macOS 在应用元数据声明 URL scheme。Linux 是否注册由发行包决定，但粘贴入口必须可用。

## 16. IPC 与界面

preload 新增独立 `serverConnection` 能力组：

- 提交待解析链接。
- 获取脱敏 Preview。
- 确认、恢复或取消 attemptId。
- 读取当前连接摘要与状态。
- 用户触发恢复、Bootstrap 同步或断开。
- 查询服务端模型和 Skills 的脱敏展示信息。

IPC 错误只包含稳定错误码、用户信息和可重试标记，不包含 URL、token、header、响应正文或底层堆栈。

设置页新增连接卡片、粘贴入口、重新同步、断开和授权时间。确认组件展示 URL 与授权的两套状态和有效期。

连接状态通过专用事件推送到 Pinia store。ProfileCenter、会话选择器和 SkillsCenter 不自行推导授权状态。

## 17. 文件变更清单

### 17.1 新增

- `electron/serverConnection/contracts.js`
- `electron/serverConnection/linkParser.js`
- `electron/serverConnection/registrationAttempts.js`
- `electron/serverConnection/deviceGrantClient.js`
- `electron/serverConnection/credentialStore.js`
- `electron/serverConnection/connectionManager.js`
- `electron/serverConnection/localGatewayProxy.js`
- `electron/serverConnection/modelProjection.js`
- `electron/serverConnection/skillsCatalogAdapter.js`
- `electron/serverConnection/expiryReminder.js`
- `electron/serverConnection/ipc.js`
- `src/stores/serverConnection.js`
- `src/components/settings/ServerConnectionPanel.vue`
- `src/components/serverConnection/RegistrationConfirmDialog.vue`

### 17.2 修改

| 文件 | 变更 |
| --- | --- |
| `electron/persistence/db.js` | 新表、candidate/current 切换和立即 flush |
| `electron/main.js` | 深链事件、服务初始化、窗口导航和退出清理 |
| `electron/primaryInstanceGate.js` | 转发第二实例 argv |
| `electron/orchestrator.js` | 注入连接、模型 runtime 和 Skills 适配器 |
| `electron/preload.js`、`src/ipc.js` | 窄 IPC 与状态事件 |
| `electron/aiCliProfiles/contracts.js` | 只读来源与服务端状态 DTO |
| `electron/aiCliProfiles/profileService.js` | 聚合服务端投影并拒绝写操作 |
| `electron/aiCliProfiles/profileResolver.js` | 服务端不可用时 fail closed |
| `electron/aiCliProfiles/codexProfileFile.js` | `ucli-server-*` 命名和所有权 |
| `electron/skills/sourceLoader.js` | 接收已校验 staging ZIP，不放宽限制 |
| `electron/skills/service.js` | `sourceType: server` 与稳定版本映射 |
| `src/views/Settings.vue` | 服务端连接设置区 |
| `src/views/ProfileCenter.vue` | 组织来源、只读和不可用状态 |
| `src/views/SkillsCenter.vue` | 服务端目录、安装、更新和撤销提示 |
| `src/components/NewSessionDialog.vue` | 服务端模型标识和不可用原因 |
| `electron-builder.yml`、`build/installer.nsh` | URL scheme、升级和条件卸载 |

## 18. 实施任务

### Task 1：协议类型、数据库和安全存储

**测试：** `test/server-connection-contracts.test.mjs`、`test/server-connection-db.test.mjs`、`test/server-credential-store.test.mjs`

**产出接口：** `parseConnectionInput`、连接 DTO、installation/current/candidate 数据库操作、`ServerCredentialStore`。

- [ ] 写链接 DTO、状态枚举、错误码和脱敏失败测试。
- [ ] 运行目标测试，确认因模块缺失而失败。
- [ ] 实现 contracts、数据库迁移和凭证存储最小闭环。
- [ ] 验证断开保留 installationId、candidate 未提升前不对外可用。
- [ ] 运行 `node --test test/server-connection-contracts.test.mjs test/server-connection-db.test.mjs test/server-credential-store.test.mjs`。

### Task 2：深链、Preview 和 Redeem

**测试：** `test/server-link-parser.test.mjs`、`test/server-registration-attempts.test.mjs`、`test/server-deep-link.test.mjs`

**依赖：** Task 1 的 DTO、installation 与 candidate/current 操作。

**产出接口：** `RegistrationAttemptStore`、`DeviceGrantClient.preview/redeem`、深链接收器。

- [ ] 写三个入口、旧 token 拒绝、双状态 Preview 和单飞 Redeem 失败测试。
- [ ] 写 15 分钟 attempt 与 10 分钟 Redeem 恢复窗口测试。
- [ ] 扩展第二实例 argv 和 macOS URL 生命周期测试。
- [ ] 实现 parser、attempt、协议客户端和 candidate 提升。
- [ ] 运行 `node --test test/server-link-parser.test.mjs test/server-registration-attempts.test.mjs test/server-deep-link.test.mjs`。

### Task 3：连接生命周期与提醒

**测试：** `test/server-connection-manager.test.mjs`、`test/server-expiry-reminder.test.mjs`

**依赖：** Task 1–2 的 current 连接和 DeviceGrantClient。

**产出接口：** `ConnectionManager.start/retry/disconnect/subscribe`、`ExpiryReminder.evaluate`。

- [ ] 写 Refresh 轮换、PERSISTENCE_PENDING、退避和恢复失败测试。
- [ ] 写 URL/授权双有效期与 7/3/1/0 天边界测试。
- [ ] 实现状态机、Refresh、Bootstrap、时钟偏移和通知。
- [ ] 验证 invalid_grant/grant_deleted 清凭证，授权禁用/到期只降级。
- [ ] 运行 `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs`。

### Task 4：本机代理与服务端模型

**测试：** `test/server-local-proxy.test.mjs`、`test/server-model-projection.test.mjs`、现有 profile 启动测试。

**依赖：** Task 3 的 access token 提供器、状态订阅和 connection revision。

**产出接口：** `LocalGatewayProxy.createSession/revokeSession`、只读 server profile provider。

- [ ] 写回环绑定、会话 bearer、路径白名单和 `/gateway` pathname 保留测试。
- [ ] 写流式透传、POST 不重试和 GET 单次刷新测试。
- [ ] 写稳定 profile ID、只读写操作拒绝和 `ucli-server-*` 所有权测试。
- [ ] 接入新建、恢复、档案切换和交互式总结启动路径。
- [ ] 运行目标测试及全部 `test/*profile*.test.mjs`。

### Task 5：服务端 Skills

**测试：** `test/server-skills-catalog.test.mjs`、`test/server-skill-download.test.mjs`、现有 Skills 测试。

**依赖：** Task 3 的 access token 与 Bootstrap skillsCatalogUrl。

**产出接口：** `SkillsCatalogAdapter.sync/download/install/update`。

- [ ] 写 cursor、同源、固定路径、重定向、超时和下载配额测试。
- [ ] 写三重 SHA-256、sizeBytes、REVOKED 和 DEPRECATED 测试。
- [ ] 实现 staging 下载，并复用现有 sourceLoader/skillsService。
- [ ] 验证断开不删除已安装 Skill，重连恢复版本映射。
- [ ] 运行服务端 Skills 测试和全部 `test/skills-*.test.mjs`。

### Task 6：设置界面、安装包与联调

**测试：** `test/server-settings-template.test.mjs`、`test/server-preload-ipc.test.mjs`、`test/server-installer.test.mjs`

**依赖：** Task 2–5 的脱敏状态、用户动作和服务端目录。

**产出：** 设置连接卡片、确认对话框、Profile/Skills 标识和跨平台深链安装。

- [ ] 写确认页双状态、连接卡片和脱敏 IPC 模板测试。
- [ ] 写 NSIS 安装/升级/条件卸载和 portable 不注册测试。
- [ ] 实现 Vue、Pinia、preload、installer 和平台事件接入。
- [ ] 在目标内网完成真实 Preview、Redeem、Refresh、模型和 Skill 冒烟。
- [ ] 运行完整 `npm test`、`npm run build` 和目标平台打包验证。

## 19. 验收矩阵

### 19.1 注册

- 未连接时全部本地能力可用。
- 三个入口进入同一确认流程，UCLI 会重新 Preview。
- URL 与授权两套状态/有效期展示正确。
- 取消和失败不改变 current 连接。
- 同 installationId 在 10 分钟内恢复 Redeem；其他情况返回 link_consumed。
- 双击确认只产生一个注册事务。

### 19.2 安全

- 拒绝旧 token、query 传密、带凭据 origin 和路径注入。
- 读取 fragment 后，地址栏和导航记录不再包含秘密。
- 数据库、日志、配置、IPC 和崩溃报告不存在明文秘密。
- 代理只监听 127.0.0.1，未知 bearer 和旧 revision 被拒绝。
- Skill 重定向、哈希错误、路径穿越和压缩炸弹被拒绝。

### 19.3 生命周期

- access token 跨多次 Refresh 后，流式模型请求继续工作。
- 网络和 HTTP 5xx 保留凭证并恢复。
- URL 过期不触发授权提醒。
- 授权延期重算提醒，永久授权无提醒。
- 所有服务端失败都不影响本地模型、Skills、会话和数据。

### 19.4 兼容与安装

- Windows 冷启动、第二实例、安装、升级和条件卸载通过。
- portable 不注册或覆盖 `ucli://`。
- macOS 冷启动与运行中 `open-url` 通过。
- 0.11.6 不接管 `ucli-server-*` 文件。

## 20. 发布与回滚

服务端已部署完成。客户端发布前必须通过固定合约 fixtures，并在可访问目标内网的环境完成真实设备注册。

至少验证 Windows 安装版、Windows portable 和目标 macOS 版本。Linux 未验证时在发布说明中明确。

回滚到 0.11.6 时，旧版本必须忽略服务端表和 `ucli-server-*` 文件。该行为使用真实 0.11.6 二进制验证。统一服务档案迁移是仅客户端的加性数据库升级：它不要求服务端改动，也不要求新的设备授权；旧版本不使用新表，当前版本在无法精确证明旧选择来源时保留历史会话而不猜测启动配置。

紧急关闭只停用服务端入口和能力，不迁移或删除本地模型、Skills、会话和数据。

## 21. 完成定义

- Device Grant Link v1 合约 fixtures 全部通过。
- 三个入口、注册状态机、candidate/current 切换和 installationId 生命周期闭环。
- Refresh、安全存储、秘密清理和网络降级通过测试。
- URL/授权双有效期、时钟校正和提醒通过边界测试。
- 服务端模型通过本机代理工作，全部启动路径 fail closed。
- Skills 目录、安装、更新、完整性和撤销状态闭环。
- 安装、升级、卸载、portable、重启和降级场景通过。
- 在目标内网完成至少一次真实注册、刷新、模型调用和 Skill 下载。
- 文档、错误提示、协议 fixtures 和发布说明与最终实现一致。

## 22. 0.12.0 本地合同与真实冒烟执行

Tasks 1–5 后，本地四文件客户端/服务端合同门为 48/48。它只覆盖三种公开协议、固定端点、双目录协议一致性和稳定 503 解析；模型投影、透明代理、凭证/本地能力保留和非 live smoke 请求由独立的九套实现测试门覆盖。真实 smoke 仍默认跳过。

真实 smoke 只能在已确认的新服务端提交与运行时摘要、并取得新的单次授权后执行。操作者仅可经安全的一次性输入通道提供必要的 origin 和链接秘密；文档、命令历史、日志、验收记录和报告不得写入真实 URL、token、请求/响应体、完整响应头、身份信息或堆栈。执行时必须显式设置 `UCLI_SERVER_SMOKE_PROTOCOL=openai_responses`，并在受控环境中启用 smoke。

一旦尝试进入 Redeem，不论结果如何都不得用同一授权重跑。先完成清理和秘密扫描，再申请新的单次授权；测试内部的同 installationId 恢复语义不授权操作者重放一次已使用的外部 smoke。

只记录下列 allowlist YAML 形状；不得扩展为原始请求、响应或任意 header 转储：

```yaml
success:
  status: PASS
  protocol: openai_responses
  stages: [protocol-validation, link-validation, temporary-root, preview, redeem-first, redeem-idempotent, refresh-forced, bootstrap, local-proxy, gateway-models, model-directory, model-stream, skills-catalog, skills-download, cleanup]
  evidence:
    bootstrapGatewayProtocolConsistency: true
    streamReceivedNonEmptyData: true
    skillDownloadHash: true
    temporaryMaterialRemoved: true
    modelResponseDiagnostic:
      httpStatus: <status-or-not-received>
      contentType: <media-type-or-not-received>
      cacheControl: <cache-control-or-not-received>
      stableCode: <model_protocol_unavailable|model_channel_unavailable|upstream_unavailable|not-received>
      requestId: <opaque-request-id-or-not-received>
      retryable: <true|false|null>
failure:
  status: FAIL
  protocol: openai_responses
  failedStage: <allowlisted-stage>
  diagnostic:
    httpStatus: <status-or-not-received>
    contentType: <application-json-or-not-received>
    cacheControl: <no-store-or-not-received>
    stableCode: <model_protocol_unavailable|model_channel_unavailable|upstream_unavailable|not-received>
    requestId: <opaque-request-id-or-not-received>
    retryable: <true|false|null>
  cleanup: <pass|fail>
```

唯一允许的 smoke 阶段词汇是：`protocol-validation`、`link-validation`、`temporary-root`、`preview`、`redeem-first`、`redeem-idempotent`、`refresh-forced`、`bootstrap`、`local-proxy`、`gateway-models`、`model-directory`、`model-stream`、`skills-catalog`、`skills-download` 和 `cleanup`。其中首次 Redeem、同 installationId 的幂等 Redeem、强制 Refresh 与 Bootstrap 必须分别记录；成功证据只能在全部 cleanup 完成后发布，并且模型响应诊断固定为上述六个字段。

## 23. 工作树验证状态（2026-08-29）

此副本同步自用户提供的实施方案。当前工作树已加入 48/48 固定合约门和默认跳过的真实 smoke 测试。2026-08-28 前两次真实内网运行分别确认并推动服务端修复 Refresh `no-store` 与 Bootstrap `contextSize` 合同；客户端始终保持严格 fail-closed，没有增加默认值或旧协议兼容。

第三次 smoke 仍仅是历史证据，不能作为新部署基线。它使用旧的“可见即可路由”假设并在模型流阶段停止；它之后的协议能力合同要求显式协议、双目录一致性和稳定 503 处理。新的真实 smoke 必须使用新的单次授权，并在已确认的新服务端提交与运行时摘要上完成模型流、Skills 哈希和清理，才可进入发布接受判断。

Windows 产物已从 PR #26 合并提交 `17683491cb7e1d57d0775f3fe76351d21077f146` 重建并通过发布校验，完整摘要与 SHA-256 记录在 `docs/release-acceptance.md`；真实完整内网 smoke 已按第 24 节通过。原生 macOS、Linux、URL-scheme/portable 人工检查和真实 0.11.6 二进制降级仍为发布阻断项。紧急关闭仅移除服务端入口/能力，不迁移或删除本地模型、Skills、会话或数据。

## 24. 最终真实协议 smoke 证据（2026-08-30）

客户端 `9b7b17c` 在已确认的新服务端提交与 runtime 上使用全新授权，仅执行一次显式 `openai_responses` smoke。Preview、首次/幂等 Redeem、强制 Refresh、Bootstrap、Gateway 双目录、非空模型流、Skills 目录、ZIP 大小/SHA-256 和 cleanup 全部通过；Skill 未安装或执行。更早一次功能链路 PASS 因成功模型响应诊断丢失不能作为最终验收，本节仅以 16:10:42 的新授权记录为准。

下列 smoke 保留其实际运行时证据，不改写为后续发布镜像。该服务端提交的运行时代码已纳入正式的 UCLI Server 0.3.1 发布；正式发布及当前生产基线见第 1 节。

```yaml
timestamp: 2026-08-30T16:10:42+08:00
clientVersion: 0.12.0
clientCommit: 9b7b17c2d0dba3edcd75a7f78e365ccb40108a65
serverCommit: a675de6fb2fad74c41553653c998b2a29fce183f
serverRuntimeImage: sha256:e4a8f48841434df722bd361c2d2c65fd74674e10db8aef2413191700d63ee2f9
localContractGate: 48 passed / 0 failed / 0 skipped
liveSmoke: 1 passed / 0 failed / 0 skipped
preview: PASS
redeem: PASS
idempotentRedeem: PASS
refresh: PASS
bootstrap: PASS
models: PASS
modelStream: PASS
skillsCatalog: PASS
skillDownloadHash: PASS
cleanup: PASS
selectedModelId: deepseek-v4-flash
selectedProtocol: openai_responses
failedStage: none
httpStatus: 200
contentType: text/event-stream; charset=utf-8
cacheControl: no-store
stableCode: not-received
requestId: 2382f083-5b3e-44ce-9e42-672e638ed905
retryable: null
bootstrapModelCount: 3
invalidContextSizeCount: 0
streamReceivedNonEmptyData: true
authorizationExpiresAt: null
serverTimePresent: true
skillInstalledOrExecuted: false
tempDatabaseRemoved: true
environmentVariablesRemoved: true
smokeDirectoriesRemoved: true
```
