# UCLI 0.12.0 统一服务档案与多模型设计

**状态：** 已确认，待实施计划

**日期：** 2026-08-31

**目标：** 将服务端连接投影为一个跨 Codex/Claude 共用的只读服务档案，并把服务端模型建模为该档案的子资源，使会话和默认绑定显式保存“服务档案 + 模型”，彻底消除“一个模型就是一个档案”的错误语义。

## 背景

UCLI 0.12.0 已支持 Device Grant Link、Bootstrap、协议能力目录、loopback Gateway、服务端模型投影和组织 Skills。当前 `electron/serverConnection/modelProjection.js` 仍以 `serverOrigin + organizationId + modelId + adapterId` 生成稳定档案 ID，并为每个兼容模型/适配器组合暴露一个只读档案。

该实现把模型误建模为档案，产生以下问题：

1. 同一个服务端连接在“配置档案”页面显示多个“组织提供”档案。
2. 模型选择被隐藏在档案选择中，无法表达“一个服务档案包含多个模型”。
3. 应用/项目默认绑定只能保存档案，不能显式保存服务档案中的模型。
4. Codex 和 Claude 看到不同档案 ID，无法共享同一个服务档案身份。
5. 模型下线会被解释为档案删除，而不是服务档案内的目录变化。

本设计修正客户端领域模型，不修改服务端协议。Bootstrap 和 Gateway 目录继续以服务端声明的 `models[].protocols` 为唯一模型能力来源。

## 已确认的设计决策

1. 每个 `serverOrigin + organizationId` 只有一个逻辑服务档案。
2. 服务档案跨 Codex 和 Claude 共用；模型按当前适配器需要的公开协议过滤。
3. Codex 只消费 `openai_responses`，Claude 只消费 `anthropic_messages`。
4. `openai_chat` 模型保留在服务档案目录中，但 0.12.0 不为其伪造兼容 CLI。
5. 应用/项目可以保存“服务档案 + 模型”默认组合；无有效默认模型时必须显式选择。
6. 禁止使用 `models[0]`、模型 ID、显示名、厂商或目录顺序推断模型或协议。
7. 服务端授权成功与模型/Skills 后置同步结果分离；目录失败不能把已成功连接显示成连接失败。
8. 服务档案、模型、会话和默认绑定不得持久化 token、Authorization、Cookie 或供应商 Key。

## 范围

### 包含

- 统一服务档案和子模型的数据库结构与迁移。
- 跨适配器服务档案 DTO。
- 服务档案、模型和默认绑定解析。
- Codex/Claude 启动时显式传入所选模型。
- 多模型 Codex 运行时工件隔离。
- 配置档案、新建会话、已有会话和服务端连接界面调整。
- 连接、模型目录和 Skills 目录错误分区。
- 旧服务端模型档案、会话和默认绑定迁移。
- 协议、数据库、运行时、界面和发布回归测试。

### 不包含

- 修改服务端 Bootstrap、Gateway 或 Device Grant Link 协议。
- 新增原生 Gemini 协议或将 `openai_chat` 猜测为其他协议。
- 为 OpenCode、U-Code 或 DeepSeek Harness 新增服务端托管适配器。
- 在客户端编辑服务端模型、协议、上下文窗口或服务档案身份。
- 自动替换已删除模型或自动选择目录第一项。
- 删除本地普通档案、Skills、会话历史或本地登录状态。

## 领域模型

### ServiceProfile

服务档案代表当前服务端和组织提供的一组模型能力：

```js
{
  id,
  serverOrigin,
  organization: { id, name },
  connectionRevision,
  availabilityStatus,
  supportedAdapterIds,
  models
}
```

`id` 只由规范化后的 `serverOrigin` 和 `organization.id` 稳定派生，不包含模型、适配器或授权连接 ID。因此同一服务端/组织重新授权后仍保持同一个逻辑服务档案身份，`connectionRevision` 用于隔离旧运行时 authority。

