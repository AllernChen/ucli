# Work Summary Markdown Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete real work-summary generation when the model writes all required sections with safe but non-canonical heading levels, without adding another model call.

**Architecture:** Add a pure Markdown canonicalizer that recognizes only the six exact root ATX section headings, shifts their nested headings by the same level delta, and returns canonical Markdown. The existing artifact boundary performs safety checks before and after canonicalization; the job atomically writes changed content back before committing the report. Renderer error presentation consumes a closed safe-code mapping.

**Tech Stack:** Node.js ESM, markdown-it token maps, Electron main-process services, Vue 3, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-work-summary-reliability-layout-design.md`

## Global Constraints

- Do not make a second model call or redeliver a turn for formatting repair.
- Accept only the six exact required root ATX headings in the exact order, each once, with input levels one or two.
- Preserve all existing HTML, credential, local-path, file-containment, UTF-8, size and stability checks.
- Persist and retain only the normalized Markdown; bytes and SHA-256 describe the normalized UTF-8 bytes.
- Unknown error values must remain collapsed to the existing safe fallback.
- Preserve unrelated tracked and untracked user files.

---

### Task 1: Pure Markdown Canonicalizer

**Files:**
- Create: `electron/summaries/summaryMarkdownCanonicalizer.js`
- Create: `test/summary-markdown-canonicalizer.test.mjs`

**Interfaces:**
- Consumes: `createSummaryMarkdownParser({ html: true })` and the literal required heading specification.
- Produces: `canonicalizeInteractiveSummaryMarkdown(markdown) -> { markdown: string, changed: boolean }`; throws an error with code `SUMMARY_ARTIFACT_INVALID` when conversion is ambiguous or unsafe.

- [ ] **Step 1: Write failing canonicalization tests**

Use hand-written input and expected strings; do not derive expectations through `REQUIRED_HEADINGS`:

```js
test('peer h1 sections and their children become canonical hierarchy', () => {
  const source = '# 摘要\n\n概览\n\n# 使用量分析\n\n数据\n\n# 项目进展\n\n## 项目 A\n\n### 已完成\n\n# 跨项目观察\n\n观察\n\n# 下一步建议\n\n建议\n\n# 数据覆盖\n\n完整\n'
  const expected = '# 摘要\n\n概览\n\n## 使用量分析\n\n数据\n\n## 项目进展\n\n### 项目 A\n\n#### 已完成\n\n## 跨项目观察\n\n观察\n\n## 下一步建议\n\n建议\n\n## 数据覆盖\n\n完整\n'

  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(source), {
    markdown: expected,
    changed: true
  })
})

test('canonical headings are byte-for-byte unchanged', () => {
  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(CANONICAL), {
    markdown: CANONICAL,
    changed: false
  })
})
```

Add separate tests for all-H2 input, mixed H1/H2 input, missing/duplicate/out-of-order required headings, required H3, headings inside a fence/blockquote/list, setext headings, and a nested H6 that would overflow after shifting.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node --test test/summary-markdown-canonicalizer.test.mjs
```

Expected: fail with `ERR_MODULE_NOT_FOUND` for `summaryMarkdownCanonicalizer.js`.

- [ ] **Step 3: Implement the minimal pure canonicalizer**

Implement with Markdown token `map` values so fenced, quoted and listed pseudo-headings are not rewritten:

```js
import { createSummaryMarkdownParser } from './summaryMarkdownParser.js'

const TARGETS = Object.freeze([
  Object.freeze({ text: '摘要', level: 1 }),
  Object.freeze({ text: '使用量分析', level: 2 }),
  Object.freeze({ text: '项目进展', level: 2 }),
  Object.freeze({ text: '跨项目观察', level: 2 }),
  Object.freeze({ text: '下一步建议', level: 2 }),
  Object.freeze({ text: '数据覆盖', level: 2 })
])
const parser = createSummaryMarkdownParser({ html: true })

function invalidArtifact() {
  return Object.assign(new Error('Invalid canonical summary artifact'), {
    code: 'SUMMARY_ARTIFACT_INVALID'
  })
}

export function canonicalizeInteractiveSummaryMarkdown(markdown) {
  if (typeof markdown !== 'string') throw invalidArtifact()
  const lines = markdown.split('\n')
  const headings = rootAtxHeadings(parser.parse(markdown, {}), lines)
  const required = matchRequiredHeadings(headings, TARGETS)
  const rewrites = planSectionRewrites(headings, required, TARGETS)
  if (!rewrites.size) return { markdown, changed: false }
  for (const [lineIndex, level] of rewrites) {
    lines[lineIndex] = rewriteAtxMarker(lines[lineIndex], level)
  }
  return { markdown: lines.join('\n'), changed: true }
}
```

