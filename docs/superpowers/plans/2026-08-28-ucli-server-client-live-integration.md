# UCLI 0.12 Client–Server Live Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 UCLI Server Refresh 响应的缓存控制契约，完成 UCLI Client 0.12.0 与已部署服务端的真实注册、刷新、模型和 Skills 全链路联调。

**Architecture:** 服务端继续作为 Device Grant Link v1 的凭证与网关权威来源，客户端继续在 Preview、Redeem、Refresh 三条敏感 JSON 线缆上强制 `Cache-Control: no-store` 并 fail closed。先用服务端单元测试锁定 Refresh 路由元数据，再部署并用无效占位 token 验证线上错误响应；只有部署探针通过后才创建新的单次授权，由客户端隔离 smoke 消费并验证完整链路。

**Tech Stack:** NestJS 11、TypeScript 5.9、Vitest 3、Docker Compose、PowerShell 7、Node.js test runner、UCLI Client 0.12.0。

## Global Constraints

- 协议固定为 Device Grant Link v1，客户端目标版本固定为 `0.12.0`。
- 当前可信内网 origin 固定为 `http://10.44.100.100`；不得把 HTTP 信任扩展到公网或其他不可信网络。
- Preview、Redeem、Refresh 的成功与错误 JSON 响应都必须带 `Cache-Control: no-store`。
- 不放宽客户端 `electron/serverConnection/deviceGrantClient.js` 的 `requireNoStore` 校验；服务端修复合同违约。
- 不改变请求/响应 JSON、稳定错误码、refresh token 单次使用和同 installationId 十分钟幂等 Redeem 语义。
- 不新增数据库迁移、依赖或配置项。
- 单次链接、access token、refresh token、代理 bearer 和完整成功响应正文不得进入命令行、日志、截图、提交或联调记录。
- 每轮真实 smoke 使用一个新授权；失败后不得用不同 installationId 重试已消费链接。
- 服务端当前工作树的 `docs/ucli-client-protocol.md`、`docs/ucli-client-registration-upgrade.md`、`test/auth/device-grant-protocol.test.ts` 已有未提交改动，实施时必须先检查并保留，禁止覆盖。
- 联调失败时只记录阶段、HTTP 状态、`Content-Type`、`Cache-Control` 和稳定错误码；不得记录 header 中的凭证或响应中的 token。

---

## Current Evidence

2026-08-28 14:04（Asia/Shanghai）的真实客户端 smoke 已得到以下证据：

| 阶段 | 结果 |
| --- | --- |
| 服务连通性 | `http://10.44.100.100/` 返回 HTTP 200 |
| Preview | 通过，链接和授权状态均为 `AVAILABLE` |
| 首次 Redeem | 通过，设备注册成功 |
| 同 installationId 幂等 Redeem | 通过，refresh token 已轮换 |
| 强制 Refresh | 阻断；客户端返回脱敏的 `code: null` 并 fail closed |
| Bootstrap / 模型 / Skills | 因 Refresh 阻断而未执行 |
| 清理 | 单次链接已消费；临时数据库、环境变量和 smoke 目录已清理 |

无效占位 token 的线上探针返回 HTTP 401 和稳定码 `invalid_grant`，但响应头没有 `Cache-Control`。本地服务端实现 `apps/api/src/auth.controller.ts` 已为 Preview/Redeem 设置 `@Header('Cache-Control', 'no-store')`，Refresh 路由缺少相同声明；客户端在读取状态码和响应体之前检查该头，因此线上现象与源码缺口一致。

## File Structure

### UCLI Server repository

- `apps/api/src/auth.controller.ts`：为 Refresh 路由声明敏感响应缓存策略。
- `test/auth/device-grant-redeem.test.ts`：锁定 Refresh 的 POST 路径、无 Guard 和 `no-store` 元数据。
- `docs/ucli-client-protocol.md`：把 Refresh 成功和错误响应的缓存策略写成协议。
- `docs/ucli-client-registration-upgrade.md`：把缓存策略和完整联调顺序写入服务端交付方案。
- `test/auth/device-grant-protocol.test.ts`：防止协议文档再次遗漏 Refresh 的缓存策略。
- `scripts/deploy.ps1`：使用现有生产 Compose 流程构建、启动并等待健康状态；本方案不修改该文件。