`supportedAdapterIds` 是模型能力的派生展示字段：至少一个模型支持 `openai_responses` 时包含 `codex`，至少一个模型支持 `anthropic_messages` 时包含 `claude`。它不能替代模型级协议校验。

### ServiceModel

```js
{
  serviceProfileId,
  id,
  displayName,
  contextSize,
  protocols,
  availabilityStatus
}
```

`protocols` 继续严格限制为：

- `openai_responses`
- `openai_chat`
- `anthropic_messages`

数组必须非空且不能包含未知值。模型顺序只用于稳定展示，不表达默认优先级。

### 选择值

服务端会话和默认绑定使用二元选择：

```js
{
  profileId: serviceProfileId,
  model: modelId
}
```

普通本地档案继续保留其现有固定模型或 Provider 继承语义，不强制新增模型选择。

## 持久化设计

### server_service_profiles

每个服务档案一行，至少包含：

- `profile_id` 主键；
- `server_origin`；
- `organization_id`；
- `organization_name`；
- `connection_revision`；
- `availability_status`。

数据库约束保证 `server_origin + organization_id` 唯一。

### server_service_models

每个服务档案模型一行，至少包含：

- `service_profile_id`；
- `model_id`；
- `display_name`；
- `context_size`；
- `protocols_json`；
- `availability_status`；
- `catalog_order`。

主键为 `service_profile_id + model_id`。`protocols_json` 在写入前已经通过严格合同解析，读取时仍执行防御性校验。`catalog_order` 只保持服务端展示顺序。

### 会话与默认绑定

现有会话表已经分别持久化 `profile_id` 和 `model`，不新增会话字段。服务端会话要求二者同时有效。

`ai_cli_profile_bindings` 增加可空 `model_id`：

- 服务档案绑定必须有 `model_id`；
- 本地普通档案绑定保持 `model_id = null`；
- 绑定仍以 `scope_type + scope_key + adapter_id` 唯一，因此 Codex 和 Claude 可以为同一个服务档案选择不同默认模型。

## 旧数据迁移

迁移在单个数据库事务中执行：

1. 读取旧 `server_model_profiles` 行，按 `server_origin + organization_id` 分组。
2. 为每组创建一个稳定服务档案。
3. 按 `model_id` 合并旧行；`codex` 行映射为 `openai_responses`，`claude` 行映射为 `anthropic_messages`，相同模型取协议并集。
4. 旧结构未投影的 `openai_chat` 模型无法从本地反推；它只在下一次严格 Bootstrap 同步后进入新目录。
5. 为每个旧档案 ID 建立 `{ serviceProfileId, modelId, adapterId }` 映射。
6. 将引用旧服务端档案的会话更新为新服务档案 ID，并将旧行 `model_id` 写入会话 `model`。
7. 将应用/项目绑定更新为新服务档案 ID 和旧模型 ID，同时保留原 `adapter_id`。
8. 无法唯一映射的绑定被清除；会话历史保留，但服务档案选择被标记为不可启动，不选择替代模型。
9. 新表、会话和绑定全部验证成功后才完成事务并移除旧表数据。

数据库迁移不直接删除文件。首次新运行时工件成功签发后，客户端仅清理由所有权标记和文件名共同验证的旧 `ucli-server-*` Codex 配置文件。任何不满足所有权检查的文件都保留并报告安全错误。

## 目录同步与原子发布

Bootstrap 模型目录经过现有严格合同解析后，投影层执行：

1. 规范化服务端和组织身份。
2. 验证全部模型 ID、显示名、正整数 `contextSize` 和非空公开协议数组。
3. 构造一个服务档案及完整子模型集合。
4. 在一个数据库事务中替换同一服务档案的模型目录并更新连接修订。
5. 持久化成功后才发布新的前端 DTO 和运行时目录修订。

任一模型非法时整批拒绝，保留上次有效缓存并将服务档案标记为目录不可达。客户端不发布半个目录，也不从 Gateway 目录或旧缓存补全非法 Bootstrap 字段。

