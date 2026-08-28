# UCLI 0.12.0 客户端—服务端协议

协议版本：Device Grant Link v1
服务端基线：UCLI Server `0.3.0`，提交 `4f71d6efdfe2504b8f72da53e1647c226bb8ff1f`
部署验证日期：2026-08-27

## 1. 范围与环境

本协议定义 UCLI 0.12.0 的设备注册、凭证刷新、启动配置、模型网关和服务端 Skills 线缆契约。客户端模块、数据库和实施顺序由升级方案定义。

当前公司内网环境：

| 能力 | 地址 |
| --- | --- |
| 控制面/API | `http://10.44.100.100` |
| 模型网关基址 | `http://10.44.100.100/gateway` |

HTTP 是本次可信公司内网的既定配置。客户端不得把该信任假设扩展到公网或其他不可信网络。

0.12.0 只实现本文的 `#link=` 协议，不兼容旧邀请、设备码、`#token=` 或 query 传递秘密。

## 2. 独立模式与单服务端

UCLI 可独立安装和使用。未注册、服务端不可达或授权失效时，本地模型、已安装 Skills、本地数据和本地会话继续可用。

设置只维护一个当前服务端连接。新连接完成 Preview、Redeem 和凭证安全落盘后，才能替换旧连接；失败不得删除旧连接或本地数据。

断开只删除本机服务端凭证和连接元数据，不删除服务端设备或授权。installationId 独立持久化，断开和普通升级不得重置。

## 3. 术语与秘密边界

| 名称 | 含义 | 持久化规则 |
| --- | --- | --- |
| link secret | 当前设备授权 URL 的不透明秘密 | 仅在注册尝试内存中短暂存在 |
| access token | 默认有效 900 秒的设备访问令牌 | 仅运行时内存 |
| refresh token | 单次使用、刷新后轮换的设备凭证 | 经 Electron `safeStorage` 加密后仅保存密文 |
| installationId | 标识一次 UCLI 安装的 UUID v4 | 独立持久化，断开后保留 |
| attemptId | 客户端主进程中的注册尝试标识 | 仅运行时内存，不是服务端字段 |

客户端只有在 `safeStorage.isEncryptionAvailable()` 为真时才能 Redeem 或 Refresh。安全加密不可用时不得降级为明文存储。

link secret 不得进入 DOM 隐藏字段、URL query、请求路径、数据库、普通配置、安全存储、日志、异常、审计、遥测、崩溃报告或最近打开记录。

`secretHash`、refresh token 哈希和供应商 API Key 永不向客户端输出。Preview、Redeem 和 Refresh 响应必须带 `Cache-Control: no-store`。

## 4. 管理端连接 URL

管理端创建、查看或重新生成授权 URL 时，`connectionUrl` 是链接秘密的受控输出。响应不得同时返回裸 link secret 字段。

```json
{
  "id": "grant-uuid",
  "connectionUrl": "http://10.44.100.100/connect#link=one-time-link-secret",
  "expiresAt": null
}
```

管理端弹窗只在当前 DOM 中短暂展示完整 URL。关闭弹窗清除页面副本，但不会撤销服务端仍有效的当前 URL；管理员之后可以再次查看恢复。

URL 默认有效 7 天，也可设置为其他未来时间或永久。设备授权的有效期独立设置，默认永久。

重新生成 URL 只轮换当前 URL，不新建授权或改变用户、设备，并立即撤销旧 URL。禁用或删除授权也会撤销当前 URL；重新启用不会复活旧 URL。

授权绑定设备后 URL 被消费，不能查看、兑换或重新生成。UCLI 客户端不调用这些管理端操作，只处理公开 Preview/Redeem 结果。

## 5. 浏览器与自定义协议链接

浏览器连接 URL：

```text
http://10.44.100.100/connect#link=<secret>
```

浏览器只解析 fragment 中唯一的 `link` 键，读取后立即通过 `history.replaceState` 清除 fragment。

确认后，页面使用规范化 origin 唤起：

```text
ucli://connect?server=http%3A%2F%2F10.44.100.100#link=<secret>
```

客户端支持三个入口：浏览器唤起、设置页粘贴完整浏览器 URL、设置页粘贴完整 `ucli://` URL。三个入口必须汇合到同一注册流程。