### UCLI Client repository

- `test/server-integration-smoke.test.mjs`：执行隔离的 Preview → Redeem → 幂等 Redeem → Refresh → Bootstrap → 模型 → Skill 下载校验；本方案不修改该文件。
- `docs/release-acceptance.md`：记录最终真实联调证据。
- `docs/ucli-client-protocol.md`、`docs/ucli-client-registration-upgrade.md`：在完整 smoke 后更新验证状态，不改变合同。

---

### Task 1: Lock and Fix the Server Refresh Cache Contract

**Owner:** UCLI Server

**Files:**

- Modify: `test/auth/device-grant-redeem.test.ts:227`
- Modify: `apps/api/src/auth.controller.ts:19`

**Interfaces:**

- Consumes: `AuthController.refresh(@Body() body)` 和现有 `AuthService.refresh(refreshToken: string)`。
- Produces: `POST /api/v1/auth/token/refresh` 路由元数据包含 `{ name: 'Cache-Control', value: 'no-store' }`；请求体和返回 DTO 不变。

- [ ] **Step 1: 确认两个目标文件没有待保留的重叠改动**

Run:

```powershell
git status --short
git diff -- apps/api/src/auth.controller.ts test/auth/device-grant-redeem.test.ts
```

Expected: 两个目标文件无未提交差异；若存在差异，先将其纳入同一测试语义再继续，不还原用户改动。

- [ ] **Step 2: 写 Refresh 路由缓存策略的失败测试**

在 `describe('public device-grant routes', ...)` 中追加：

```ts
it('exposes refresh as an unguarded no-store route', async () => {
  const auth = { refresh: vi.fn(async () => ({})) }
  const controller = new AuthController(auth as any, {} as any)

  await controller.refresh({ refreshToken: 'opaque-refresh-token' })

  expect(auth.refresh).toHaveBeenCalledWith('opaque-refresh-token')
  expect(Reflect.getMetadata(PATH_METADATA, controller.refresh)).toBe('token/refresh')
  expect(Reflect.getMetadata(METHOD_METADATA, controller.refresh)).toBe(RequestMethod.POST)
  expect(Reflect.getMetadata(GUARDS_METADATA, controller.refresh)).toBeUndefined()
  expect(Reflect.getMetadata(HEADERS_METADATA, controller.refresh)).toContainEqual({
    name: 'Cache-Control',
    value: 'no-store'
  })
})
```

- [ ] **Step 3: 运行测试并确认红灯原因唯一**

Run:

```powershell
npx vitest run test/auth/device-grant-redeem.test.ts
```

Expected: 新测试仅在 `HEADERS_METADATA` 缺少 `Cache-Control: no-store` 处失败；已有 Redeem/Preview 测试继续通过。

- [ ] **Step 4: 为 Refresh 路由补最小实现**

将现有 Refresh handler 改为：

```ts
@Header('Cache-Control', 'no-store') @Post('token/refresh')
refresh(@Body() body: any) { return this.auth.refresh(String(body.refreshToken || '')) }
```

- [ ] **Step 5: 运行目标测试并确认绿灯**

Run:

```powershell
npx vitest run test/auth/device-grant-redeem.test.ts
```

Expected: 文件内全部测试通过，新测试证明 path、method、guard 和 response header 元数据均符合合同。

- [ ] **Step 6: 提交服务端代码修复**

```powershell
git add -- apps/api/src/auth.controller.ts test/auth/device-grant-redeem.test.ts
git commit -m "fix(auth): mark refresh responses no-store"
```

---

### Task 2: Synchronize the Server-Owned Client Contract Documents

**Owner:** UCLI Server

**Files:**