断网或授权暂时不可达时，缓存的服务档案和模型继续可查看但不可启动。本地普通档案、已有本地会话和本地 Skills 不受影响。

## 协议过滤与运行时

统一运行时接口：

```js
prepareRuntime({
  serviceProfileId,
  modelId,
  adapterId,
  sessionId
})
```

启动前必须依次确认：

1. 服务档案存在且当前可用；
2. 模型 ID 已显式提供；
3. 模型属于该服务档案且当前可用；
4. Codex 模型声明 `openai_responses`，或 Claude 模型声明 `anthropic_messages`；
5. 当前连接身份和连接修订仍与目录一致。

任一条件不满足都以本地稳定、非秘密错误失败。不得回退到其他模型。

### Codex

逻辑服务档案只有一个，但 Codex 原生配置必须携带所选模型和对应上下文窗口。为避免不同模型并发启动互相覆盖，运行时按 `serviceProfileId + modelId` 生成隔离的 UCLI-owned 原生配置文件。文件身份是内部运行时工件，不作为前端档案或默认绑定 ID。

Codex 通过固定 `responses` wire API、loopback Provider、进程环境 bearer 和显式 `--model <modelId>` 启动。文件和进程参数中的模型必须一致。

### Claude

Claude 不生成模型档案文件。运行时使用同一逻辑服务档案签发 loopback bearer，设置固定 `/anthropic` base URL，并显式传入 `--model <modelId>`。

### Authority 与撤销

运行时修订至少包含连接修订、服务档案 ID、模型 ID 和模型能力摘要。目录刷新后：

- 模型删除或失去所需协议时撤销受影响会话的 authority；
- 其他模型会话保持可用；
- 服务档案身份不变；
- 连接替换、断开或授权终止继续撤销整个连接的所有 authority。

## 前端 DTO 与档案解析

本地普通档案继续使用单一 `adapterId`。服务档案 DTO 使用：

```js
{
  sourceKind: 'server',
  readOnly: true,
  supportedAdapterIds: ['codex', 'claude'],
  models: [...]
}
```

档案解析和默认绑定解析必须以 `supportedAdapterIds` 初筛，再以所选模型的 `protocols` 做最终校验。不能仅因服务档案支持某个适配器，就认为其中全部模型都兼容。

## 用户界面

### 配置档案

“配置档案”页面新增独立的“组织服务档案”区域，不放入 Codex 或 Claude 本地档案列表。每个服务端/组织只显示一张只读卡片，包含：

- 服务端和组织；
- 连接/目录状态；
- 模型数量；
- 每个模型的显示名、模型 ID、公开协议、上下文窗口和状态；
- “设置 Codex 默认”和“设置 Claude 默认”入口。

设置默认时必须选择对应适配器兼容的模型。项目默认仍要求先选择项目目录。

### 新建与导入会话

Codex/Claude 配置区域允许选择统一服务档案。选择后展示独立模型下拉框，只列出当前适配器兼容且可用的模型。若没有有效的应用/项目默认模型，模型必须由用户显式选择，创建按钮保持禁用直到选择完整。

导入历史会话选择服务档案时同样要求显式模型；选择“保持历史连接”时不改写历史模型。

### 已有会话

会话配置同时展示档案和模型。切换到服务档案时必须选择兼容模型；切换模型写入现有会话 `model` 字段，并沿用当前“运行中会话重启后生效”规则。

已选模型从目录删除时，会话历史和原模型 ID 保留，但重新启动被阻止，界面要求用户手动选择新模型。

### 服务端连接

“设置 → 服务端连接”只展示授权生命周期状态，同时增加服务档案入口和模型数量摘要。模型查看、选择和默认设置统一在“配置档案”页面完成。

## 错误分区

前端服务端状态拆分为：

- `connectionError`：Preview、Redeem、Refresh、Bootstrap 和凭证生命周期；
- `modelCatalogError`：服务档案投影、模型目录持久化和模型选择；
- `skillsCatalogError`：Skills 目录、下载和安装。