`rootAtxHeadings` must require `heading_open.level === 0`, an `h1` or `h2` required heading, a one-line token map, and an ATX source line. `planSectionRewrites` applies each required heading's delta to later non-required headings until the next required heading and rejects a resulting level outside 1–6.

- [ ] **Step 4: Run the canonicalizer tests and verify GREEN**

Run:

```powershell
node --test test/summary-markdown-canonicalizer.test.mjs
```

Expected: all new cases pass with zero skips.

- [ ] **Step 5: Commit the pure boundary**

```powershell
git add electron/summaries/summaryMarkdownCanonicalizer.js test/summary-markdown-canonicalizer.test.mjs
git commit -m "feat: canonicalize work summary markdown headings"
```

---

### Task 2: Artifact Validation Uses Canonical Bytes

**Files:**
- Modify: `electron/summaries/interactiveSummaryArtifact.js:12-25,169-226,251-286`
- Modify: `test/interactive-summary-artifact.test.mjs:8-18,246-321`

**Interfaces:**
- Consumes: `canonicalizeInteractiveSummaryMarkdown(markdown)`.
- Produces: `waitForCanonicalMarkdown({ workspacePath, signal, deadlineMs, onReadChunk }) -> { markdown, bytes, sha256, changed }`, where metadata describes normalized UTF-8 content.

- [ ] **Step 1: Add a failing real-artifact test for the observed Claude output**

Write a test using all-H1 required sections plus nested project headings, write it through the real workspace service, then assert literal normalized Markdown, normalized byte count, normalized SHA-256 and `changed: true`. Extend the existing canonical test with `changed: false`.

Also add one test proving credential material in an all-H1 artifact is rejected before any normalized value is returned.

- [ ] **Step 2: Run the artifact test and verify RED**

Run:

```powershell
node --test test/interactive-summary-artifact.test.mjs
```

Expected: the all-H1 case rejects with `SUMMARY_ARTIFACT_INVALID`, and the canonical case lacks `changed`.

- [ ] **Step 3: Integrate the canonicalizer between safety checks**

Refactor the decoded-content path to use this order:

```js
const sourceMarkdown = decodeMarkdown(buffer)
assertSafeMarkdown(sourceMarkdown, unsafePaths)
const canonical = canonicalizeInteractiveSummaryMarkdown(sourceMarkdown)
assertSafeMarkdown(canonical.markdown, unsafePaths)
assertHeadingOrder(canonical.markdown)
const canonicalBuffer = Buffer.from(canonical.markdown, 'utf8')
return { buffer: canonicalBuffer, markdown: canonical.markdown, changed: canonical.changed }
```

Return metadata from `canonicalBuffer`, not the original file buffer:

```js
return {
  markdown,
  bytes: buffer.byteLength,
  sha256: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
  changed
}
```

- [ ] **Step 4: Run artifact and safety tests and verify GREEN**

Run:

```powershell
node --test test/summary-markdown-canonicalizer.test.mjs test/interactive-summary-artifact.test.mjs test/summary-evidence.test.mjs
```

Expected: all pass; malformed, unsafe and path-containing artifacts remain rejected.

- [ ] **Step 5: Commit the artifact integration**

```powershell
git add electron/summaries/interactiveSummaryArtifact.js test/interactive-summary-artifact.test.mjs
git commit -m "fix: accept safe Claude summary heading variants"
```

---

### Task 3: Atomically Write Back Before Completion

**Files:**
- Modify: `electron/summaries/interactiveSummaryJobService.js:107-116,487-527`
- Modify: `test/interactive-summary-job-service.test.mjs:119-282,377-430`

**Interfaces:**
- Consumes: artifact `{ markdown, bytes, sha256, changed }` and `workspaceService.writeArtifact(reportId, relativePath, content)`.
- Produces: normalized `output/report.md` committed before `repository.complete`; no extra session delivery.

- [ ] **Step 1: Write a failing job integration test**

Extend the real-workspace fixture wrapper to record `workspace.write:output/report.md`. Start one run, have the fake adapter write the observed all-H1 report, emit one completion, and assert:

```js
assert.equal(completed.status, 'completed')
assert.equal(completed.markdown, EXPECTED_CANONICAL)
assert.equal(await readFile(outputPath, 'utf8'), EXPECTED_CANONICAL)
assert.ok(state.order.indexOf('workspace.write:output/report.md') < state.order.indexOf('repository.complete'))
assert.equal(state.fake.deliveries.length, 1)
```

Add a canonical-input case asserting no job-owned writeback occurs.

