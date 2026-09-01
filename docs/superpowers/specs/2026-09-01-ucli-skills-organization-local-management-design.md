# UCLI Skills 组织、本地与 CLI 状态管理设计

**状态：** 已确认，待用户复核

**日期：** 2026-09-01

**目标：** 让 UCLI 明确区分组织 Skills 与本地 Skills，自动且可靠地同步组织目录，永久保留已安装组织 Skill 的来源身份，并通过可验证的期望状态协调器支持单 CLI 启停和已安装 Skills 的批量管理。

## 背景

当前 Skills 页面同时存在在线组织目录和本地聚合目录，但二者没有共享稳定的来源模型：

1. 主进程会在服务端连接成功后后台同步组织目录，但渲染进程初始化只读取当时缓存；后台同步完成后没有目录变更事件，因此页面可能持续显示空目录，直到用户手工点击“同步组织目录”。
2. 本地聚合函数只把 GitHub 和 GitLab 识别为独立来源项目。安装后的 `server` 包虽然仍有 `server_skill_packages` 映射，但聚合时没有组织分组，最终进入“其他来源”。
3. Skills 服务已经能启用或停用一个物理安装投影，但页面入口藏在嵌套详情中，CLI 矩阵只为已停用投影提供“启用”，没有对称的“停用”。
4. 当前 `skill_installations.enabled` 同时被当作用户意图和磁盘事实；一个物理投影可能被多个 CLI 继承，因而不能可靠表达“只禁用一个 CLI”。
5. 现有批量能力只覆盖从一个集合安装多个 Skills，不覆盖已安装 Skills 的批量启用、停用、更新或移除投影。

本设计只修改 UCLI 客户端。服务端 Skills catalog、下载、生命周期和 SHA-256 合同保持不变。

## 已确认的设计决策

1. Skills 页面提供 `全部`、`组织 Skills`、`本地 Skills` 三个一级视图。
2. 组织 Skill 安装后仍归属原服务端和组织，不得进入“其他来源”。
3. 组织目录采用缓存优先、后台更新；进入页面不等待网络，后台完成后主动刷新页面。
4. 手工“同步组织目录”和“重新扫描本地”是两个独立动作和状态域。
5. 单 CLI 开关表示用户的 CLI 期望状态，不直接等同于某个物理目录是否存在。
6. 选择严格单 CLI 语义：能够安全隔离时执行迁移；无法证明隔离时阻止操作并解释影响，不返回虚假成功。
7. 停用投影是可恢复操作；移除受管包是独立的危险操作。
8. 已安装 Skills 支持多选和批量启用、停用、更新、安装及移除投影。
9. 批量操作以单个 Skill 为原子边界，不做跨 Skill 全局事务。
10. 不按 Skill 名称、目录顺序或当前连接猜测组织来源。

## 范围

### 包含

- 组织目录自动同步、缓存、变更通知和错误状态。
- 持久化的组织/本地来源身份。
- 组织、本地和全部视图的聚合与筛选。
- 每个 Skill 的 CLI 期望状态、实际状态和影响预览。
- 共享或继承目录下的安全迁移、阻止和恢复。
- 已安装 Skills 的多选和批量操作。
- 旧数据迁移、数据库、IPC、服务、渲染和发布回归测试。

### 不包含

- 修改服务端 Skills catalog、ZIP 下载或生命周期协议。
- 绕过 MIME、来源、大小或 SHA-256 校验。
- 为不支持隔离的 CLI 伪造单独停用成功。
- 自动安装、执行或信任组织 ZIP 中的代码。
- 管理不是 `SKILL.md` 的 Claude 插件命令、Agent、Hook 或 MCP 扩展。
- 在一次批量操作中提供跨 Skill 的全局回滚。
- 删除用户在 UCLI 外部维护的 Skill 文件。

## 术语和边界

### Skill Package

UCLI 保存的规范副本。现有 `skill_packages` 继续保存名称、说明、来源定位、版本引用、manifest 和内容 SHA-256。

### Source Identity

回答“这个受管包来自哪里”。来源身份不因安装、启停、断网或显式断开服务端而改变。

```js
{
  packageId,
  originKind, // organization | local | github | gitlab | plugin | discovered
  organization: null | {
    serverOrigin,
    id,
    name,
    identityStatus, // resolved | name_pending
    catalogVersionId,
    artifactSha256
  }
}
```

`originKind=organization` 必须同时具有规范化的 `serverOrigin`、非空组织 ID、目录版本 ID 和 64 位十六进制 SHA-256。组织名称可以暂时使用组织 ID 的安全展示形式并标记 `name_pending`，但不得根据 Skill 名称猜测。