- Modify: `test/auth/device-grant-protocol.test.ts:90`
- Modify: `docs/ucli-client-protocol.md:115`
- Modify: `docs/ucli-client-registration-upgrade.md:182`

**Interfaces:**

- Consumes: Task 1 已实现的 Refresh 路由策略。
- Produces: 服务端交付给客户端的两份文档都明确声明 `Refresh 的成功和错误响应都带 Cache-Control: no-store`，协议测试锁定同一句合同。

- [ ] **Step 1: 保存并阅读当前三份未提交差异**

Run:

```powershell
git diff -- docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md test/auth/device-grant-protocol.test.ts
```

Expected: 完整理解已有文档同步内容；后续只追加 Refresh 缓存策略，不覆盖这些差异。

- [ ] **Step 2: 写文档合同失败测试**

在 `defines exact device validation, preview states, server response cache policy, and stable failures` 测试中追加：

```ts
expect(protocol).toContain('Refresh 的成功和错误响应都带 `Cache-Control: no-store`。')
expect(clientUpgrade).toContain('Refresh 的成功和错误响应都带 `Cache-Control: no-store`。')
```

- [ ] **Step 3: 运行协议测试并确认红灯**

Run:

```powershell
npx vitest run test/auth/device-grant-protocol.test.ts
```

Expected: 两个新增断言因文档缺少精确合同而失败；其他协议断言通过。

- [ ] **Step 4: 在两份服务端文档中追加精确合同**

在 `docs/ucli-client-protocol.md` 的 Refresh 响应示例之后，以及 `docs/ucli-client-registration-upgrade.md` 的 Refresh 成功响应说明处，分别加入：

```markdown
Refresh 的成功和错误响应都带 `Cache-Control: no-store`。
```

- [ ] **Step 5: 运行协议测试并检查 Markdown**

Run:

```powershell
npx vitest run test/auth/device-grant-protocol.test.ts
git diff --check
```

Expected: 协议测试全部通过，`git diff --check` 无错误；已有未提交文档内容仍保留。

- [ ] **Step 6: 提交服务端文档合同**

```powershell
git add -- docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md test/auth/device-grant-protocol.test.ts
git commit -m "docs(protocol): require no-store on refresh"
```

---

### Task 3: Verify, Deploy, and Probe the Server Before Issuing a Link

**Owner:** UCLI Server / 运维

**Files:**

- Verify: `apps/api/src/auth.controller.ts`
- Execute: `scripts/deploy.ps1`
- No source changes in this task.

**Interfaces:**

- Consumes: Task 1–2 的代码、测试和协议提交。
- Produces: 健康的生产 API，以及不使用真实凭证即可验证的线上 Refresh 401 合同证据。

- [ ] **Step 1: 运行服务端发布门**

Run:

```powershell
npm run typecheck
npx vitest run test/auth/device-grant-redeem.test.ts test/auth/device-grant-protocol.test.ts test/auth/device-grant-auth-matrix.test.ts
npm run build
```

Expected: 每条命令退出码为 0，无失败或跳过的目标测试。

- [ ] **Step 2: 记录部署前提交和当前 API 镜像，建立可恢复标签**

Run:

```powershell
$previousCommit = git rev-parse HEAD
$previousImage = docker inspect ucli-prod-api-1 --format '{{.Image}}'
docker image tag $previousImage ucli-prod-api:pre-refresh-no-store
Write-Output "Previous commit: $previousCommit"
Write-Output "Rollback image tag: ucli-prod-api:pre-refresh-no-store"
```

Expected: 得到一个提交哈希，且回滚标签创建成功；输出不含 `.env` 或凭证。

- [ ] **Step 3: 使用仓库标准脚本部署**

Run:

```powershell
powershell -File scripts/deploy.ps1
docker compose -p ucli-prod ps
```

Expected: `ucli-prod-api-1` 和 `ucli-prod-gateway-1` 都显示 healthy；部署不产生数据库迁移，因为本次没有 schema 变更。