确认连接在凭证持久化和首次 Bootstrap 成功后返回成功。后置模型或 Skills 刷新使用独立结果处理，不得使确认连接 Promise 失败。成功重试只清除对应错误分区，不能覆盖其他并发错误。

界面显示规则：

- 服务端连接卡片只显示 `connectionError`；
- 组织服务档案卡片显示 `modelCatalogError`；
- Skills 页面显示 `skillsCatalogError`。

错误对象继续只保留稳定 code、用户可读消息和 retryable，不包含响应正文、完整 headers、token、Cookie、供应商信息或完整堆栈。

## 安全边界

- 服务档案和模型目录不保存 bearer、refresh token 或供应商密钥。
- loopback bearer 只存在于进程内存和子进程环境。
- 服务档案 ID 不包含账号显示名、组织名称或模型 ID。
- Codex 文件只包含 loopback 地址、非秘密 env key 名称和所选模型配置。
- 模型目录失败不清除服务端凭证，不改变本地能力。
- 模型 POST 不自动重放；模型选择失败不触发 Refresh。
- 旧文件清理必须同时通过 UCLI 所有权标记、允许的文件名和目标目录边界检查。

## 测试策略

### 数据库与迁移

- 多个旧模型/适配器行迁移为一个服务档案和多个子模型。
- 同模型多适配器行合并协议集合。
- 会话迁移保留模型 ID。
- 应用/项目绑定迁移保留适配器、档案和模型。
- 歧义绑定 fail closed，事务失败完整回滚。
- 0.11.x 继续忽略服务端专用表和文件。

### 投影与协议

- 多模型只返回一个服务档案 DTO。
- Codex/Claude 从同一档案获得不同兼容模型集合。
- Chat-only 模型可查看但不产生可启动适配器选择。
- 缺失模型、未知模型、模型删除和协议不兼容严格失败。
- 不存在 `models[0]`、模型名称或厂商推断路径。

### 运行时

- Codex/Claude 均使用显式模型 ID。
- 两个 Codex 模型并发启动使用隔离文件和 bearer authority。
- 模型移除只撤销受影响会话。
- 连接替换仍撤销整个旧连接。
- 文件所有权、摘要持久化和 loopback 边界保持严格。

### 前端与错误

- 配置档案页面只显示一张组织服务档案卡片。
- 新建、导入和已有会话都要求完整的服务档案/模型选择。
- 应用/项目默认模型正确继承，无默认时禁止隐式选择。
- 后置模型或 Skills 同步失败时连接仍成功，错误显示在对应区域。
- 一个子系统成功不能清除另一个子系统错误。

### 发布门

执行受影响单元测试、服务端固定合同门、服务档案实现门、数据库迁移门、文档门和 `npm run verify:release`。本次变更不消费一次性授权，也不重跑已经完成的最终 live smoke；只有服务端协议或真实 Gateway 请求链路发生变化时才需要新的授权联调。

## 文档更新

实施完成后同步更新：

- `docs/ucli-client-protocol.md`：统一服务档案、模型选择和运行时协议规则；
- `docs/ucli-client-registration-upgrade.md`：数据库迁移、任务顺序和回滚边界；
- `docs/release-acceptance.md`：本地实现门和既有 live smoke 的适用范围，不伪造新的 live 证据。

## 完成标准

- 同一服务端/组织在客户端只存在一个逻辑服务档案。
- 服务档案包含完整严格模型目录，模型不再作为独立档案。
- 会话和默认绑定显式保存服务档案与模型。
- Codex/Claude 只显示并启动协议兼容模型。
- 无有效默认时必须手动选择，所有隐式首项和猜测路径均不存在。
- 旧会话和默认绑定迁移保留原模型，歧义数据 fail closed。
- 后置目录失败不再产生“连接失败但状态已连接”的矛盾提示。
- 本地能力、凭证安全、loopback 隔离、Skills 和发布验证无回归。