### CLI Desired State

回答“用户希望哪个 CLI 使用这个 Skill”。

```js
{
  packageId,
  scopeType,       // user | project
  scopeKey,
  adapterId,
  desiredState,    // enabled | disabled | inherit
  enforcementStatus, // satisfied | migration_required | blocked | error | recovery_required
  reasonCode,
  updatedAt
}
```

`inherit` 表示该 CLI 当前通过另一个物理投影可见，但用户尚未要求 UCLI 独立控制它。用户第一次切换该 CLI 时，状态变为明确的 `enabled` 或 `disabled`。

### Skill Installation

现有 `skill_installations` 继续描述物理投影，包括路径、直接目标 adapter、内容 SHA-256、启用标志和健康状态。它是实际状态，不再承担完整的用户意图。

### Projection Plan

协调器根据期望状态、当前安装、CLI 覆盖关系和路径能力生成只读计划：

```js
{
  packageId,
  scopeType,
  scopeKey,
  changes,
  impacts,
  classification, // direct | migration_required | blocked | noop
  reasonCode
}
```

预览和实际执行必须使用相同的纯规划函数，防止页面描述与主进程行为分叉。

## 数据模型

### `skill_source_identities`

新增一对一来源身份表：

```sql
CREATE TABLE skill_source_identities (
  package_id         TEXT PRIMARY KEY,
  origin_kind        TEXT NOT NULL CHECK (origin_kind IN (
    'organization', 'local', 'github', 'gitlab', 'plugin', 'discovered'
  )),
  server_origin      TEXT,
  organization_id   TEXT,
  organization_name TEXT,
  identity_status   TEXT NOT NULL CHECK (identity_status IN ('resolved', 'name_pending')),
  catalog_version_id TEXT,
  artifact_sha256   TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
)
```

约束由数据库写入层补充校验：

- `organization` 行必须具有全部组织字段；
- 非组织行的组织字段必须为空；
- 非组织行的 `identity_status` 固定为 `resolved`；
- `server_origin` 必须等于 `new URL(value).origin`；
- `artifact_sha256` 必须是 64 位小写十六进制值；
- `package_id` 必须对应现有受管包。

现有 `server_skill_packages` 在迁移完成后继续作为服务端版本更新索引，来源展示只读取 `skill_source_identities`，避免在线目录是否存在改变已安装来源。

### `skill_cli_desired_states`

新增每包、范围和 CLI 的期望状态表：

```sql
CREATE TABLE skill_cli_desired_states (
  package_id          TEXT NOT NULL,
  scope_type          TEXT NOT NULL CHECK (scope_type IN ('user', 'project')),
  scope_key           TEXT NOT NULL,
  adapter_id          TEXT NOT NULL,
  desired_state       TEXT NOT NULL CHECK (desired_state IN ('enabled', 'disabled', 'inherit')),
  enforcement_status  TEXT NOT NULL CHECK (enforcement_status IN (
    'satisfied', 'migration_required', 'blocked', 'error', 'recovery_required'
  )),
  reason_code         TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (package_id, scope_type, scope_key, adapter_id)
)
```

物理扫描结果变化时可以更新 `enforcement_status`，但只有显式用户操作或迁移能改变 `desired_state`。

### 组织目录缓存

`server_skill_versions` 继续保存当前连接的在线目录。同步替换必须按规范化的 `server_origin + organization_id` 分区，并保留 `connection_revision` 作为迟到响应隔离边界。

- 临时断网或同步失败：保留最后成功目录和时间。
- 同一组织重新授权：新 revision 成功同步后替换旧快照。
- 切换组织：旧组织快照不得显示在新组织中。
- 显式断开：清除未安装在线目录；不删除 `skill_source_identities`。

## 来源迁移

迁移在数据库初始化期间以一个事务执行：

1. 为每个 `skill_packages` 行创建来源身份。
2. `github`、`gitlab`、`local` 和 `zip` 根据现有 `source_type` 分类；ZIP 归入本地来源。
3. 具有 `server_skill_packages` 映射的包必须迁移为 `organization`。
4. 组织名称优先从相同 `server_origin + organization_id` 的当前连接读取，其次从持久化服务档案读取。
5. 没有可靠组织名称时使用组织 ID 作为展示后备，写入 `identity_status=name_pending`，等待下次同组织同步补齐。
6. 禁止仅凭名称、slug、内容相同或当前目录中存在同名 Skill 建立组织映射。
7. 每个现有直接且启用的安装生成 `desired_state=enabled`。
8. 由该投影覆盖的其他 CLI 生成 `desired_state=inherit`，保持原行为但不伪造显式用户意图。
9. 已停用安装生成对应直接 CLI 的 `desired_state=disabled`。
10. 迁移可重复运行，现有新表行不得被覆盖为较弱或猜测的身份。