- [ ] **Step 2: Run the job test and verify RED**

Run:

```powershell
node --test test/interactive-summary-job-service.test.mjs
```

Expected: the all-H1 run fails or completes without the required writeback order.

- [ ] **Step 3: Add the bounded writeback**

Require `workspaceService.writeArtifact` in the constructor. At the start of `finishCompleted`, after the `validating` transition and before `repository.complete`, write only changed artifacts:

```js
if (artifact.changed) {
  await ownedStep(job, () => workspaceService.writeArtifact(
    job.reportId,
    'output/report.md',
    artifact.markdown
  ))
}
```

Do not call `sessionRuntime.deliver`, do not create another timer, and let existing terminal settlement map write failures to a safe code.

- [ ] **Step 4: Run the job, workspace and persistence tests and verify GREEN**

Run:

```powershell
node --test test/interactive-summary-job-service.test.mjs test/summary-workspace.test.mjs test/summary-db-migration.test.mjs test/summary-evidence.test.mjs
```

Expected: normalized workspace and database content match, existing completion and cleanup ordering stays green.

- [ ] **Step 5: Commit the atomic completion change**

```powershell
git add electron/summaries/interactiveSummaryJobService.js test/interactive-summary-job-service.test.mjs
git commit -m "fix: commit normalized summary artifacts atomically"
```

---

### Task 4: Safe Actionable Failure Reasons

**Files:**
- Modify: `shared/summaryTaskContracts.js:1-67`
- Modify: `src/components/summaries/SummaryReportListItem.vue:1-63`
- Modify: `src/components/summaries/SummaryReportView.vue:1-118`
- Modify: `test/summary-task-contracts.test.mjs`
- Modify: `test/summary-view-mounted.test.mjs`

**Interfaces:**
- Produces: `summaryTaskErrorMeta(errorText) -> { code, message, action }` with a closed allowlist and safe fallback.
- Consumes: report `errorText` only; never consumes raw adapter output.

- [ ] **Step 1: Write failing contract and mounted tests**

Assert exact behavior for `SUMMARY_ARTIFACT_INVALID`, `SUMMARY_ARTIFACT_MISSING`, `SUMMARY_TURN_NOT_CONFIRMED`, `SUMMARY_RUN_TIMEOUT`, and an unsafe unknown string. Mount a failed report and assert the specific safe message appears while `C:\\private\\secret` does not.

- [ ] **Step 2: Run focused UI contracts and verify RED**

Run:

```powershell
node --test test/summary-task-contracts.test.mjs test/summary-view-mounted.test.mjs
```

Expected: fail because `summaryTaskErrorMeta` and specific failure rendering do not exist.

- [ ] **Step 3: Implement the closed mapping and render it**

Add a frozen map in `shared/summaryTaskContracts.js` and return the fallback for unknown input:

```js
export function summaryTaskErrorMeta(errorText) {
  return ERROR_META[errorText] || ERROR_META.SUMMARY_RUN_FAILED
}
```

Use the mapped message/action in the failed task description and detail alert. Render the safe code only when it is a key in the closed map.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/summary-task-contracts.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs
```

Expected: all pass; unknown raw error text is absent from rendered output.

- [ ] **Step 5: Commit safe failure presentation**

```powershell
git add shared/summaryTaskContracts.js src/components/summaries/SummaryReportListItem.vue src/components/summaries/SummaryReportView.vue test/summary-task-contracts.test.mjs test/summary-view-mounted.test.mjs
git commit -m "feat: explain work summary failures safely"
```

---

### Task 5: Reliability Verification Gate

**Files:**
- Review: all files changed by Tasks 1–4

**Interfaces:**
- Produces: an automated reliability checkpoint ready for one real Claude rerun.

- [ ] **Step 1: Run focused summary and Claude tests**

```powershell
node --test test/summary-markdown-canonicalizer.test.mjs test/interactive-summary-artifact.test.mjs test/interactive-summary-job-service.test.mjs test/summary-task-contracts.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs test/claude-gateway-capabilities.test.mjs test/claude-turn-delivery.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run production build and diff checks**

```powershell
npm run build
git diff --check
git status --short
```

Expected: build succeeds; no whitespace errors; only intended tracked changes and pre-existing untracked user files are present.

- [ ] **Step 3: Run one real Claude report before starting layout work**

Start the development app and generate the next weekly version without refreshing. Expected sequence: preparing → starting → awaiting-delivery → running → validating → completed. Confirm the database report, retained `output/report.md`, bytes and hash describe the normalized Markdown. If it fails, stop and return to diagnosis; do not proceed to installed-app acceptance.