协议唤起只允许打开确认界面，不得直接 Redeem。浏览器已做过 Preview，UCLI 仍必须重新 Preview，以捕获其间发生的到期、撤销、重新生成或消费。

## 6. 客户端链接校验

客户端仅接受：

- `http(s)://<host>[:port]/connect#link=<secret>`
- `ucli://connect?server=<encoded-http(s)-origin>#link=<secret>`

浏览器 URL 路径必须严格等于 `/connect`。`ucli://` 的 host 必须严格等于 `connect`。

`server` 解码后必须是纯 HTTP(S) origin，不得包含用户名、密码、路径、query 或 fragment。

客户端拒绝空 link、重复 link、旧 token fragment、query 传密、非 HTTP(S) 服务端、用户信息、路径注入和额外 fragment 参数。

link secret 是区分大小写的不透明字符串。客户端不得解码后重组、截断、规范化或自行派生。

解析结果只保存在主进程。渲染进程只能获得 attemptId 与脱敏 Preview，不得获得 link secret。

## 7. Preview

### 7.1 请求

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
```

```json
{
  "link": "<secret>"
}
```

### 7.2 成功响应

成功状态为 HTTP `200`：

```json
{
  "account": {
    "id": "account-uuid",
    "displayName": "成员姓名"
  },
  "organization": {
    "id": "organization-uuid",
    "name": "组织名称"
  },
  "link": {
    "status": "AVAILABLE",
    "expiresAt": "2026-09-02T04:00:00.000Z"
  },
  "authorization": {
    "status": "AVAILABLE",
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

Preview 不消费链接。只有 `link.status` 和 `authorization.status` 都为 `AVAILABLE` 时，客户端才能启用确认按钮。

`link.status` 只能是 `AVAILABLE`、`EXPIRED`、`REVOKED` 或 `CONSUMED`。

`authorization.status` 只能是 `AVAILABLE`、`BOUND`、`DISABLED`、`EXPIRED` 或 `DELETED`。

确认页展示服务端、组织、成员、URL 状态/有效期、授权状态/有效期和服务器时间。

## 8. Redeem

### 8.1 请求

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
```

```json
{
  "link": "<secret>",
  "device": {
    "installationId": "550e8400-e29b-41d4-a716-446655440000",
    "name": "张三的工作站",
    "platform": "windows",
    "clientVersion": "0.12.0"
  }
}
```

字段约束：

| 字段 | 约束 |
| --- | --- |
| `installationId` | UUID v4，Redeem 前已可靠持久化 |
| `name` | 去除首尾空白后 1–120 字符 |
| `platform` | `windows`、`macos` 或 `linux` |
| `clientVersion` | 1–32 字符 |

### 8.2 成功响应

成功状态为 HTTP `200`：

```json
{
  "accessToken": "jwt",
  "refreshToken": "opaque-refresh-token",
  "expiresIn": 900,
  "account": {
    "id": "account-uuid",
    "displayName": "成员姓名"
  },
  "organization": {
    "id": "organization-uuid",
    "name": "组织名称"
  },
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

首次成功 Redeem 绑定设备并消费 URL。同一 installationId 可以在首次绑定后 10 分钟内使用相同 link secret 幂等重试。

合法重试轮换 refresh token 并返回完整凭证。不同 installationId、超过窗口或其他已消费场景返回 `link_consumed`。

双击确认或并发提交只能产生一个客户端注册事务。注册失败不得生成新的 installationId。

## 9. Refresh 与 Bootstrap

### 9.1 Refresh

```http
POST /api/v1/auth/token/refresh
Content-Type: application/json
```

```json
{
  "refreshToken": "opaque-refresh-token"
}
```

成功响应：

```json
{
  "accessToken": "jwt",
  "refreshToken": "next-opaque-refresh-token",
  "expiresIn": 900,
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

refresh token 单次使用。收到成功响应后不得再次使用旧 token。

若安全存储暂时写入失败，进程存活期间在受控内存保留新 token 并重试落盘，同时暂停新的 Refresh 和服务端会话。不得把旧 token 恢复为当前值。

### 9.2 Bootstrap

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <accessToken>
```

```json
{
  "organization": {
    "id": "organization-uuid",
    "name": "组织名称",
    "timezone": "Asia/Shanghai"
  },
  "gateway": {
    "baseUrl": "http://10.44.100.100/gateway"
  },
  "models": [
    {
      "id": "example-model",
      "displayName": "示例模型",
      "contextSize": 128000
    }
  ],
  "skillsCatalogUrl": "http://10.44.100.100/api/v1/skills/catalog",
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

客户端不得自行拼装或永久缓存网关地址，必须使用最近一次 Bootstrap 返回的基址。

Redeem、Refresh 和 Bootstrap 都更新授权有效期与服务器时间。长期提醒只使用授权有效期，不使用 URL 有效期。

## 10. URL 与授权有效期

| 字段 | 含义 | 客户端用途 |
| --- | --- | --- |
| `link.expiresAt` | 当前连接 URL 的有效期 | 仅判断本次注册入口能否继续 |
| `authorization.expiresAt` | 设备授权有效期 | 决定服务端能力并驱动长期提醒 |
| `authorization.serverTime` | 服务端生成响应时的时间 | 校正本机时间偏差 |

客户端保存最近一次服务器时间、本机接收时间和偏移：

```text
serverOffset = authorization.serverTime - receivedLocalTime
estimatedServerNow = currentLocalTime + serverOffset
remaining = authorization.expiresAt - estimatedServerNow
```

授权提醒阈值为到期前 7 天、3 天、1 天和当天。跨过多个阈值时只通知最接近到期的一次，并把更宽阈值标记为已跨过。

授权延期后重新计算提醒；变为永久授权后清除提醒。URL 到期不得触发长期授权提醒。

## 11. 稳定错误与 HTTP 语义

Preview/Redeem 业务错误使用 HTTP `400`，响应体至少包含：

```json
{
  "code": "link_expired"
}
```

Refresh、Bootstrap、Skills 和网关鉴权失败使用 HTTP `401`。授权生命周期错误响应体为：

```json
{
  "code": "grant_expired",
  "message": "Device grant has expired"
}
```

客户端必须按 `code` 分支，不得依赖英文 `message`。网络失败、超时和 HTTP `5xx` 只表示可恢复故障。

| 错误码 | 常见阶段 | 客户端动作 |
| --- | --- | --- |
| `invalid_link` | Preview/Redeem | 保留当前连接，要求新的授权链接 |
| `link_expired` | Preview/Redeem | URL 已到期，要求管理员创建新 URL |
| `link_revoked` | Preview/Redeem | URL 已撤销，要求管理员创建新 URL |
| `link_consumed` | Preview/Redeem | URL 已使用或重试窗口结束，要求新授权 |
| `invalid_device` | Redeem/Refresh/Bootstrap | 修正注册输入；已连接设备失效时清除服务端凭证 |
| `invalid_grant` | Refresh/Bootstrap | 清除无效服务端连接，要求新授权 |
| `grant_disabled` | 全流程 | 停用服务端能力，保留连接元数据，等待启用 |
| `grant_expired` | 全流程 | 停用服务端能力，显示授权有效期并等待延期 |
| `grant_deleted` | 全流程 | 清除服务端凭证，要求新授权 |
| `account_inactive` | 全流程 | 停用服务端能力，提示账号或成员关系不可用 |
| `organization_inactive` | 全流程 | 停用服务端能力，提示组织不可用 |

`grant_bound` 仅用于管理端拒绝重新生成 URL。公开 Preview/Redeem 对已消费 URL 返回 `link_consumed`，客户端不得保留旧绑定错误别名。

任何服务端错误都不得删除或阻止本地模型、本地 Skills、本地会话和本地数据。

## 12. 模型网关

Bootstrap 的 `gateway.baseUrl` 是带路径的网关基址。拼接端点时必须保留其 `/gateway` 路径，不能使用会丢弃基址 pathname 的绝对 URL 替换方式。

当前完整端点：

| 能力 | 方法与地址 | 鉴权 |
| --- | --- | --- |
| 模型列表 | `GET http://10.44.100.100/gateway/v1/models` | Bearer |
| OpenAI Responses | `POST http://10.44.100.100/gateway/v1/responses` | Bearer |
| OpenAI Chat | `POST http://10.44.100.100/gateway/v1/chat/completions` | Bearer |
| Anthropic Messages | `POST http://10.44.100.100/gateway/anthropic/v1/messages` | Bearer；兼容客户端可使用 `x-api-key` |

`GET /v1/models` 返回 OpenAI 风格的 `{ "object": "list", "data": [...] }`。模型请求使用 Bootstrap 中模型的 `id`。

流式请求沿用 OpenAI/Anthropic 的取消与错误处理。单个上游模型失败不得映射为设备授权失效。

## 13. 客户端本机代理边界

CLI 子进程不直接持有服务端 access token。Electron 主进程只在 `127.0.0.1` 随机端口提供代理，并向每个 CLI 会话签发内存 bearer。

本机代理暴露 `/v1/models`、`/v1/responses`、`/v1/chat/completions` 和 `/anthropic/v1/messages`，再将路径追加到 `gateway.baseUrl`。

代理移除 CLI 提供的 Authorization、Cookie 和逐跳头，使用 Bearer 注入当前 access token。服务端兼容的 `x-api-key` 不作为 UCLI 首选路径。

响应必须流式透传。POST 不自动重放；GET 在强制刷新 access token 后最多重试一次。

本机 bearer 绑定 CLI session 与 connection revision。断开、连接替换、授权失效、会话结束或应用退出时立即撤销。

## 14. 服务端 Skills

目录请求：

```http
GET /api/v1/skills/catalog?cursor=<ISO-8601-time>
Authorization: Bearer <accessToken>
```

首次请求不带 cursor。服务端每页最多返回 100 项，按 `createdAt` 升序；客户端使用最后一项 `createdAt` 获取下一页。

每项包含 `id`、`version`、`sha256`、`sizeBytes`、`publishedAt`、`createdAt`、`skill.slug/name/description` 和 `downloadUrl`。

下载请求继续携带 Bearer token：

```http
GET /api/v1/skills/:versionId/download
Authorization: Bearer <accessToken>
```

客户端同时校验目录 `sizeBytes`、目录 `sha256`、响应头 `x-ucli-sha256` 和实际 ZIP 摘要。

撤销请求：

```http
GET /api/v1/skills/revocations
Authorization: Bearer <accessToken>
```

服务端返回当前组织可见的 `REVOKED` 或 `DEPRECATED` 版本。`REVOKED` 阻止新安装和更新；已安装副本保留并显示风险。

服务端同步失败、授权失效或断开不得删除、覆盖或禁用用户已有的本地 Skills。

## 15. 超时、重试与诊断

控制面请求超时为 15 秒，Skill 下载超时为 120 秒。网络恢复按 30 秒、1 分钟、2 分钟、5 分钟、15 分钟退避并加入抖动。

诊断只记录服务端 origin、阶段、HTTP 状态、稳定错误码、耗时和脱敏会话 ID。

诊断不得记录完整连接 URL、fragment、请求体、Authorization、Cookie、link secret、access token、refresh token、模型请求体或响应体。

## 16. 合约与发布要求

客户端和服务端使用固定 JSON fixtures 覆盖 Preview、Redeem、Refresh、Bootstrap、稳定错误、Skills 分页和模型流式响应。

客户端必须忽略未知响应字段，并在必填字段缺失、类型错误、非法日期、未知枚举或不安全 URL 时 fail closed。

服务端 `0.3.0` 已部署完成。客户端 0.12.0 发布前必须在可访问目标内网的环境完成至少一次真实设备注册、刷新、模型调用和 Skill 下载。

## 17. 工作树验证状态（2026-08-28）

此副本同步自用户提供的协议；它记录的是合同而不是已完成发布。当前工作树的固定 fixtures 覆盖 Preview、Redeem、Refresh、Bootstrap、Skills、稳定错误和合成 SSE，并对未知字段/枚举、日期、必填字段、URL、内容类型和 `no-store` 作本地 fail-closed 检查。真实内网注册、刷新、模型调用和 Skill 下载仍须使用新的单次授权显式执行；本次没有运行该步骤。
