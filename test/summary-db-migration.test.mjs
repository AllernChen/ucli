import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import initSqlJs from 'sql.js'

import { openDb } from '../electron/persistence/db.js'

const V0115_SUMMARY_REPORTS_DDL = `CREATE TABLE summary_reports (
  id TEXT PRIMARY KEY,
  period_type TEXT NOT NULL CHECK (period_type IN ('day','week','month','quarter','year')),
  period_start INTEGER NOT NULL,
  period_end_exclusive INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','completed','failed','cancelled','interrupted',
    'awaiting_confirmation','skipped_empty'
  )),
  markdown TEXT,
  executor_id TEXT,
  profile_id TEXT,
  model TEXT,
  usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  generation_usage_json TEXT NOT NULL DEFAULT '{}',
  generation_metrics_json TEXT NOT NULL DEFAULT '{}',
  generation_cost_usd REAL,
  prompt_version TEXT,
  source_hash TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('manual','automatic')),
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (period_type, period_start, period_end_exclusive, timezone, version),
  CHECK (period_start < period_end_exclusive),
  CHECK (is_current = 0 OR status = 'completed')
)`

test('existing 0.11.5 summary database gains interactive fields without losing reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-db-'))
  const dbPath = join(root, 'ucli.db')
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run(V0115_SUMMARY_REPORTS_DDL)
  legacy.run(`INSERT INTO summary_reports (
    id, period_type, period_start, period_end_exclusive, timezone, partial,
    version, status, markdown, usage_snapshot_json, coverage_json,
    generation_usage_json, generation_metrics_json, is_current, generated_by,
    created_at, updated_at
  ) VALUES ('legacy-r1', 'week', 1, 2, 'Asia/Shanghai', 0, 1, 'completed',
    '# 摘要', '{}', '{}', '{}', '{}', 1, 'manual', 10, 10)`)
  await writeFile(dbPath, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(dbPath)
  try {
    const columns = db.sql.exec('PRAGMA table_info(summary_reports)')[0].values
      .map(row => row[1])
    for (const column of [
      'execution_mode', 'session_id', 'run_phase', 'artifact_metadata_json',
      'legacy_import_key'
    ]) {
      assert.ok(columns.includes(column), `missing migrated column ${column}`)
    }
    assert.deepEqual(db.getSummaryReport('legacy-r1'), {
      id: 'legacy-r1',
      periodType: 'week',
      periodStart: 1,
      periodEndExclusive: 2,
      timezone: 'Asia/Shanghai',
      partial: false,
      version: 1,
      status: 'completed',
      markdown: '# 摘要',
      executorId: null,
      profileId: null,
      model: null,
      usageSnapshot: {},
      coverage: {},
      generationUsage: {},
      generationMetrics: {},
      generationCostUsd: null,
      promptVersion: null,
      sourceHash: null,
      isCurrent: true,
      generatedBy: 'manual',
      errorText: null,
      executionMode: 'isolated-runner',
      sessionId: null,
      runPhase: null,
      artifactMetadata: {},
      legacyImportKey: null,
      createdAt: 10,
      updatedAt: 10
    })
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

function summaryReport(overrides = {}) {
  return {
    id: 'report-1',
    periodType: 'week',
    periodStart: 100,
    periodEndExclusive: 200,
    timezone: 'Asia/Shanghai',
    partial: false,
    version: 1,
    status: 'completed',
    markdown: '# Previous',
    executorId: 'codex',
    profileId: 'profile-1',
    model: 'gpt-5',
    usageSnapshot: {},
    coverage: {},
    generationUsage: {},
    generationMetrics: {},
    generationCostUsd: null,
    promptVersion: 'summary-v1',
    sourceHash: 'previous-hash',
    isCurrent: false,
    generatedBy: 'manual',
    errorText: null,
    executionMode: 'isolated-runner',
    sessionId: null,
    runPhase: null,
    artifactMetadata: {},
    legacyImportKey: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

test('completing a running report atomically commits markdown and switches current version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-complete-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    db.createSummaryReport(summaryReport({ id: 'week-v1', isCurrent: true }))
    db.createSummaryReport(summaryReport({
      id: 'week-v2', version: 2, status: 'running', markdown: null,
      sourceHash: null, executionMode: 'interactive-cli', sessionId: 'session-2',
      runPhase: 'running'
    }))

    const completed = await db.completeSummaryReport('week-v2', {
      status: 'completed',
      runPhase: 'completed',
      markdown: '# Current',
      sourceHash: 'current-hash',
      usageSnapshot: { inputTokens: 3 },
      coverage: { sessionsIncluded: 1 },
      artifactMetadata: { canonical: 'markdown', bytes: 9, sha256: 'current-hash' },
      errorText: null,
      updatedAt: 2000
    })

    assert.equal(completed.isCurrent, true)
    assert.equal(completed.markdown, '# Current')
    assert.equal(db.getSummaryReport('week-v1').isCurrent, false)

    db.createSummaryReport(summaryReport({
      id: 'week-v3', version: 3, status: 'running', markdown: null,
      sourceHash: null, executionMode: 'interactive-cli', sessionId: 'session-3',
      runPhase: 'running'
    }))
    db.sql.run(`CREATE TRIGGER reject_completed_current
      BEFORE UPDATE OF is_current ON summary_reports
      WHEN NEW.id = 'week-v3' AND NEW.is_current = 1
      BEGIN SELECT RAISE(ABORT, 'complete current switch failed'); END`)

    await assert.rejects(db.completeSummaryReport('week-v3', {
      status: 'completed', runPhase: 'completed', markdown: '# Must Roll Back',
      sourceHash: 'rollback-hash', usageSnapshot: {}, coverage: {},
      artifactMetadata: { canonical: 'markdown', bytes: 16, sha256: 'rollback-hash' },
      errorText: null, updatedAt: 3000
    }), /complete current switch failed/)
    assert.equal(db.getSummaryReport('week-v2').isCurrent, true)
    assert.deepEqual(
      (({ status, markdown, sourceHash, isCurrent }) => ({ status, markdown, sourceHash, isCurrent }))(
        db.getSummaryReport('week-v3')
      ),
      { status: 'running', markdown: null, sourceHash: null, isCurrent: false }
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