- [ ] **Step 4: 用无效占位 token 验证线上错误响应合同**

Run:

```powershell
$probeBody = @{ refreshToken = 'invalid' } | ConvertTo-Json -Compress
$probe = Invoke-WebRequest `
  -Method Post `
  -Uri 'http://10.44.100.100/api/v1/auth/token/refresh' `
  -ContentType 'application/json' `
  -Body $probeBody `
  -SkipHttpErrorCheck
$probeJson = $probe.Content | ConvertFrom-Json
if ($probe.StatusCode -ne 401) { throw "Expected 401, got $($probe.StatusCode)" }
if ($probe.Headers['Cache-Control'] -notmatch '(^|,)\s*no-store\s*(,|$)') { throw 'Refresh response is missing Cache-Control: no-store' }
if ($probe.Headers['Content-Type'] -notmatch '^application/json(?:;|$)') { throw 'Refresh response is not JSON' }
if ($probeJson.code -ne 'invalid_grant') { throw "Expected invalid_grant, got $($probeJson.code)" }
'Refresh error contract: PASS'
```

Expected: 只输出 `Refresh error contract: PASS`；这是创建新授权前的硬门。

- [ ] **Step 5: 在探针或健康检查失败时恢复上一 API 镜像**

仅在 Step 3 或 Step 4 失败时运行：

```powershell
docker image tag ucli-prod-api:pre-refresh-no-store ucli-prod-api:latest
docker compose -p ucli-prod up -d --no-deps --force-recreate api
docker compose -p ucli-prod ps api
```

Expected: API 恢复 healthy。此修复没有 schema/data 变更，因此镜像恢复不伴随数据库恢复；失败原因修正后重新从 Step 1 开始。

---

### Task 4: Run the Complete One-Time Live Smoke

**Owner:** 服务端提供授权并观察服务状态；客户端执行 smoke 并提交脱敏结果。

**Files:**

- Execute: UCLI Client `test/server-integration-smoke.test.mjs`
- Modify after success: UCLI Client `docs/release-acceptance.md`
- Modify after success: UCLI Client `docs/ucli-client-protocol.md`
- Modify after success: UCLI Client `docs/ucli-client-registration-upgrade.md`

**Interfaces:**

- Consumes: 已通过线上探针的 `http://10.44.100.100`、一个新的单次授权、至少一个 Bootstrap 模型和至少一个可下载 Skill 版本。
- Produces: Preview、Redeem、幂等 Redeem、Refresh、Bootstrap、模型 SSE、Skills catalog/download/hash 的单次完整通过证据。

- [ ] **Step 1: 服务端准备联调数据**

服务端在管理端完成以下动作，并只通过受控私聊发送完整链接：

1. 为联调成员创建一个状态为 `AVAILABLE` 的新设备授权。
2. 链接有效期覆盖本次联调窗口，授权未禁用、未过期、未删除。
3. 组织 Bootstrap 至少返回一个模型。
4. Skills catalog 至少返回一个 `ACTIVE` 或 `DEPRECATED` 且可下载的版本，`sizeBytes` 和 SHA-256 与归档一致。
5. 不在工单、群聊、服务端日志或验收文档粘贴链接。

Expected: 客户端收到一个从未 Preview/Redeem 失败重试过的新链接；服务端只记录 grant/device/audit ID。

- [ ] **Step 2: 客户端从链接 fragment 提取 secret，并通过掩码输入运行 smoke**

在 UCLI Client 仓库运行；命令文本不得包含 secret：

```powershell
$env:UCLI_SERVER_SMOKE = '1'
$env:UCLI_SERVER_ORIGIN = 'http://10.44.100.100'
$smokeSecret = Read-Host 'One-time link secret' -AsSecureString
$smokePtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($smokeSecret)
$smokeExit = 1
try {
  $env:UCLI_SERVER_LINK = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($smokePtr)
  node --test test/server-integration-smoke.test.mjs
  $smokeExit = $LASTEXITCODE
} finally {
  Remove-Item Env:UCLI_SERVER_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:UCLI_SERVER_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UCLI_SERVER_ORIGIN -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($smokePtr)
  $smokeSecret.Dispose()
}
if ($smokeExit -ne 0) { throw "Live smoke failed with exit code $smokeExit" }
```