## 组织目录同步

### 主进程协调器

新增单一 `OrganizationSkillsSyncCoordinator`，负责：

- 连接身份校验；
- 五分钟 TTL；
- 相同连接身份的 single-flight；
- 调用现有严格 catalog adapter；
- 成功后发布安全目录变更事件；
- 失败时保留旧快照并记录独立错误；
- shutdown 时取消进行中的网络和文件操作。

主进程触发条件：

1. 连接进入 `connected` 或 `expiring`；
2. 连接 ID 或 revision 改变；
3. 页面请求 `ensureFresh` 且缓存超过五分钟；
4. 用户显式点击“同步组织目录”。

### 渲染进程数据流

页面初始化按以下顺序工作：

1. 同时读取本地 Skills 状态和当前组织目录缓存；
2. 立即渲染缓存；
3. 请求 `ensureFresh`，但不阻塞页面；
4. 订阅 `server-connection:skills-catalog-changed`；
5. 收到与当前连接身份匹配的事件后重新读取目录；
6. 页面重新获得焦点时再次调用 `ensureFresh`。

事件只包含安全元数据：连接身份、目录 revision、同步时间和结果状态，不包含 token、Authorization、下载 URL 或响应正文。

### 同步状态

组织目录使用独立状态：

```js
{
  status, // idle | loading_cache | syncing | ready | stale | error
  lastSyncedAt,
  catalogRevision,
  error
}
```

它不得复用服务端连接的全局 `busy`，模型目录失败也不得覆盖 Skills 同步状态。

## 来源聚合

用 `groupSkillCatalogByOrigin` 取代只认识 Git 仓库的单一分组入口。

分组键稳定定义为：

- 组织：`organization:<normalized-origin>:<organization-id>`；
- GitHub：`github:<owner>/<repository>`；
- GitLab：`gitlab:<host>/<namespace>/<repository>`；
- 本地受管：`local:managed`；
- CLI 已发现：`local:discovered:<source-kind>`；
- 插件：`local:plugin:<marketplace>:<plugin-id>`；
- CLI 内置：`local:builtin:<adapter-id>`；
- 无法识别的旧数据：`local:unresolved`，展示“来源待确认”。

任何具有有效组织来源身份的包都必须进入组织分组。“其他来源”不再作为组织 Skill 的后备路径。

## CLI 严格启停

### 能力描述

把现有投影覆盖关系扩展为显式能力描述：

```js
{
  adapterId,
  directRoot,
  covers,
  canExcludeInherited,
  isolationReasonCode
}
```

`covers` 继续描述 Claude、Codex、OpenCode、U-Code 和 DSH 的继承关系。`canExcludeInherited` 只有在客户端能通过受支持、可测试的 CLI 配置阻止继承目录时才为真，不能根据推测开启。

### 规划规则

1. 独立投影启用或停用：直接创建或停用该安装。
2. 提供者停用、继承者保持启用：先为每个继承者建立直接投影，校验内容后再停用提供者。
3. 提供者和继承者同时停用：停用提供者，不创建替代投影。
4. 提供者保持启用、继承者要求停用：仅当继承者支持可靠排除时执行；否则计划为 `blocked`。
5. 一个物理路径同时代表两个直接目标时，必须把影响展示为联动，并在可以迁移时先拆分物理投影。
6. 不兼容名称、漂移、无效 Skill、链接失效或路径冲突在预览阶段阻止写入。
7. `noop` 不写数据库、不触碰文件，也不要求重启会话。

### 执行顺序

每个 Skill 的执行顺序固定为：

1. 使用当前数据库和磁盘快照重新生成计划；
2. 验证预览 revision，拒绝过期计划；
3. 创建替代投影；
4. 校验替代投影 SHA-256；
5. 停用不再需要的旧投影；
6. 在数据库事务中提交安装记录和期望状态；
7. 刷新持久化；
8. 重新扫描并更新 enforcement 状态；
9. 返回受影响会话列表，由用户决定是否重启。

在数据库提交前失败时删除本次新建且 SHA-256 仍匹配的目录，并保留旧投影。提交后无法完成清理时保留可用副本，标记 `recovery_required`，后续破坏性操作必须先完成恢复。

## 页面信息架构

### 一级视图