Expected: `tests 1`、`pass 1`、`fail 0`、`skipped 0`。测试内部依次验证 Preview、首次 Redeem、同 installationId 幂等 Redeem、强制 Refresh、Bootstrap、`GET /gateway/v1/models`、最小流式模型请求、Skills catalog、下载和 SHA-256。

- [ ] **Step 3: 验证客户端临时材料已清理**

Run:

```powershell
$leftovers = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ucli-server-smoke-*' -ErrorAction SilentlyContinue)
if ($leftovers.Count -ne 0) { throw "Smoke temp directories remain: $($leftovers.Count)" }
$vars = @(Get-ChildItem Env: | Where-Object Name -Like 'UCLI_SERVER_*')
if ($vars.Count -ne 0) { throw "Smoke environment variables remain: $($vars.Name -join ',')" }
'Smoke cleanup: PASS'
```

Expected: 只输出 `Smoke cleanup: PASS`。

- [ ] **Step 4: 双方核对脱敏联调证据**

服务端确认：

- 同一 installationId 只有一个设备，幂等 Redeem 在十分钟窗口内轮换 token。
- Refresh 只接受最新 token，并完成一次轮换。
- Bootstrap、模型请求和 Skill 下载属于同一组织和设备授权。
- 审计与访问日志不含 link secret、access token、refresh token、请求体或 Authorization header。

客户端只记录：日期、客户端提交、服务端提交/镜像、各阶段 PASS、模型 ID 的脱敏别名、Skill version ID 的脱敏别名和清理 PASS。

- [ ] **Step 5: 更新客户端发布证据并运行发布门**

将三份客户端文档中的“Refresh 缺少 no-store 阻断”更新为完整 smoke 通过，同时保留历史阻断原因与服务端修复提交。然后运行：

```powershell
git diff --check
node --test --test-concurrency=1 test/release-verification.test.mjs test/server-contract-fixtures.test.mjs
npm run verify:release
```

Expected: `git diff --check` 无错误，目标测试零失败，发布校验退出码为 0。

- [ ] **Step 6: 提交客户端联调证据**

```powershell
git add -- docs/release-acceptance.md docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md
git commit -m "docs(release): record complete live server smoke"
```

---

## Joint Acceptance Criteria

全部满足后，服务端联调才算完成：

- 服务端目标测试、类型检查和构建全部通过。
- 线上无效 token Refresh 探针返回 HTTP 401、JSON、`Cache-Control: no-store`、`invalid_grant`。
- 客户端真实 smoke 为 `pass 1 / fail 0 / skipped 0`。
- Preview、首次 Redeem、同 installationId 幂等 Redeem、Refresh、Bootstrap、模型 SSE、Skills catalog/download/hash 全部实际执行。
- 客户端临时目录和环境变量清理通过。
- 服务端审计和访问日志没有 link secret、token、Authorization header 或请求体。
- 两端协议文档均明确 Refresh 成功和错误响应的 `no-store` 合同。
- 客户端发布证据记录服务端修复提交/镜像与联调日期，但不包含任何凭证。

## Failure Handoff Format

任一阶段失败时，服务端与客户端只交换以下字段：

```text
timestamp: ISO-8601 with timezone
clientCommit: short SHA
serverCommitOrImage: short SHA or immutable image ID
stage: preview | redeem | idempotent-redeem | refresh | bootstrap | models | model-stream | skills-catalog | skill-download | cleanup
httpStatus: number or not-received
contentType: media type or not-received
cacheControl: no-store | missing | not-received
stableCode: approved protocol code | null | not-received
retryable: true | false
```

禁止追加 URL fragment、请求/响应正文、token、Authorization、Cookie、数据库密文或底层异常堆栈。