- `全部`：按组织和本地来源分区，不混合来源身份。
- `组织 Skills`：按服务端和组织分组，合并未安装目录项与已安装副本。
- `本地 Skills`：展示本地受管、Git 仓库、CLI 已发现、插件和内置来源。

### 顶部操作

- 组织视图：同步组织目录、最后成功同步时间、目录状态和重试。
- 本地视图：重新扫描本地、安装本地 Skill。
- 全部视图：两个动作并列但保持独立 loading 和错误状态。

### 组织卡片

每个目录项显示：

- 服务端与组织；
- 名称、版本、生命周期；
- 未安装、已安装、部分 CLI 启用或有更新；
- 期望和实际 CLI 状态；
- 在线、缓存、离线或来源已保留状态。

`REVOKED` 阻止新安装和更新但保留已安装副本；`DEPRECATED` 继续允许现有合同规定的动作并显示迁移提示。

### CLI 状态矩阵

Skill 卡片直接展示全部 CLI，不要求打开两层详情：

| 展示状态 | 含义 | 操作 |
|---|---|---|
| 已直接启用 | 有健康直接投影 | 停用 |
| 继承可用 | 通过其他 CLI 投影可见，尚未独立管理 | 独立启用或严格停用 |
| 已停用 | 期望和实际均停用 | 启用 |
| 需要迁移 | 严格状态需要重排投影 | 预览迁移 |
| 无法隔离 | 当前能力不能满足严格状态 | 查看原因 |
| 状态异常 | 漂移、缺失、无效或恢复待处理 | 修复 |

开关只提交期望变化请求。主进程返回预览后，直接操作可一次确认；迁移和联动操作必须显示影响确认；阻止状态不显示可误导的确认按钮。

## 多选和批量操作

### 选择范围

- 支持逐项选择、当前筛选结果全选和清空选择。
- 选择集合限定在当前一级视图和当前组织分组内。
- 切换组织、来源视图或项目范围时清空不可见选择。
- “全选”不包含被筛选掉的隐藏项。

### 支持动作

- 安装选中的组织目录项；
- 更新有可用版本的受管包；
- 为指定 CLI 批量启用；
- 为指定 CLI 批量停用；
- 移除指定物理投影；
- 仅在危险区显式移除受管包。

移除最后一个物理投影时仍保留规范包、来源身份和 CLI 期望状态。只有“移除受管包”会删除规范副本、来源身份、期望状态、服务端版本映射和全部剩余投影；执行前必须单独确认。现有 `removeInstallation` 在最后一个投影被移除时自动删除规范包的行为必须拆分。

### 预览和结果

批量预览按以下类别展示：

- 可直接执行；
- 需要迁移；
- 无法隔离；
- 存在冲突；
- 无需变化。

执行按稳定 package ID 顺序逐项完成。同一 Skill 内保持原子和回滚边界；一个普通失败不阻止其他 Skill。出现 `PERSISTENCE_PENDING` 或恢复一致性失败时立即停止剩余项。

结果 DTO 固定包含：

```js
{
  succeeded: [{ packageId, action, affectedAdapterIds }],
  failed: [{ packageId, code, retryable }],
  skipped: [{ packageId, reasonCode }],
  recoveryRequired: [{ packageId, recoveryAction }],
  aborted: null | { code, remainingPackageIds }
}
```

页面保留失败和未执行项的选择，并提供“仅重试失败项”。错误 DTO 不包含本地完整堆栈、认证信息、下载地址或响应正文。

## IPC 边界

新增或调整以下语义接口：

- `server-connection:ensure-skills-fresh`：按 TTL 请求刷新；
- `server-connection:skills-catalog-changed`：主进程安全事件；
- `skills:preview-cli-state-change`：预览一个或多个期望状态变化；
- `skills:apply-cli-state-change`：应用经过 revision 校验的计划；
- `skills:preview-batch-action`：生成批量分类预览；
- `skills:apply-batch-action`：逐 Skill 执行批量动作。

所有请求只接受持久化 ID、adapter ID、已知 scope 和布尔/枚举值。渲染进程不得提交任意目标文件路径、来源 URL、SHA-256 覆盖值或组织身份。

## 错误状态

新增稳定客户端错误码：

- `SKILL_CLI_ISOLATION_UNSUPPORTED`：继承消费者无法与启用提供者隔离；
- `SKILL_PROJECTION_MIGRATION_REQUIRED`：需要用户确认迁移；
- `SKILL_PROJECTION_PLAN_STALE`：预览后状态已变化；
- `SKILL_PROJECTION_RECOVERY_REQUIRED`：上次操作需要先恢复；
- `SKILL_BATCH_CONTEXT_INVALID`：批量项目、组织或范围混合；
- `SKILL_SOURCE_IDENTITY_INVALID`：来源身份不完整或矛盾。

组织同步错误继续与连接、模型目录错误分区。同步失败不得把已连接状态显示为失败，也不得清空最后成功缓存。

## 测试设计

### 数据库

- 来源身份表约束和读写映射；
- 组织名称可靠回填与无可靠名称后备；
- 组织来源不按名称或内容误关联；
- 直接、继承和停用安装的期望状态迁移；
- 重复迁移幂等；
- 显式断开清在线目录但保留已安装来源。

### 同步

- 页面初始化先显示缓存并触发非阻塞 `ensureFresh`；
- 连接成功自动同步后发送目录变更事件；
- 五分钟内页面聚焦不重复网络同步；
- 手工同步绕过 TTL；
- single-flight 合并并发同步；
- 旧组织、旧连接 revision 和迟到事件不能覆盖当前目录；
- 同步失败保留缓存并只设置 Skills 错误域。

### 来源聚合

- 未安装和已安装组织 Skill 合并在同一组织；
- 多组织和多服务端稳定分组；
- 断网时组织安装副本仍属于组织；
- GitHub、GitLab、本地、插件、发现和内置来源保持独立；
- 有组织身份的包永不进入 unresolved 分组。

### CLI 规划和文件操作

- 独立投影直接启停；
- 提供者停用前为启用继承者建立并校验替代投影；
- 提供者启用、继承者严格停用且无排除能力时阻止；
- 共享 Codex/DSH 路径迁移；
- 名称不兼容、漂移、冲突、缺失和无效状态阻止写入；
- 过期计划拒绝；
- 文件失败、数据库失败和 flush 失败回滚；
- recovery 状态阻止后续破坏性操作并可收敛恢复。

### 批量

- 当前筛选全选不包含隐藏项；
- 切换视图或组织清理越界选择；
- 预览分类与单项规划一致；
- 普通失败允许后续项继续；
- persistence pending 中止剩余项；
- 失败项保留并可单独重试；
- 请求数量和混合上下文边界校验。

### 渲染

- 三个一级视图和独立同步/扫描动作；
- 组织同步时间、缓存和错误状态；
- Skill 卡片直接显示 CLI 状态矩阵；
- 直接、继承、迁移、阻止和异常状态文案；
- 批量操作栏、危险操作分区、影响确认和结果摘要；
- 键盘选择、焦点、禁用态和 loading 状态可用性。

### 发布验证

- Skills 相关单元、IPC、数据库、服务和渲染测试；
- Windows 临时目录真实投放、迁移、停用和恢复集成测试；
- 服务端合同门保持通过；
- 完整 Node 测试、构建、release verification 和 DEV 手工验收。

## 验收标准

1. 已连接用户进入 Skills 页面时，无需手工同步即可看到缓存，并在后台获得最新组织目录。
2. 后台同步成功后当前页面自动更新。
3. 组织 Skill 安装后仍位于对应服务端和组织分组。
4. 临时断网不清空目录；显式断开只移除未安装在线目录。
5. 已安装组织 Skill 在断开后仍保留组织来源身份。
6. 本地 Skill 不会被错误标记为组织来源。
7. 每个 Skill 卡片直接显示各 CLI 的期望、实际和隔离状态。
8. 可以安全隔离时，停用一个 CLI 不改变其他 CLI 的有效可用性。
9. 无法严格隔离时操作被阻止，并展示稳定原因和受影响关系。
10. 停用不会删除受管包；移除受管包必须使用独立危险操作。
11. 用户可以对当前筛选结果批量启用、停用、更新和移除投影。
12. 批量部分失败时成功项、失败项、跳过项和恢复项准确可见。
13. 组织切换、连接 revision 变化和迟到响应不能污染当前目录。
14. 所有新增操作保持服务端来源、ZIP、SHA-256、路径和 IPC 安全边界。

## 实施顺序约束

实施计划必须按以下依赖顺序拆分：

1. 来源身份和期望状态数据库迁移；
2. 纯来源聚合和 CLI 投影规划器；
3. 单项协调器、回滚和恢复；
4. 组织目录同步协调器与安全事件；
5. 单项页面信息架构与 CLI 状态矩阵；
6. 批量预览、执行和页面交互；
7. 文档、完整发布门和 Windows DEV 验收。

每一步必须先添加失败测试，再做最小实现，并在提交前运行对应局部门。任何无法严格满足的 CLI 隔离组合必须保持阻止状态，不能通过增加默认值或宽松推断绕过。
