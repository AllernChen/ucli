import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync
} from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'

const USAGE_MODEL_KEY_PREFIX = 'model:'
const USAGE_SESSION_TOTAL_KEY = '__ucli_internal__:session-total'

/**
 * SQLite-backed persistence via sql.js (pure WASM, zero native compilation).
 *
 * Writes are done in-memory then flushed to disk periodically (debounced 5 s)
 * because sql.js exports/imports the *entire database* as a single blob.
 * For our tiny dataset (tens of sessions, KB of metadata) this is perfectly
 * fine and avoids node-gyp / MSVC / Python dependencies.
 *
 *  ┌──────────┐   run / exec    ┌──────────────┐   flush (5s debounce)   ┌──────┐
 *  │ main.js   │ ───────────────▶│  in-memory   │ ───────────────────────▶│ disk │
 *  │ renderer  │                 │  sql.js DB   │                         │ .db  │
 *  └──────────┘                  └──────────────┘                         └──────┘
 */

/** @type {import('sql.js').SqlJsStatic} */
let SQL = null

/**
 * Open (or create) the database at `dbPath`. Must be awaited once before any
 * other `getDb()` call.
 */
export async function openDb(dbPath, { deferUsageLedgerInitialization = false } = {}) {
  if (!SQL) {
    try {
      const init = await import('sql.js')
      const initFn = init.default || init
      SQL = await initFn()
    } catch (err) {
      console.error('Failed to load sql.js WASM — persistence disabled:', err.message)
      SQL = null // prevent retry
    }
  }
  if (!SQL) return null // sql.js not available, app runs without persistence
  let buffer
  if (existsSync(dbPath)) {
    buffer = readFileSync(dbPath)
  }
  let instance
  try {
    instance = new SQL.Database(buffer)
    const db = new Db(instance, dbPath)
    db._ensureSchema({ initializeUsageLedger: !deferUsageLedgerInitialization })
    _db = db
    return db
  } catch (error) {
    try { instance?.close() } catch { /* invalid database, best effort */ }
    if (!buffer || !isInvalidDatabaseError(error)) throw error

    const backupPath = quarantineInvalidDatabase(dbPath)
    const lastValidBackupPath = `${dbPath}.bak`
    let restoredFromBackup = false
    let db = null

    if (existsSync(lastValidBackupPath)) {
      try {
        instance = new SQL.Database(readFileSync(lastValidBackupPath))
        db = new Db(instance, dbPath)
        db._ensureSchema({ initializeUsageLedger: !deferUsageLedgerInitialization })
        restoredFromBackup = true
      } catch {
        try { instance?.close() } catch { /* unusable backup, best effort */ }
        instance = null
        db = null
      }
    }

    if (!db) {
      instance = new SQL.Database()
      db = new Db(instance, dbPath)
      db._ensureSchema({ initializeUsageLedger: !deferUsageLedgerInitialization })
    }
    db.recoveryInfo = { reason: 'invalid-database', backupPath, restoredFromBackup }
    _db = db
    return db
  }
}

function isInvalidDatabaseError(error) {
  return /file is not a database|database disk image is malformed|malformed database schema/i
    .test(error?.message || '')
}

function quarantineInvalidDatabase(dbPath) {
  let backupPath = `${dbPath}.corrupt-${Date.now()}.bak`
  let suffix = 1
  while (existsSync(backupPath)) {
    backupPath = `${dbPath}.corrupt-${Date.now()}-${suffix}.bak`
    suffix += 1
  }
  renameSync(dbPath, backupPath)
  return backupPath
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0')

function hasSqliteHeader(data) {
  return data.length >= SQLITE_HEADER.length && data.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
}

function replaceFileAtomically(targetPath, data) {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  let handle = null
  try {
    handle = openSync(tempPath, 'wx')
    let offset = 0
    while (offset < data.length) {
      offset += writeSync(handle, data, offset, data.length - offset)
    }
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    renameSync(tempPath, targetPath)
  } finally {
    if (handle !== null) {
      try { closeSync(handle) } catch { /* best effort */ }
    }
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best effort */ }
  }
}

// singleton — set by orchestrator after openDb
let _db = null
export function getDb() { return _db }

class Db {
  constructor(sql, path, recoveryInfo = null) {
    this.sql = sql
    this.path = path
    this.recoveryInfo = recoveryInfo
    this._transactionTail = Promise.resolve()
  }

  // ---- schema ----
  _ensureSchema({ initializeUsageLedger = true } = {}) {
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS projects (
        path        TEXT PRIMARY KEY,
        name        TEXT,
        last_opened INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        project_path      TEXT NOT NULL,
        adapter_id        TEXT NOT NULL,
        native_session_id TEXT,
        name              TEXT,
        task_note         TEXT DEFAULT '',
        tier              TEXT NOT NULL DEFAULT 'safety-rules',
        model             TEXT,
        system_model      TEXT,
        provider          TEXT,
        source_provider   TEXT,
        provider_policy   TEXT,
        explicit_provider TEXT,
        profile_id        TEXT,
        adapter_config_json TEXT NOT NULL DEFAULT '{}',
        status            TEXT DEFAULT 'offline',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `)
    // Existing 0.1.0 databases do not have this column. Keep the migration
    // additive so removed sessions can retain their audit and usage history.
    const sessionColumns = rows(this.sql.exec('PRAGMA table_info(sessions)'))
    if (!sessionColumns.some((column) => column.name === 'removed_at')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN removed_at INTEGER')
    }
    if (!sessionColumns.some((column) => column.name === 'provider')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN provider TEXT')
    }
    if (!sessionColumns.some((column) => column.name === 'source_provider')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN source_provider TEXT')
    }
    if (!sessionColumns.some((column) => column.name === 'provider_policy')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN provider_policy TEXT')
    }
    if (!sessionColumns.some((column) => column.name === 'explicit_provider')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN explicit_provider TEXT')
    }
    if (!sessionColumns.some((column) => column.name === 'profile_id')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN profile_id TEXT')
    }
    if (!sessionColumns.some((column) => column.name === 'adapter_config_json')) {
      this.sql.run("ALTER TABLE sessions ADD COLUMN adapter_config_json TEXT NOT NULL DEFAULT '{}'")
    }
    if (!sessionColumns.some((column) => column.name === 'system_model')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN system_model TEXT')
      this.sql.run('UPDATE sessions SET system_model = model')
    }
    // In pre-0.7 records, a stored Codex provider means the session was
    // imported/resumed; fresh UCLI sessions did not store a provider override.
    this.sql.run(`
      UPDATE sessions
      SET provider_policy = CASE
        WHEN adapter_id = 'codex' AND provider IS NOT NULL THEN 'source'
        WHEN adapter_id = 'codex' THEN 'live'
        ELSE NULL
      END
      WHERE provider_policy IS NULL
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS session_stats (
        session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd      REAL DEFAULT 0,
        cost_available INTEGER NOT NULL DEFAULT 1,
        turns_count   INTEGER DEFAULT 0,
        auto_allowed  INTEGER DEFAULT 0,
        confirmed     INTEGER DEFAULT 0,
        denied        INTEGER DEFAULT 0
      )
    `)
    // Cost was historically stored as a number only. Keep old records as
    // available so upgrading does not silently rewrite their semantics.
    const sessionStatsColumns = rows(this.sql.exec('PRAGMA table_info(session_stats)'))
    if (!sessionStatsColumns.some((column) => column.name === 'cost_available')) {
      this.sql.run('ALTER TABLE session_stats ADD COLUMN cost_available INTEGER NOT NULL DEFAULT 1')
    }
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS model_stats (
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model         TEXT NOT NULL,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd      REAL DEFAULT 0,
        cost_available INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, model)
      )
    `)
    const modelStatsColumns = rows(this.sql.exec('PRAGMA table_info(model_stats)'))
    if (!modelStatsColumns.some((column) => column.name === 'cost_available')) {
      this.sql.run('ALTER TABLE model_stats ADD COLUMN cost_available INTEGER NOT NULL DEFAULT 1')
    }
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS rules (
        id      TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        config  TEXT NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS gateway_secrets (
        key        TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS gateway_session_routes (
        session_id          TEXT PRIMARY KEY,
        relay_enabled       INTEGER NOT NULL DEFAULT 0,
        channel_fingerprint TEXT,
        target_id           TEXT,
        root_message_id     TEXT,
        root_thread_id      TEXT,
        route_status        TEXT NOT NULL DEFAULT 'waiting',
        updated_at          INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS gateway_message_routes (
        message_id          TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        relay_task_id       TEXT,
        decision_id         TEXT,
        route_kind          TEXT NOT NULL,
        channel_fingerprint TEXT NOT NULL,
        active              INTEGER NOT NULL DEFAULT 1,
        created_at          INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS gateway_decision_audit (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        kind        TEXT NOT NULL,
        verdict     TEXT NOT NULL,
        source      TEXT NOT NULL,
        resolved_at INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS ai_cli_profiles (
        id                  TEXT PRIMARY KEY,
        adapter_id          TEXT NOT NULL,
        name                TEXT NOT NULL,
        kind                TEXT NOT NULL,
        native_profile_name TEXT UNIQUE,
        provider_id         TEXT,
        base_url            TEXT,
        model               TEXT,
        reasoning_effort    TEXT,
        context_window      INTEGER,
        config_json         TEXT NOT NULL DEFAULT '{}',
        has_secret_hint     INTEGER NOT NULL DEFAULT 0,
        file_sha256         TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS ai_cli_profile_bindings (
        scope_type TEXT NOT NULL,
        scope_key  TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        profile_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_key, adapter_id)
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS ai_cli_profile_revisions (
        id          TEXT PRIMARY KEY,
        profile_id  TEXT NOT NULL,
        config_json TEXT NOT NULL,
        file_sha256 TEXT,
        reason      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS ai_cli_profile_secrets (
        profile_id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS skill_packages (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        description       TEXT NOT NULL,
        source_type       TEXT NOT NULL,
        source_locator    TEXT NOT NULL,
        source_ref        TEXT,
        source_ref_type   TEXT NOT NULL DEFAULT 'default',
        source_subdir     TEXT,
        resolved_revision TEXT,
        manifest_json     TEXT NOT NULL DEFAULT '{}',
        content_sha256    TEXT NOT NULL,
        last_checked_at   INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `)
    const skillPackageColumns = rows(this.sql.exec('PRAGMA table_info(skill_packages)'))
    if (!skillPackageColumns.some((column) => column.name === 'source_ref_type')) {
      this.sql.run("ALTER TABLE skill_packages ADD COLUMN source_ref_type TEXT NOT NULL DEFAULT 'default'")
    }
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS skill_installations (
        id                TEXT PRIMARY KEY,
        package_id        TEXT NOT NULL,
        target_adapter_id TEXT NOT NULL,
        scope_type        TEXT NOT NULL,
        scope_key         TEXT NOT NULL,
        target_path       TEXT NOT NULL UNIQUE,
        enabled           INTEGER NOT NULL DEFAULT 1,
        deployed_sha256   TEXT,
        status            TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS usage_checkpoints (
        session_id          TEXT NOT NULL,
        scope               TEXT NOT NULL CHECK (scope IN ('session', 'model')),
        model_key           TEXT NOT NULL,
        project_path        TEXT,
        adapter_id          TEXT NOT NULL,
        observed_at         INTEGER NOT NULL,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        cost_usd            REAL,
        cost_available      INTEGER NOT NULL DEFAULT 0,
        turns               INTEGER NOT NULL DEFAULT 0,
        legacy_input_tokens INTEGER NOT NULL DEFAULT 0,
        legacy_output_tokens INTEGER NOT NULL DEFAULT 0,
        legacy_cost_usd     REAL,
        legacy_cost_available INTEGER NOT NULL DEFAULT 0,
        legacy_turns        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, scope, model_key)
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        scope          TEXT NOT NULL CHECK (scope IN ('session', 'model', 'approval')),
        project_path   TEXT,
        adapter_id     TEXT NOT NULL,
        model          TEXT,
        observed_at    INTEGER NOT NULL,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd       REAL,
        cost_available INTEGER NOT NULL DEFAULT 0,
        turns          INTEGER NOT NULL DEFAULT 0,
        approvals      INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.sql.run('CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(observed_at)')
    this.sql.run('CREATE INDEX IF NOT EXISTS idx_usage_events_project_time ON usage_events(project_path, observed_at)')
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS summary_reports (
        id                    TEXT PRIMARY KEY,
        period_type           TEXT NOT NULL CHECK (period_type IN ('day', 'week', 'month', 'quarter', 'year')),
        period_start          INTEGER NOT NULL,
        period_end_exclusive  INTEGER NOT NULL,
        timezone              TEXT NOT NULL CHECK (length(trim(timezone)) > 0),
        partial               INTEGER NOT NULL DEFAULT 0,
        version               INTEGER NOT NULL CHECK (version >= 1),
        status                TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
          'awaiting_confirmation', 'skipped_empty'
        )),
        markdown              TEXT,
        executor_id           TEXT,
        profile_id            TEXT,
        model                 TEXT,
        usage_snapshot_json   TEXT NOT NULL DEFAULT '{}',
        coverage_json         TEXT NOT NULL DEFAULT '{}',
        generation_usage_json TEXT NOT NULL DEFAULT '{}',
        generation_metrics_json TEXT NOT NULL DEFAULT '{}',
        generation_cost_usd   REAL,
        prompt_version        TEXT,
        source_hash           TEXT,
        is_current            INTEGER NOT NULL DEFAULT 0,
        generated_by          TEXT NOT NULL CHECK (generated_by IN ('manual', 'automatic')),
        error_text            TEXT,
        execution_mode        TEXT NOT NULL DEFAULT 'isolated-runner' CHECK (execution_mode IN (
          'isolated-runner', 'interactive-cli', 'legacy-worklog-import'
        )),
        session_id            TEXT,
        run_phase             TEXT CHECK (run_phase IS NULL OR run_phase IN (
          'preparing', 'starting', 'awaiting-delivery', 'running', 'validating',
          'completed', 'failed', 'interrupted', 'cancelled'
        )),
        artifact_metadata_json TEXT NOT NULL DEFAULT '{}',
        legacy_import_key     TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        UNIQUE (period_type, period_start, period_end_exclusive, timezone, version),
        CHECK (period_start < period_end_exclusive),
        CHECK (is_current = 0 OR status = 'completed')
      )
    `)
    const summaryReportColumns = rows(this.sql.exec('PRAGMA table_info(summary_reports)'))
    if (!summaryReportColumns.some((column) => column.name === 'generation_metrics_json')) {
      this.sql.run("ALTER TABLE summary_reports ADD COLUMN generation_metrics_json TEXT NOT NULL DEFAULT '{}'")
    }
    for (const [column, ddl] of [
      ['execution_mode', `ALTER TABLE summary_reports ADD COLUMN execution_mode TEXT NOT NULL
        DEFAULT 'isolated-runner' CHECK (execution_mode IN (
          'isolated-runner', 'interactive-cli', 'legacy-worklog-import'
        ))`],
      ['session_id', 'ALTER TABLE summary_reports ADD COLUMN session_id TEXT'],
      ['run_phase', `ALTER TABLE summary_reports ADD COLUMN run_phase TEXT CHECK (
        run_phase IS NULL OR run_phase IN (
          'preparing', 'starting', 'awaiting-delivery', 'running', 'validating',
          'completed', 'failed', 'interrupted', 'cancelled'
        ))`],
      ['artifact_metadata_json', `ALTER TABLE summary_reports ADD COLUMN
        artifact_metadata_json TEXT NOT NULL DEFAULT '{}'`],
      ['legacy_import_key', 'ALTER TABLE summary_reports ADD COLUMN legacy_import_key TEXT']
    ]) {
      if (!summaryReportColumns.some((candidate) => candidate.name === column)) {
        this.sql.run(ddl)
      }
    }
    this.sql.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_reports_current
      ON summary_reports(period_type, period_start, period_end_exclusive, timezone)
      WHERE is_current = 1
    `)
    this.sql.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_reports_legacy_import
      ON summary_reports(legacy_import_key)
      WHERE legacy_import_key IS NOT NULL
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS summary_settings (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at    INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS summary_cache_entries (
        cache_key       TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK(kind IN ('map', 'project', 'final')),
        relative_path   TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL CHECK(size_bytes >= 0),
        created_at      INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        expires_at      INTEGER
      )
    `)
    if (initializeUsageLedger) this.initializeUsageLedgerAfterLegacyImport()
  }

  initializeUsageLedgerAfterLegacyImport() {
    const existing = rows(this.sql.exec(
      "SELECT value FROM settings WHERE key = 'usage.ledger'"
    ))[0]
    if (existing) return this.getUsageLedgerMetadata()

    const ledgerStartedAt = Date.now()
    this.sql.run('BEGIN IMMEDIATE')
    try {
      this.sql.run(
        `INSERT OR IGNORE INTO usage_checkpoints (
           session_id, scope, model_key, project_path, adapter_id, observed_at,
           input_tokens, output_tokens, cost_usd, cost_available, turns,
           legacy_input_tokens, legacy_output_tokens, legacy_cost_usd,
           legacy_cost_available, legacy_turns
         )
         SELECT
           ms.session_id, 'model', ? || ms.model, s.project_path, s.adapter_id, ?,
           COALESCE(ms.input_tokens, 0), COALESCE(ms.output_tokens, 0),
           CASE WHEN ms.cost_available = 1 THEN COALESCE(ms.cost_usd, 0) ELSE NULL END,
           COALESCE(ms.cost_available, 0), 0,
           0, 0, 0, 1, 0
         FROM model_stats ms
         JOIN sessions s ON s.id = ms.session_id`,
        [USAGE_MODEL_KEY_PREFIX, ledgerStartedAt]
      )
      this.sql.run(
        `INSERT OR IGNORE INTO usage_checkpoints (
           session_id, scope, model_key, project_path, adapter_id, observed_at,
           input_tokens, output_tokens, cost_usd, cost_available, turns,
           legacy_input_tokens, legacy_output_tokens, legacy_cost_usd,
           legacy_cost_available, legacy_turns
         )
         SELECT
           st.session_id, 'session', ?, s.project_path, s.adapter_id, ?,
           COALESCE(st.input_tokens, 0), COALESCE(st.output_tokens, 0),
           CASE WHEN st.cost_available = 1 THEN COALESCE(st.cost_usd, 0) ELSE NULL END,
           COALESCE(st.cost_available, 0), COALESCE(st.turns_count, 0),
           COALESCE(st.input_tokens, 0), COALESCE(st.output_tokens, 0),
           CASE WHEN st.cost_available = 1 THEN COALESCE(st.cost_usd, 0) ELSE NULL END,
           COALESCE(st.cost_available, 0),
           COALESCE(st.turns_count, 0)
         FROM session_stats st
         JOIN sessions s ON s.id = st.session_id`,
        [USAGE_SESSION_TOTAL_KEY, ledgerStartedAt]
      )
      this.sql.run(
        'INSERT INTO settings (key, value) VALUES (?, ?)',
        ['usage.ledger', JSON.stringify({ ledgerStartedAt, exactSince: ledgerStartedAt })]
      )
      this.sql.run('COMMIT')
      return this.getUsageLedgerMetadata()
    } catch (error) {
      try { this.sql.run('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  }

  // ---- projects ----
  touchProject(path, name) {
    this.sql.run(
      `INSERT INTO projects (path, name, last_opened) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened = excluded.last_opened`,
      [path, name, Date.now()]
    )
  }

  listProjects() {
    const r = this.sql.exec('SELECT * FROM projects ORDER BY last_opened DESC')
    return rows(r)
  }

  // ---- sessions ----
  insertSession(s) {
    this.sql.run(
      `INSERT INTO sessions (id, project_path, adapter_id, native_session_id, name, task_note, tier, model, system_model, provider, source_provider, provider_policy, explicit_provider, profile_id, adapter_config_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.project_path, s.adapter_id, s.native_session_id || null, s.name || null,
       s.task_note || '', s.tier, s.model || null,
       Object.hasOwn(s, 'system_model') ? (s.system_model || null) : (s.model || null),
       s.provider || null, s.source_provider || null, s.provider_policy || null, s.explicit_provider || null,
       s.profile_id || null, s.adapter_config_json || '{}', s.status, s.created_at, Date.now()]
    )
    this.sql.run(
      `INSERT OR IGNORE INTO session_stats (session_id) VALUES (?)`, [s.id]
    )
  }

  updateSession(sessionId, fields) {
    const allowed = ['native_session_id', 'name', 'task_note', 'status', 'model', 'system_model', 'provider', 'source_provider', 'provider_policy', 'explicit_provider', 'profile_id', 'adapter_config_json']
    const sets = []
    const vals = []
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]) }
    }
    if (!sets.length) return
    sets.push('updated_at=?'); vals.push(Date.now()); vals.push(sessionId)
    this.sql.run(`UPDATE sessions SET ${sets.join(',')} WHERE id=?`, vals)
  }

  removeSession(id) {
    this.sql.run(
      "UPDATE sessions SET status='removed', removed_at=?, updated_at=? WHERE id=?",
      [Date.now(), Date.now(), id]
    )
    this.deactivateGatewayRoutesForSession(id)
  }

  listSessions({ includeRemoved = false } = {}) {
    const where = includeRemoved ? '' : 'WHERE s.removed_at IS NULL'
    const r = this.sql.exec(
      `SELECT s.*,
              st.input_tokens, st.output_tokens, st.cost_usd, st.cost_available, st.turns_count,
              st.auto_allowed, st.confirmed, st.denied
       FROM sessions s
       LEFT JOIN session_stats st ON st.session_id = s.id
       ${where}
       ORDER BY s.updated_at DESC`
    )
    return rows(r).map(rowToSession)
  }

  countSessions({ includeRemoved = false } = {}) {
    const where = includeRemoved ? '' : 'WHERE removed_at IS NULL'
    const r = this.sql.exec(`SELECT COUNT(*) AS n FROM sessions ${where}`)
    const row = rows(r)[0]
    return row ? Number(row.n) || 0 : 0
  }

  getSession(id) {
    const r = this.sql.exec(
      `SELECT s.*,
              st.input_tokens, st.output_tokens, st.cost_usd, st.cost_available, st.turns_count,
              st.auto_allowed, st.confirmed, st.denied
       FROM sessions s
       LEFT JOIN session_stats st ON st.session_id = s.id
       WHERE s.id = ?`, [id]
    )
    const list = rows(r).map(rowToSession)
    return list[0] || null
  }

  // ---- session stats ----
  upsertStats(sessionId, stats) {
    // Callers pass CUMULATIVE values (e.stats from transcript extraction,
    // approval counts from onDecision), not deltas. Use absolute-value
    // semantics to avoid double-counting on repeated calls.
    this.sql.run(
      `INSERT INTO session_stats (session_id, input_tokens, output_tokens, cost_usd, cost_available, turns_count, auto_allowed, confirmed, denied)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens  = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cost_usd      = excluded.cost_usd,
         cost_available = excluded.cost_available,
         turns_count   = excluded.turns_count,
         auto_allowed  = excluded.auto_allowed,
         confirmed     = excluded.confirmed,
         denied        = excluded.denied`,
      [sessionId, stats.inputTokens || 0, stats.outputTokens || 0, stats.costUsd ?? 0, stats.costAvailable === false ? 0 : 1,
       stats.turnsDelta || 0, stats.autoAllowed || 0, stats.confirmed || 0, stats.denied || 0]
    )
  }

  // ---- per-model stats ----
  upsertModelStats(sessionId, model, stats) {
    // Caller (_extractStats) passes CUMULATIVE totals from the full transcript,
    // not deltas. Use absolute-value semantics to avoid double-counting on
    // repeated extractions.
    this.sql.run(
      `INSERT INTO model_stats (session_id, model, input_tokens, output_tokens, cost_usd, cost_available)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id, model) DO UPDATE SET
         input_tokens  = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cost_usd      = excluded.cost_usd,
         cost_available = excluded.cost_available`,
      [sessionId, model, stats.inputTokens || 0, stats.outputTokens || 0, stats.costUsd ?? 0, stats.costAvailable === false ? 0 : 1]
    )
  }

  getModelStats() {
    const r = this.sql.exec(
      `SELECT model,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(CASE WHEN cost_available = 1 THEN cost_usd ELSE 0 END) AS cost_usd,
              SUM(CASE WHEN cost_available = 0 THEN 1 ELSE 0 END) AS cost_unavailable_count,
              COUNT(DISTINCT session_id) AS session_count
       FROM model_stats
       GROUP BY model
       ORDER BY input_tokens DESC`
    )
    return rows(r)
  }

  listModelStatsRows() {
    return rows(this.sql.exec(
      'SELECT session_id, model, input_tokens, output_tokens, cost_usd, cost_available FROM model_stats'
    ))
  }

  getModelStatsForSession(sessionId) {
    const r = this.sql.exec(
      'SELECT model, input_tokens, output_tokens, cost_usd, cost_available FROM model_stats WHERE session_id=?', [sessionId]
    )
    return rows(r)
  }

  /** Full aggregate for the stats dashboard. */
  getStats() {
    const r = this.sql.exec(
      `SELECT s.project_path, s.adapter_id,
              SUM(st.input_tokens)  AS input_tokens,
              SUM(st.output_tokens) AS output_tokens,
              SUM(CASE WHEN st.cost_available = 1 THEN st.cost_usd ELSE 0 END) AS cost_usd,
              SUM(CASE WHEN st.cost_available = 0 THEN 1 ELSE 0 END) AS cost_unavailable_count,
              SUM(st.turns_count)   AS turns_count,
              SUM(st.auto_allowed)  AS auto_allowed,
              SUM(st.confirmed)     AS confirmed,
              SUM(st.denied)        AS denied
       FROM session_stats st
       JOIN sessions s ON s.id = st.session_id
       GROUP BY s.project_path, s.adapter_id`,
    )
    return rows(r)
  }

  // ---- exact post-upgrade usage ledger ----
  async observeUsage(snapshot) {
    assertUsageObservationScope(snapshot)
    return this.transaction(async () => {
      const modelKey = snapshot.scope === 'session'
        ? USAGE_SESSION_TOTAL_KEY
        : `${USAGE_MODEL_KEY_PREFIX}${snapshot.model}`
      let existing = rows(this.sql.exec(
        'SELECT * FROM usage_checkpoints WHERE session_id = ? AND scope = ? AND model_key = ?',
        [snapshot.sessionId, snapshot.scope, modelKey]
      ))[0]
      if (!existing) {
        const metadata = this.getUsageLedgerMetadata()
        if (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt < metadata.exactSince) {
          return { baseline: false, ignored: true, event: null }
        }
        const startsWithKnownCost = isKnownUsageCost(snapshot)
        this.sql.run(
          `INSERT INTO usage_checkpoints (
             session_id, scope, model_key, project_path, adapter_id, observed_at,
             input_tokens, output_tokens, cost_usd, cost_available, turns,
             legacy_input_tokens, legacy_output_tokens, legacy_cost_usd,
             legacy_cost_available, legacy_turns
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshot.sessionId, snapshot.scope, modelKey, snapshot.projectPath || null, snapshot.adapterId,
            metadata.exactSince, 0, 0, startsWithKnownCost ? 0 : null,
            startsWithKnownCost ? 1 : 0, 0,
            0, 0, startsWithKnownCost ? 0 : null, startsWithKnownCost ? 1 : 0, 0
          ]
        )
        existing = {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: startsWithKnownCost ? 0 : null,
          cost_available: startsWithKnownCost ? 1 : 0,
          turns: 0,
          observed_at: metadata.exactSince
        }
      }

      const next = {
        inputTokens: usageCounter(snapshot.inputTokens),
        outputTokens: usageCounter(snapshot.outputTokens),
        costUsd: isKnownUsageCost(snapshot) ? snapshot.costUsd : null,
        costAvailable: isKnownUsageCost(snapshot),
        turns: usageCounter(snapshot.turns)
      }
      const countersRegressed = next.inputTokens < existing.input_tokens ||
        next.outputTokens < existing.output_tokens ||
        next.turns < existing.turns ||
        (next.costAvailable && existing.cost_available === 1 && next.costUsd < existing.cost_usd)

      if (snapshot.observedAt < existing.observed_at ||
        (snapshot.observedAt === existing.observed_at && countersRegressed)) {
        return { baseline: false, ignored: true, event: null }
      }

      if (countersRegressed) {
        this._updateUsageCheckpoint(snapshot, modelKey, next)
        return { baseline: false, reset: true, event: null }
      }

      const event = {
        id: usageObservationId(snapshot, modelKey, next),
        sessionId: snapshot.sessionId,
        scope: snapshot.scope,
        projectPath: snapshot.projectPath || null,
        adapterId: snapshot.adapterId,
        model: snapshot.scope === 'model' ? snapshot.model : null,
        observedAt: snapshot.observedAt,
        inputTokens: next.inputTokens - existing.input_tokens,
        outputTokens: next.outputTokens - existing.output_tokens,
        costUsd: next.costAvailable && existing.cost_available === 1
          ? normalizeCost(next.costUsd - existing.cost_usd)
          : null,
        costAvailable: next.costAvailable && existing.cost_available === 1,
        turns: next.turns - existing.turns,
        approvals: 0
      }
      const hasDelta = event.inputTokens > 0 || event.outputTokens > 0 ||
        event.turns > 0 || (event.costAvailable && event.costUsd > 0)
      if (hasDelta) {
        this.sql.run(
          `INSERT OR IGNORE INTO usage_events (
             id, session_id, scope, project_path, adapter_id, model, observed_at,
             input_tokens, output_tokens, cost_usd, cost_available, turns, approvals
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.id, event.sessionId, event.scope, event.projectPath, event.adapterId, event.model,
            event.observedAt, event.inputTokens, event.outputTokens, event.costUsd,
            event.costAvailable ? 1 : 0, event.turns, 0
          ]
        )
      }
      this._updateUsageCheckpoint(snapshot, modelKey, next)
      return { baseline: false, event: hasDelta ? event : null }
    })
  }

  getUsageLedgerMetadata() {
    const raw = rows(this.sql.exec(
      "SELECT value FROM settings WHERE key = 'usage.ledger'"
    ))[0]?.value
    const parsed = parseJsonObject(raw)
    return {
      ledgerStartedAt: parsed.ledgerStartedAt,
      exactSince: parsed.exactSince
    }
  }

  _updateUsageCheckpoint(snapshot, modelKey, next) {
    this.sql.run(
      `UPDATE usage_checkpoints SET
         project_path = ?, adapter_id = ?, observed_at = ?, input_tokens = ?,
         output_tokens = ?, cost_usd = ?, cost_available = ?, turns = ?
       WHERE session_id = ? AND scope = ? AND model_key = ?`,
      [
        snapshot.projectPath || null, snapshot.adapterId, snapshot.observedAt,
        next.inputTokens, next.outputTokens, next.costUsd, next.costAvailable ? 1 : 0,
        next.turns, snapshot.sessionId, snapshot.scope, modelKey
      ]
    )
  }

  recordApproval(approval) {
    const approvalId = typeof (approval?.approvalId || approval?.id) === 'string'
      ? (approval.approvalId || approval.id).trim()
      : ''
    if (!approvalId) {
      throw Object.assign(new TypeError('A stable approval ID is required'), {
        code: 'INVALID_APPROVAL_ID'
      })
    }
    const id = createHash('sha256').update(JSON.stringify([
      'approval', approval.sessionId, approvalId, approval.adapterId
    ])).digest('hex')
    this.sql.run(
      `INSERT OR IGNORE INTO usage_events (
         id, session_id, scope, project_path, adapter_id, model, observed_at,
         input_tokens, output_tokens, cost_usd, cost_available, turns, approvals
       ) VALUES (?, ?, 'approval', ?, ?, ?, ?, 0, 0, NULL, 0, 0, 1)`,
      [
        id, approval.sessionId, approval.projectPath || null, approval.adapterId,
        approval.model || null, approval.observedAt
      ]
    )
    return rows(this.sql.exec('SELECT * FROM usage_events WHERE id = ?', [id]))
      .map(rowToUsageEvent)[0]
  }

  queryUsageEvents(filters = {}) {
    const conditions = []
    const values = []
    if (Number.isFinite(filters.start)) {
      conditions.push('observed_at >= ?')
      values.push(filters.start)
    }
    if (Number.isFinite(filters.endExclusive)) {
      conditions.push('observed_at < ?')
      values.push(filters.endExclusive)
    }
    appendSqlListFilter(conditions, values, 'project_path', filters.projectPaths)
    appendSqlListFilter(conditions, values, 'adapter_id', filters.adapterIds)
    appendSqlListFilter(conditions, values, 'model', filters.models)
    appendSqlListFilter(conditions, values, 'session_id', filters.sessionIds)
    const scopes = Array.isArray(filters.scopes) && filters.scopes.length
      ? filters.scopes
      : (Array.isArray(filters.models) && filters.models.length ? ['model', 'approval'] : ['session', 'approval'])
    appendSqlListFilter(conditions, values, 'scope', scopes)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return rows(this.sql.exec(
      `SELECT * FROM usage_events ${where} ORDER BY observed_at, id`,
      values
    ))
      .map(rowToUsageEvent)
  }

  listUsageEvents(filters = {}) {
    return this.queryUsageEvents(filters)
  }

  getLegacyUsageBaseline(filters = {}) {
    const conditions = ["scope = 'session'"]
    const values = []
    appendSqlListFilter(conditions, values, 'project_path', filters.projectPaths)
    appendSqlListFilter(conditions, values, 'adapter_id', filters.adapterIds)
    const result = rows(this.sql.exec(
      `SELECT
         COALESCE(SUM(legacy_input_tokens), 0) AS input_tokens,
         COALESCE(SUM(legacy_output_tokens), 0) AS output_tokens,
         COALESCE(SUM(CASE WHEN legacy_cost_available = 1 THEN legacy_cost_usd ELSE 0 END), 0) AS cost_usd,
         COALESCE(SUM(CASE WHEN legacy_cost_available = 0 THEN 1 ELSE 0 END), 0) AS unavailable_costs,
         COALESCE(SUM(legacy_turns), 0) AS turns
       FROM usage_checkpoints
       WHERE ${conditions.join(' AND ')}`,
      values
    ))[0] || {}
    return {
      inputTokens: Number(result.input_tokens) || 0,
      outputTokens: Number(result.output_tokens) || 0,
      costUsd: Number(result.cost_usd) || 0,
      costAvailable: Number(result.unavailable_costs) === 0,
      turns: Number(result.turns) || 0
    }
  }

  // ---- summary reports ----
  createSummaryReport(report) {
    assertSummaryReport(report)
    const createdAt = Number.isFinite(report.createdAt) ? report.createdAt : Date.now()
    const updatedAt = Number.isFinite(report.updatedAt) ? report.updatedAt : createdAt
    this.sql.run(
      `INSERT INTO summary_reports (
         id, period_type, period_start, period_end_exclusive, timezone, partial,
         version, status, markdown, executor_id, profile_id, model,
         usage_snapshot_json, coverage_json, generation_usage_json, generation_metrics_json,
         generation_cost_usd, prompt_version, source_hash, is_current,
         generated_by, error_text, execution_mode, session_id, run_phase,
         artifact_metadata_json, legacy_import_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.id, report.periodType, report.periodStart, report.periodEndExclusive,
        report.timezone, report.partial ? 1 : 0, report.version, report.status,
        report.markdown ?? null, report.executorId || null, report.profileId || null,
        report.model || null, stringifyJsonObject(report.usageSnapshot),
        stringifyJsonObject(report.coverage), stringifyJsonObject(report.generationUsage),
        stringifyJsonObject(report.generationMetrics),
        report.generationCostUsd ?? null, report.promptVersion || null,
        report.sourceHash || null, report.isCurrent ? 1 : 0, report.generatedBy,
        report.errorText ?? null, report.executionMode || 'isolated-runner',
        report.sessionId || null, report.runPhase ?? null,
        stringifyJsonObject(report.artifactMetadata), report.legacyImportKey || null,
        createdAt, updatedAt
      ]
    )
    return this.getSummaryReport(report.id)
  }

  updateSummaryReport(reportId, fields = {}) {
    assertSummaryReportPatch(fields)
    if (fields.status !== undefined && fields.status !== 'completed' &&
      this.getSummaryReport(reportId)?.isCurrent) {
      throw summaryValidationError(
        'SUMMARY_REPORT_NOT_COMPLETED',
        'A current summary report must remain completed'
      )
    }
    const columns = {
      status: 'status', markdown: 'markdown', executorId: 'executor_id',
      profileId: 'profile_id', model: 'model', generationCostUsd: 'generation_cost_usd',
      promptVersion: 'prompt_version', sourceHash: 'source_hash', generatedBy: 'generated_by',
      errorText: 'error_text', executionMode: 'execution_mode', sessionId: 'session_id',
      runPhase: 'run_phase', legacyImportKey: 'legacy_import_key', updatedAt: 'updated_at'
    }
    const sets = []
    const values = []
    for (const [field, column] of Object.entries(columns)) {
      if (fields[field] === undefined) continue
      sets.push(`${column} = ?`)
      values.push(fields[field])
    }
    for (const [field, column] of [
      ['usageSnapshot', 'usage_snapshot_json'],
      ['coverage', 'coverage_json'],
      ['generationUsage', 'generation_usage_json'],
      ['generationMetrics', 'generation_metrics_json'],
      ['artifactMetadata', 'artifact_metadata_json']
    ]) {
      if (fields[field] === undefined) continue
      sets.push(`${column} = ?`)
      values.push(stringifyJsonObject(fields[field]))
    }
    if (fields.partial !== undefined) {
      sets.push('partial = ?')
      values.push(fields.partial ? 1 : 0)
    }
    if (!sets.length) return this.getSummaryReport(reportId)
    if (fields.updatedAt === undefined) {
      sets.push('updated_at = ?')
      values.push(Date.now())
    }
    values.push(reportId)
    this.sql.run(`UPDATE summary_reports SET ${sets.join(', ')} WHERE id = ?`, values)
    return this.getSummaryReport(reportId)
  }

  getSummaryReport(reportId) {
    return rows(this.sql.exec('SELECT * FROM summary_reports WHERE id = ?', [reportId]))
      .map(rowToSummaryReport)[0] || null
  }

  async completeSummaryReport(reportId, fields = {}) {
    assertSummaryReportPatch(fields)
    if (fields.status !== 'completed' || fields.runPhase !== 'completed') {
      throw summaryValidationError('INVALID_SUMMARY_STATUS', 'Invalid completed summary report')
    }
    return this.transaction(async () => {
      const target = this.getSummaryReport(reportId)
      if (!target) {
        throw Object.assign(new Error(`Summary report not found: ${reportId}`), {
          code: 'SUMMARY_REPORT_NOT_FOUND'
        })
      }
      if (target.status !== 'running') {
        throw Object.assign(new Error('Only running summary reports can complete'), {
          code: 'SUMMARY_REPORT_NOT_RUNNING'
        })
      }
      this.updateSummaryReport(reportId, fields)
      this.sql.run(
        `UPDATE summary_reports SET is_current = 0
         WHERE period_type = ? AND period_start = ?
           AND period_end_exclusive = ? AND timezone = ? AND id <> ?`,
        [target.periodType, target.periodStart, target.periodEndExclusive, target.timezone, reportId]
      )
      this.sql.run('UPDATE summary_reports SET is_current = 1 WHERE id = ?', [reportId])
      return this.getSummaryReport(reportId)
    })
  }

  async importCompletedSummaryReport(report) {
    if (typeof report?.legacyImportKey !== 'string' || !report.legacyImportKey.trim()) {
      throw summaryValidationError('INVALID_SUMMARY_LEGACY_IMPORT_KEY', 'Invalid legacy import key')
    }
    return this.transaction(async () => {
      const existing = rows(this.sql.exec(
        'SELECT * FROM summary_reports WHERE legacy_import_key = ? LIMIT 1',
        [report.legacyImportKey]
      )).map(rowToSummaryReport)[0]
      if (existing) return { report: existing, imported: false }

      const latest = rows(this.sql.exec(
        `SELECT COALESCE(MAX(version), 0) AS version FROM summary_reports
         WHERE period_type = ? AND period_start = ?
           AND period_end_exclusive = ? AND timezone = ?`,
        [report.periodType, report.periodStart, report.periodEndExclusive, report.timezone]
      ))[0]
      const created = this.createSummaryReport({
        ...report,
        version: Number(latest?.version || 0) + 1,
        status: 'completed',
        isCurrent: false
      })
      return { report: created, imported: true }
    })
  }

  listSummaryReports(filters = {}) {
    const conditions = []
    const values = []
    for (const [field, column] of [
      ['periodType', 'period_type'], ['status', 'status'], ['generatedBy', 'generated_by'],
      ['timezone', 'timezone'], ['executionMode', 'execution_mode'],
      ['sessionId', 'session_id'], ['runPhase', 'run_phase'],
      ['legacyImportKey', 'legacy_import_key']
    ]) {
      if (filters[field] === undefined) continue
      conditions.push(`${column} = ?`)
      values.push(filters[field])
    }
    if (Number.isFinite(filters.periodStart)) {
      conditions.push('period_start = ?')
      values.push(filters.periodStart)
    }
    if (Number.isFinite(filters.periodEndExclusive)) {
      conditions.push('period_end_exclusive = ?')
      values.push(filters.periodEndExclusive)
    }
    if (filters.isCurrent !== undefined) {
      conditions.push('is_current = ?')
      values.push(filters.isCurrent ? 1 : 0)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return rows(this.sql.exec(
      `SELECT * FROM summary_reports ${where}
       ORDER BY period_start DESC, version DESC, created_at DESC, id`,
      values
    )).map(rowToSummaryReport)
  }

  async setCurrentSummaryReport(reportId) {
    return this.transaction(async () => {
      const target = this.getSummaryReport(reportId)
      if (!target) {
        throw Object.assign(new Error(`Summary report not found: ${reportId}`), {
          code: 'SUMMARY_REPORT_NOT_FOUND'
        })
      }
      if (target.status !== 'completed') {
        throw Object.assign(new Error('Only completed summary reports can be current'), {
          code: 'SUMMARY_REPORT_NOT_COMPLETED'
        })
      }
      const logicalKey = [
        target.periodType, target.periodStart, target.periodEndExclusive, target.timezone
      ]
      this.sql.run(
        `UPDATE summary_reports SET is_current = 0
         WHERE period_type = ? AND period_start = ?
           AND period_end_exclusive = ? AND timezone = ? AND id <> ?`,
        [...logicalKey, reportId]
      )
      this.sql.run('UPDATE summary_reports SET is_current = 1 WHERE id = ?', [reportId])
      return this.getSummaryReport(reportId)
    })
  }

  async deleteSummaryReport(reportId) {
    return this.transaction(async () => {
      const target = this.getSummaryReport(reportId)
      if (!target) {
        throw Object.assign(new Error(`Summary report not found: ${reportId}`), {
          code: 'SUMMARY_REPORT_NOT_FOUND'
        })
      }
      if (['queued', 'running', 'awaiting_confirmation'].includes(target.status)) {
        throw Object.assign(new Error('Active summary reports cannot be deleted'), {
          code: 'SUMMARY_REPORT_ACTIVE'
        })
      }

      this.sql.run('DELETE FROM summary_reports WHERE id = ?', [reportId])
      let currentReportId = null
      if (target.isCurrent) {
        const replacement = rows(this.sql.exec(
          `SELECT id FROM summary_reports
           WHERE period_type = ? AND period_start = ? AND period_end_exclusive = ?
             AND timezone = ? AND status = 'completed'
           ORDER BY version DESC, created_at DESC, id
           LIMIT 1`,
          [target.periodType, target.periodStart, target.periodEndExclusive, target.timezone]
        ))[0]
        if (replacement?.id) {
          this.sql.run('UPDATE summary_reports SET is_current = 1 WHERE id = ?', [replacement.id])
          currentReportId = replacement.id
        }
      } else {
        const current = rows(this.sql.exec(
          `SELECT id FROM summary_reports
           WHERE period_type = ? AND period_start = ? AND period_end_exclusive = ?
             AND timezone = ? AND is_current = 1
           LIMIT 1`,
          [target.periodType, target.periodStart, target.periodEndExclusive, target.timezone]
        ))[0]
        currentReportId = current?.id || null
      }
      return { deletedReportId: reportId, currentReportId }
    })
  }

  getSummarySettings() {
    const value = rows(this.sql.exec(
      'SELECT settings_json FROM summary_settings WHERE id = 1'
    ))[0]?.settings_json
    return normalizeSummarySettings(parseJsonObject(value))
  }

  setSummarySettings(settings = {}) {
    assertSummarySettingsPatch(settings)
    const current = this.getSummarySettings()
    const merged = normalizeSummarySettings({
      ...current,
      ...settings,
      autoPeriods: {
        ...current.autoPeriods,
        ...(settings.autoPeriods && typeof settings.autoPeriods === 'object'
          ? settings.autoPeriods
          : {})
      }
    })
    this.sql.run(
      `INSERT INTO summary_settings (id, settings_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = excluded.updated_at`,
      [JSON.stringify(merged), Date.now()]
    )
    return merged
  }

  // ---- summary cache metadata ----
  getSummaryCacheEntry(key) {
    assertSummaryCacheKey(key)
    return rows(this.sql.exec(
      'SELECT * FROM summary_cache_entries WHERE cache_key = ?',
      [key]
    )).map(rowToSummaryCacheEntry)[0] || null
  }

  upsertSummaryCacheEntry(entry) {
    assertSummaryCacheEntry(entry)
    this.sql.run(
      `INSERT INTO summary_cache_entries (
         cache_key, kind, relative_path, size_bytes, created_at, last_accessed_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         kind = excluded.kind,
         relative_path = excluded.relative_path,
         size_bytes = excluded.size_bytes,
         created_at = excluded.created_at,
         last_accessed_at = excluded.last_accessed_at,
         expires_at = excluded.expires_at`,
      [
        entry.key, entry.kind, entry.relativePath, entry.sizeBytes, entry.createdAt,
        entry.lastAccessedAt, entry.expiresAt ?? null
      ]
    )
    return this.getSummaryCacheEntry(entry.key)
  }

  touchSummaryCacheEntry(key, at) {
    assertSummaryCacheKey(key)
    assertSummaryCacheTimestamp(at)
    this.sql.run(
      'UPDATE summary_cache_entries SET last_accessed_at = ? WHERE cache_key = ?',
      [at, key]
    )
    return this.getSummaryCacheEntry(key)
  }

  listSummaryCacheEntries() {
    return rows(this.sql.exec(
      'SELECT * FROM summary_cache_entries ORDER BY created_at, cache_key'
    )).map(rowToSummaryCacheEntry)
  }

  deleteSummaryCacheEntries(keys) {
    if (!Array.isArray(keys)) throw summaryCacheValidationError()
    for (const key of keys) assertSummaryCacheKey(key)
    if (keys.length === 0) return 0
    const unique = [...new Set(keys)]
    const existing = unique.reduce(
      (count, key) => count + (this.getSummaryCacheEntry(key) ? 1 : 0),
      0
    )
    this.sql.run(
      `DELETE FROM summary_cache_entries WHERE cache_key IN (${unique.map(() => '?').join(', ')})`,
      unique
    )
    return existing
  }

  // ---- rules ----
  getRules() {
    const r = this.sql.exec('SELECT id, name, config FROM rules')
    const map = {}
    for (const row of rows(r)) {
      try { map[row.id] = { id: row.id, name: row.name, ...JSON.parse(row.config) } }
      catch { map[row.id] = { id: row.id, name: row.name, deny: [], highRisk: [], allow: [] } }
    }
    return map
  }

  saveRules(rulesets) {
    this.sql.run('DELETE FROM rules')
    for (const [id, rs] of Object.entries(rulesets)) {
      const { deny, highRisk, allow } = rs
      const config = JSON.stringify({ deny: deny || [], highRisk: highRisk || [], allow: allow || [] })
      this.sql.run('INSERT INTO rules (id, name, config) VALUES (?,?,?)', [id, rs.name || id, config])
    }
  }

  // ---- settings ----
  getSettings() {
    const r = this.sql.exec("SELECT value FROM settings WHERE key='app'")
    const vals = rows(r)
    if (vals.length) {
      try { return JSON.parse(vals[0].value) } catch { return {} }
    }
    return {}
  }

  saveSettings(settings) {
    this.sql.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', ['app', JSON.stringify(settings)])
  }

  // ---- workbench ----
  getWorkbench() {
    const r = this.sql.exec("SELECT value FROM settings WHERE key='workbench'")
    const vals = rows(r)
    if (vals.length) {
      try { return JSON.parse(vals[0].value) } catch { return null }
    }
    return null
  }

  saveWorkbench(state) {
    this.sql.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', ['workbench', JSON.stringify(state)])
  }

  // ---- AI CLI profiles ----
  listAiCliProfiles({ adapterId } = {}) {
    const result = adapterId
      ? this.sql.exec(
          'SELECT * FROM ai_cli_profiles WHERE adapter_id = ? ORDER BY updated_at DESC, id',
          [adapterId]
        )
      : this.sql.exec('SELECT * FROM ai_cli_profiles ORDER BY updated_at DESC, id')
    return rows(result).map(rowToAiCliProfile)
  }

  getAiCliProfile(profileId) {
    const result = this.sql.exec('SELECT * FROM ai_cli_profiles WHERE id = ?', [profileId])
    return rows(result).map(rowToAiCliProfile)[0] || null
  }

  insertAiCliProfile(profile) {
    const createdAt = Number.isFinite(profile.createdAt) ? profile.createdAt : Date.now()
    const updatedAt = Number.isFinite(profile.updatedAt) ? profile.updatedAt : createdAt
    this.sql.run(
      `INSERT INTO ai_cli_profiles (
         id, adapter_id, name, kind, native_profile_name, provider_id, base_url,
         model, reasoning_effort, context_window, config_json, has_secret_hint,
         file_sha256, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.id,
        profile.adapterId,
        profile.name,
        profile.kind,
        profile.nativeProfileName || null,
        profile.providerId || null,
        profile.baseUrl || null,
        profile.model || null,
        profile.reasoningEffort || null,
        profile.contextWindow ?? null,
        stringifyJsonObject(profile.config),
        profile.hasSecretHint ? 1 : 0,
        profile.fileSha256 || null,
        createdAt,
        updatedAt
      ]
    )
  }

  updateAiCliProfile(profileId, fields = {}) {
    const columns = {
      adapterId: 'adapter_id',
      name: 'name',
      kind: 'kind',
      nativeProfileName: 'native_profile_name',
      providerId: 'provider_id',
      baseUrl: 'base_url',
      model: 'model',
      reasoningEffort: 'reasoning_effort',
      contextWindow: 'context_window',
      fileSha256: 'file_sha256'
    }
    const sets = []
    const values = []
    for (const [field, column] of Object.entries(columns)) {
      if (fields[field] !== undefined) {
        sets.push(`${column} = ?`)
        values.push(fields[field])
      }
    }
    if (fields.config !== undefined) {
      sets.push('config_json = ?')
      values.push(stringifyJsonObject(fields.config))
    }
    if (fields.hasSecretHint !== undefined) {
      sets.push('has_secret_hint = ?')
      values.push(fields.hasSecretHint ? 1 : 0)
    }
    if (!sets.length) return false
    sets.push('updated_at = ?')
    values.push(Number.isFinite(fields.updatedAt) ? fields.updatedAt : Date.now(), profileId)
    this.sql.run(`UPDATE ai_cli_profiles SET ${sets.join(', ')} WHERE id = ?`, values)
    return this.sql.getRowsModified() > 0
  }

  deleteAiCliProfile(profileId) {
    this.sql.run('DELETE FROM ai_cli_profiles WHERE id = ?', [profileId])
    return this.sql.getRowsModified() > 0
  }

  listAiCliProfileBindings({ adapterId, profileId } = {}) {
    const conditions = []
    const values = []
    if (adapterId) {
      conditions.push('adapter_id = ?')
      values.push(adapterId)
    }
    if (profileId) {
      conditions.push('profile_id = ?')
      values.push(profileId)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = this.sql.exec(
      `SELECT * FROM ai_cli_profile_bindings ${where} ORDER BY scope_type, scope_key`,
      values
    )
    return rows(result).map(rowToAiCliProfileBinding)
  }

  getAiCliProfileBinding(scopeType, scopeKey, adapterId) {
    const result = this.sql.exec(
      `SELECT * FROM ai_cli_profile_bindings
       WHERE scope_type = ? AND scope_key = ? AND adapter_id = ?`,
      [scopeType, scopeKey, adapterId]
    )
    return rows(result).map(rowToAiCliProfileBinding)[0] || null
  }

  upsertAiCliProfileBinding(binding) {
    this.sql.run(
      `INSERT INTO ai_cli_profile_bindings (
         scope_type, scope_key, adapter_id, profile_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_type, scope_key, adapter_id) DO UPDATE SET
         profile_id = excluded.profile_id,
         updated_at = excluded.updated_at`,
      [
        binding.scopeType,
        binding.scopeKey,
        binding.adapterId,
        binding.profileId || null,
        Number.isFinite(binding.updatedAt) ? binding.updatedAt : Date.now()
      ]
    )
  }

  deleteAiCliProfileBinding(scopeType, scopeKey, adapterId) {
    this.sql.run(
      `DELETE FROM ai_cli_profile_bindings
       WHERE scope_type = ? AND scope_key = ? AND adapter_id = ?`,
      [scopeType, scopeKey, adapterId]
    )
    return this.sql.getRowsModified() > 0
  }

  insertAiCliProfileRevision(revision) {
    this.sql.run(
      `INSERT INTO ai_cli_profile_revisions (
         id, profile_id, config_json, file_sha256, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        revision.id,
        revision.profileId,
        stringifyJsonObject(revision.config),
        revision.fileSha256 || null,
        revision.reason,
        Number.isFinite(revision.createdAt) ? revision.createdAt : Date.now()
      ]
    )
    this.sql.run(
      `DELETE FROM ai_cli_profile_revisions
       WHERE profile_id = ? AND id NOT IN (
         SELECT id FROM ai_cli_profile_revisions
         WHERE profile_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 10
       )`,
      [revision.profileId, revision.profileId]
    )
  }

  listAiCliProfileRevisions(profileId) {
    const result = this.sql.exec(
      `SELECT * FROM ai_cli_profile_revisions
       WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC`,
      [profileId]
    )
    return rows(result).map(rowToAiCliProfileRevision)
  }

  getAiCliProfileRevision(revisionId) {
    const result = this.sql.exec(
      'SELECT * FROM ai_cli_profile_revisions WHERE id = ?',
      [revisionId]
    )
    return rows(result).map(rowToAiCliProfileRevision)[0] || null
  }

  deleteAiCliProfileRevision(revisionId) {
    this.sql.run('DELETE FROM ai_cli_profile_revisions WHERE id = ?', [revisionId])
    return this.sql.getRowsModified() > 0
  }

  saveAiCliProfileSecretCiphertext(profileId, ciphertext, updatedAt = Date.now()) {
    this.sql.run(
      `INSERT INTO ai_cli_profile_secrets (profile_id, ciphertext, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at`,
      [profileId, ciphertext, updatedAt]
    )
  }

  getAiCliProfileSecretRecord(profileId) {
    const result = this.sql.exec(
      'SELECT * FROM ai_cli_profile_secrets WHERE profile_id = ?',
      [profileId]
    )
    return rows(result).map(rowToAiCliProfileSecret)[0] || null
  }

  deleteAiCliProfileSecret(profileId) {
    this.sql.run('DELETE FROM ai_cli_profile_secrets WHERE profile_id = ?', [profileId])
    return this.sql.getRowsModified() > 0
  }

  // ---- Skills ----
  listSkillPackages() {
    return rows(this.sql.exec('SELECT * FROM skill_packages ORDER BY updated_at DESC, id'))
      .map(rowToSkillPackage)
  }

  getSkillPackage(packageId) {
    return rows(this.sql.exec('SELECT * FROM skill_packages WHERE id = ?', [packageId]))
      .map(rowToSkillPackage)[0] || null
  }

  insertSkillPackage(pkg) {
    const createdAt = Number.isFinite(pkg.createdAt) ? pkg.createdAt : Date.now()
    const updatedAt = Number.isFinite(pkg.updatedAt) ? pkg.updatedAt : createdAt
    this.sql.run(
      `INSERT INTO skill_packages (
        id, name, description, source_type, source_locator, source_ref, source_ref_type, source_subdir,
        resolved_revision, manifest_json, content_sha256, last_checked_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pkg.id, pkg.name, pkg.description, pkg.sourceType, pkg.sourceLocator,
        pkg.sourceRef || null, pkg.sourceRefType || 'default', pkg.sourceSubdir || null, pkg.resolvedRevision || null,
        stringifyJsonObject(pkg.manifest), pkg.contentSha256, pkg.lastCheckedAt ?? null,
        createdAt, updatedAt
      ]
    )
  }

  updateSkillPackage(packageId, fields = {}) {
    const columns = {
      name: 'name', description: 'description', sourceType: 'source_type',
      sourceLocator: 'source_locator', sourceRef: 'source_ref', sourceRefType: 'source_ref_type', sourceSubdir: 'source_subdir',
      resolvedRevision: 'resolved_revision', manifest: 'manifest_json',
      contentSha256: 'content_sha256', lastCheckedAt: 'last_checked_at', updatedAt: 'updated_at'
    }
    const sets = []
    const values = []
    for (const [key, column] of Object.entries(columns)) {
      if (fields[key] === undefined) continue
      sets.push(`${column} = ?`)
      values.push(key === 'manifest' ? stringifyJsonObject(fields[key]) : fields[key])
    }
    if (!sets.length) return false
    values.push(packageId)
    this.sql.run(`UPDATE skill_packages SET ${sets.join(', ')} WHERE id = ?`, values)
    return this.sql.getRowsModified() > 0
  }

  deleteSkillPackage(packageId) {
    this.sql.run('DELETE FROM skill_packages WHERE id = ?', [packageId])
    return this.sql.getRowsModified() > 0
  }

  listSkillInstallations({ packageId } = {}) {
    const result = packageId
      ? this.sql.exec('SELECT * FROM skill_installations WHERE package_id = ? ORDER BY created_at, id', [packageId])
      : this.sql.exec('SELECT * FROM skill_installations ORDER BY created_at, id')
    return rows(result).map(rowToSkillInstallation)
  }

  getSkillInstallation(installationId) {
    return rows(this.sql.exec('SELECT * FROM skill_installations WHERE id = ?', [installationId]))
      .map(rowToSkillInstallation)[0] || null
  }

  insertSkillInstallation(item) {
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
    this.sql.run(
      `INSERT INTO skill_installations (
        id, package_id, target_adapter_id, scope_type, scope_key, target_path,
        enabled, deployed_sha256, status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        item.id, item.packageId, item.targetAdapterId, item.scopeType, item.scopeKey,
        item.targetPath, item.enabled === false ? 0 : 1, item.deployedSha256 || null,
        item.status, createdAt, updatedAt
      ]
    )
  }

  updateSkillInstallation(installationId, fields = {}) {
    const columns = {
      enabled: 'enabled', deployedSha256: 'deployed_sha256', status: 'status',
      targetPath: 'target_path', updatedAt: 'updated_at'
    }
    const sets = []
    const values = []
    for (const [key, column] of Object.entries(columns)) {
      if (fields[key] === undefined) continue
      sets.push(`${column} = ?`)
      values.push(key === 'enabled' ? (fields[key] ? 1 : 0) : fields[key])
    }
    if (!sets.length) return false
    values.push(installationId)
    this.sql.run(`UPDATE skill_installations SET ${sets.join(', ')} WHERE id = ?`, values)
    return this.sql.getRowsModified() > 0
  }

  deleteSkillInstallation(installationId) {
    this.sql.run('DELETE FROM skill_installations WHERE id = ?', [installationId])
    return this.sql.getRowsModified() > 0
  }

  getAiCliProfileUsage(profileId) {
    const result = this.sql.exec(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE profile_id = ?) AS session_count,
         (SELECT COUNT(*) FROM ai_cli_profile_bindings WHERE profile_id = ?) AS binding_count`,
      [profileId, profileId]
    )
    const values = result[0]?.values?.[0] || [0, 0]
    return {
      sessionCount: Number(values[0]) || 0,
      bindingCount: Number(values[1]) || 0
    }
  }

  // ---- Gateway configuration and routes ----
  getGatewaySetting(key) {
    if (!String(key).startsWith('gateway.')) return null
    const values = rows(this.sql.exec(
      'SELECT value FROM settings WHERE key=?',
      [key]
    ))
    if (!values.length) return null
    try {
      return JSON.parse(values[0].value)
    } catch {
      return null
    }
  }

  saveGatewaySetting(key, value) {
    if (!String(key).startsWith('gateway.')) {
      throw Object.assign(new TypeError('Gateway setting key is required'), {
        code: 'INVALID_GATEWAY_SETTING'
      })
    }
    this.sql.run(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)',
      [key, JSON.stringify(value)]
    )
  }

  getGatewaySecretCiphertext(key) {
    const values = rows(this.sql.exec(
      'SELECT ciphertext FROM gateway_secrets WHERE key=?',
      [key]
    ))
    return values[0]?.ciphertext || null
  }

  saveGatewaySecretCiphertext(key, ciphertext) {
    if (
      typeof key !== 'string' ||
      !key.startsWith('gateway.') ||
      typeof ciphertext !== 'string' ||
      !ciphertext
    ) {
      throw Object.assign(new TypeError('Gateway ciphertext is required'), {
        code: 'INVALID_GATEWAY_SECRET'
      })
    }
    this.sql.run(
      `INSERT INTO gateway_secrets (key, ciphertext, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         ciphertext=excluded.ciphertext,
         updated_at=excluded.updated_at`,
      [key, ciphertext, Date.now()]
    )
  }

  listGatewaySessionRoutes() {
    const result = rows(this.sql.exec(
      'SELECT * FROM gateway_session_routes ORDER BY updated_at DESC'
    ))
    return result.map(gatewaySessionRoute)
  }

  upsertGatewaySessionRoute(route) {
    if (!route?.sessionId) {
      throw Object.assign(new TypeError('Gateway sessionId is required'), {
        code: 'INVALID_GATEWAY_ROUTE'
      })
    }
    const existing = rows(this.sql.exec(
      'SELECT * FROM gateway_session_routes WHERE session_id=?',
      [route.sessionId]
    ))[0] || {}
    const value = (camelKey, sqlKey, fallback = null) =>
      route[camelKey] !== undefined ? route[camelKey] : existing[sqlKey] ?? fallback
    this.sql.run(
      `INSERT INTO gateway_session_routes (
         session_id, relay_enabled, channel_fingerprint, target_id,
         root_message_id, root_thread_id, route_status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         relay_enabled=excluded.relay_enabled,
         channel_fingerprint=excluded.channel_fingerprint,
         target_id=excluded.target_id,
         root_message_id=excluded.root_message_id,
         root_thread_id=excluded.root_thread_id,
         route_status=excluded.route_status,
         updated_at=excluded.updated_at`,
      [
        route.sessionId,
        value('relayEnabled', 'relay_enabled', 0) ? 1 : 0,
        value('channelFingerprint', 'channel_fingerprint'),
        value('targetId', 'target_id'),
        value('rootMessageId', 'root_message_id'),
        value('rootThreadId', 'root_thread_id'),
        value('routeStatus', 'route_status', 'waiting'),
        Date.now()
      ]
    )
    return this.listGatewaySessionRoutes()
      .find((candidate) => candidate.sessionId === route.sessionId) || null
  }

  saveGatewayMessageRoute(route) {
    const required = [
      route?.messageId,
      route?.sessionId,
      route?.routeKind,
      route?.channelFingerprint
    ]
    if (required.some((value) => typeof value !== 'string' || !value)) {
      throw Object.assign(new TypeError('Complete Gateway message route is required'), {
        code: 'INVALID_GATEWAY_ROUTE'
      })
    }
    this.sql.run(
      `INSERT INTO gateway_message_routes (
         message_id, session_id, relay_task_id, decision_id, route_kind,
         channel_fingerprint, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         session_id=excluded.session_id,
         relay_task_id=excluded.relay_task_id,
         decision_id=excluded.decision_id,
         route_kind=excluded.route_kind,
         channel_fingerprint=excluded.channel_fingerprint,
         active=excluded.active`,
      [
        route.messageId,
        route.sessionId,
        route.relayTaskId || null,
        route.decisionId || null,
        route.routeKind,
        route.channelFingerprint,
        route.active === false ? 0 : 1,
        route.createdAt || Date.now()
      ]
    )
  }

  resolveGatewayMessageRoute(messageId, channelFingerprint) {
    const result = rows(this.sql.exec(
      `SELECT * FROM gateway_message_routes
       WHERE message_id=? AND channel_fingerprint=? AND active=1`,
      [messageId, channelFingerprint]
    ))
    return result.length ? gatewayMessageRoute(result[0]) : null
  }

  deactivateGatewayRoutesForSession(sessionId) {
    this.sql.run(
      `UPDATE gateway_session_routes
       SET relay_enabled=0, route_status='inactive',
           root_message_id=NULL, root_thread_id=NULL, updated_at=?
       WHERE session_id=?`,
      [Date.now(), sessionId]
    )
    this.sql.run(
      'UPDATE gateway_message_routes SET active=0 WHERE session_id=?',
      [sessionId]
    )
  }

  deactivateGatewayRoutesForFingerprint(channelFingerprint) {
    this.sql.run(
      `UPDATE gateway_session_routes
       SET route_status='inactive', root_message_id=NULL,
           root_thread_id=NULL, updated_at=?
       WHERE channel_fingerprint=?`,
      [Date.now(), channelFingerprint]
    )
    this.sql.run(
      'UPDATE gateway_message_routes SET active=0 WHERE channel_fingerprint=?',
      [channelFingerprint]
    )
  }

  saveGatewayDecisionAudit(record) {
    const fields = ['id', 'sessionId', 'decisionId', 'kind', 'verdict', 'source']
    if (fields.some((field) => typeof record?.[field] !== 'string' || !record[field])) {
      throw Object.assign(new TypeError('Complete Gateway decision audit is required'), {
        code: 'INVALID_GATEWAY_AUDIT'
      })
    }
    this.sql.run(
      `INSERT OR REPLACE INTO gateway_decision_audit (
         id, session_id, decision_id, kind, verdict, source, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.decisionId,
        record.kind,
        record.verdict,
        record.source,
        Number.isFinite(record.resolvedAt) ? record.resolvedAt : Date.now()
      ]
    )
  }

  getGatewayDiagnosticCounts() {
    const result = this.sql.exec(
      `SELECT
         (SELECT COUNT(*) FROM gateway_session_routes) AS session_routes,
         (SELECT COUNT(*) FROM gateway_message_routes) AS message_routes,
         (SELECT COUNT(*) FROM gateway_decision_audit) AS decision_audits`
    )
    const values = result[0]?.values?.[0] || [0, 0, 0]
    return {
      sessionRoutes: Number(values[0]) || 0,
      messageRoutes: Number(values[1]) || 0,
      decisionAudits: Number(values[2]) || 0
    }
  }

  async transaction(work) {
    const run = async () => {
      this.sql.run('BEGIN IMMEDIATE')
      try {
        const result = await work()
        this.sql.run('COMMIT')
        return result
      } catch (error) {
        try { this.sql.run('ROLLBACK') } catch { /* preserve original error */ }
        throw error
      }
    }
    const result = this._transactionTail.then(run, run)
    this._transactionTail = result.catch(() => {})
    return result
  }

  // ---- migration ----
  migrateFromJson(rulesets, settings, sessionsObj) {
    if (rulesets) {
      this.saveRules(rulesets)
    }
    if (settings) {
      this.saveSettings(settings)
    }
    if (sessionsObj) {
      for (const [id, s] of Object.entries(sessionsObj)) {
        this.insertSession({
          id,
          project_path: s.cwd || s.project_path || '',
          adapter_id: s.adapterId || s.adapter_id || 'claude',
          native_session_id: s.cliSessionId || s.native_session_id || null,
          name: s.name || null,
          task_note: s.taskNote || s.task_note || '',
          tier: s.tier || 'safety-rules',
          model: s.model || null,
          status: 'offline',
          created_at: s.createdAt || s.created_at || Date.now()
        })
        if (s.stats) {
          this.sql.run(
            `INSERT INTO session_stats (session_id, input_tokens, output_tokens, cost_usd, cost_available, turns_count, auto_allowed, confirmed, denied)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(session_id) DO UPDATE SET
               input_tokens = excluded.input_tokens,
               output_tokens = excluded.output_tokens,
               cost_usd = excluded.cost_usd,
               cost_available = excluded.cost_available,
               turns_count = excluded.turns_count,
               auto_allowed = excluded.auto_allowed,
               confirmed = excluded.confirmed,
               denied = excluded.denied`,
            [id,
             s.stats?.tokens?.input || s.stats?.input_tokens || 0,
             s.stats?.tokens?.output || s.stats?.output_tokens || 0,
             s.stats?.costUsd ?? s.stats?.cost_usd ?? 0,
             s.stats?.costAvailable === false ? 0 : 1,
             s.stats?.turns || s.stats?.turns_count || 0,
             s.stats?.approvals?.autoAllowed || s.stats?.auto_allowed || 0,
             s.stats?.approvals?.confirmed || s.stats?.confirmed || 0,
             s.stats?.approvals?.denied || s.stats?.denied || 0]
          )
        }
      }
    }
  }

  // ---- flush to disk ----
  flush() {
    try {
      const data = Buffer.from(this.sql.export())
      if (!hasSqliteHeader(data)) throw new Error('Refusing to persist an invalid SQLite export.')

      if (existsSync(this.path)) {
        const previous = readFileSync(this.path)
        if (hasSqliteHeader(previous)) {
          replaceFileAtomically(`${this.path}.bak`, previous)
        }
      }
      replaceFileAtomically(this.path, data)
      return true
    } catch {
      return false
    }
  }

  close() {
    try { this.flush() } catch { /* ok */ }
    try { this.sql.close() } catch { /* ok */ }
    _db = null
  }
}

// ---- helpers ----
function rows(result) {
  if (!result || !result.length) return []
  const [{ columns, values }] = result
  return values.map((vals) => {
    const obj = {}
    columns.forEach((c, i) => { obj[c] = vals[i] })
    return obj
  })
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || !value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringifyJsonObject(value) {
  return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
}

function usageCounter(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function isKnownUsageCost(value) {
  return value?.costAvailable === true && Number.isFinite(value.costUsd) && value.costUsd >= 0
}

function assertUsageObservationScope(snapshot) {
  if (snapshot?.scope !== 'session' && snapshot?.scope !== 'model') {
    throw Object.assign(new TypeError('Usage observations require session or model scope'), {
      code: 'INVALID_USAGE_SCOPE'
    })
  }
  if (snapshot.scope === 'model' &&
    (typeof snapshot.model !== 'string' || !snapshot.model.trim())) {
    throw Object.assign(new TypeError('Model-scoped usage requires a model'), {
      code: 'INVALID_USAGE_MODEL'
    })
  }
}

function normalizeCost(value) {
  return Number(value.toFixed(12))
}

function usageObservationId(snapshot, modelKey, counters) {
  const identity = JSON.stringify([
    'usage', snapshot.sessionId, snapshot.scope, modelKey, snapshot.adapterId, snapshot.observedAt,
    counters.inputTokens, counters.outputTokens, counters.costAvailable ? counters.costUsd : null,
    counters.costAvailable, counters.turns
  ])
  return createHash('sha256').update(identity).digest('hex')
}

function appendSqlListFilter(conditions, values, column, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return
  conditions.push(`${column} IN (${candidates.map(() => '?').join(', ')})`)
  values.push(...candidates)
}

function normalizeSummarySettings(value = {}) {
  const periods = value.autoPeriods && typeof value.autoPeriods === 'object'
    ? value.autoPeriods
    : {}
  const nullableString = (candidate) => typeof candidate === 'string' && candidate
    ? candidate
    : null
  return {
    autoEnabled: typeof value.autoEnabled === 'boolean' ? value.autoEnabled : false,
    autoPeriods: {
      day: typeof periods.day === 'boolean' ? periods.day : true,
      week: typeof periods.week === 'boolean' ? periods.week : true,
      month: typeof periods.month === 'boolean' ? periods.month : false,
      quarter: typeof periods.quarter === 'boolean' ? periods.quarter : false,
      year: typeof periods.year === 'boolean' ? periods.year : false
    },
    defaultExecutorId: nullableString(value.defaultExecutorId),
    defaultProfileId: nullableString(value.defaultProfileId),
    defaultModel: nullableString(value.defaultModel),
    firstEnableDisclosureAcceptedAt: Number.isFinite(value.firstEnableDisclosureAcceptedAt)
      ? value.firstEnableDisclosureAcceptedAt
      : null,
    automaticCallLimit: Number.isInteger(value.automaticCallLimit) &&
      value.automaticCallLimit >= 1 && value.automaticCallLimit <= 100
      ? value.automaticCallLimit
      : 20,
    cacheEnabled: typeof value.cacheEnabled === 'boolean' ? value.cacheEnabled : true,
    cacheMaxBytes: Number.isSafeInteger(value.cacheMaxBytes) &&
      value.cacheMaxBytes >= 256 * 1024 * 1024 && value.cacheMaxBytes <= 5 * 1024 * 1024 * 1024
      ? value.cacheMaxBytes
      : 1_073_741_824,
    failedWorkspaceRetentionDays: Number.isInteger(value.failedWorkspaceRetentionDays) &&
      value.failedWorkspaceRetentionDays >= 1 && value.failedWorkspaceRetentionDays <= 30
      ? value.failedWorkspaceRetentionDays
      : 7,
    mapConcurrency: Number.isInteger(value.mapConcurrency) &&
      value.mapConcurrency >= 1 && value.mapConcurrency <= 3
      ? value.mapConcurrency
      : 2
  }
}

function assertSummarySettingsPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  if (value.cacheEnabled !== undefined && typeof value.cacheEnabled !== 'boolean') {
    throw summaryValidationError('INVALID_SUMMARY_CACHE_ENABLED', 'Invalid summary cache setting')
  }
  if (value.cacheMaxBytes !== undefined && (
    !Number.isSafeInteger(value.cacheMaxBytes) ||
    value.cacheMaxBytes < 256 * 1024 * 1024 ||
    value.cacheMaxBytes > 5 * 1024 * 1024 * 1024
  )) {
    throw summaryValidationError('INVALID_SUMMARY_CACHE_LIMIT', 'Invalid summary cache limit')
  }
  if (value.failedWorkspaceRetentionDays !== undefined && (
    !Number.isInteger(value.failedWorkspaceRetentionDays) ||
    value.failedWorkspaceRetentionDays < 1 ||
    value.failedWorkspaceRetentionDays > 30
  )) {
    throw summaryValidationError(
      'INVALID_SUMMARY_WORKSPACE_RETENTION',
      'Invalid failed workspace retention'
    )
  }
  if (value.mapConcurrency !== undefined && (
    !Number.isInteger(value.mapConcurrency) || value.mapConcurrency < 1 || value.mapConcurrency > 3
  )) {
    throw summaryValidationError('INVALID_SUMMARY_MAP_CONCURRENCY', 'Invalid summary map concurrency')
  }
}

const SUMMARY_CACHE_KEY = /^sha256:[a-f0-9]{64}$/
const SUMMARY_CACHE_KINDS = new Set(['map', 'project', 'final'])

function summaryCacheValidationError() {
  return summaryValidationError('INVALID_SUMMARY_CACHE_ENTRY', 'Invalid summary cache entry')
}

function assertSummaryCacheKey(key) {
  if (!SUMMARY_CACHE_KEY.test(String(key || ''))) throw summaryCacheValidationError()
}

function assertSummaryCacheTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw summaryCacheValidationError()
}

function assertSummaryCacheEntry(entry) {
  assertSummaryCacheKey(entry?.key)
  if (!SUMMARY_CACHE_KINDS.has(entry?.kind)) throw summaryCacheValidationError()
  const hex = entry.key.slice('sha256:'.length)
  if (entry.relativePath !== `${entry.kind}/${hex.slice(0, 2)}/${hex}.json`) {
    throw summaryCacheValidationError()
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw summaryCacheValidationError()
  }
  assertSummaryCacheTimestamp(entry.createdAt)
  assertSummaryCacheTimestamp(entry.lastAccessedAt)
  if (entry.expiresAt !== null && entry.expiresAt !== undefined) {
    assertSummaryCacheTimestamp(entry.expiresAt)
  }
}

const SUMMARY_PERIOD_TYPES = new Set(['day', 'week', 'month', 'quarter', 'year'])
const SUMMARY_STATUSES = new Set([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  'awaiting_confirmation', 'skipped_empty'
])
const SUMMARY_GENERATORS = new Set(['manual', 'automatic'])
const SUMMARY_EXECUTION_MODES = new Set([
  'isolated-runner', 'interactive-cli', 'legacy-worklog-import'
])
const SUMMARY_RUN_PHASES = new Set([
  'preparing', 'starting', 'awaiting-delivery', 'running', 'validating',
  'completed', 'failed', 'interrupted', 'cancelled'
])

function assertSummaryReport(report) {
  if (!SUMMARY_PERIOD_TYPES.has(report?.periodType)) {
    throw summaryValidationError('INVALID_SUMMARY_PERIOD', 'Invalid summary period type')
  }
  if (!SUMMARY_STATUSES.has(report.status)) {
    throw summaryValidationError('INVALID_SUMMARY_STATUS', 'Invalid summary report status')
  }
  if (!SUMMARY_GENERATORS.has(report.generatedBy)) {
    throw summaryValidationError('INVALID_SUMMARY_GENERATED_BY', 'Invalid summary report origin')
  }
  if (!Number.isInteger(report.version) || report.version < 1) {
    throw summaryValidationError('INVALID_SUMMARY_VERSION', 'Invalid summary report version')
  }
  if (!Number.isInteger(report.periodStart) || !Number.isInteger(report.periodEndExclusive) ||
    report.periodStart >= report.periodEndExclusive) {
    throw summaryValidationError('INVALID_SUMMARY_RANGE', 'Invalid summary report range')
  }
  if (typeof report.timezone !== 'string' || !report.timezone.trim()) {
    throw summaryValidationError('INVALID_SUMMARY_TIMEZONE', 'Invalid summary report timezone')
  }
  if (report.isCurrent && report.status !== 'completed') {
    throw summaryValidationError('SUMMARY_REPORT_NOT_COMPLETED', 'Only completed reports can be current')
  }
  if (report.executionMode !== undefined && !SUMMARY_EXECUTION_MODES.has(report.executionMode)) {
    throw summaryValidationError('INVALID_SUMMARY_EXECUTION_MODE', 'Invalid summary execution mode')
  }
  if (report.sessionId !== undefined && report.sessionId !== null &&
    (typeof report.sessionId !== 'string' || !report.sessionId.trim())) {
    throw summaryValidationError('INVALID_SUMMARY_SESSION_ID', 'Invalid summary session id')
  }
  if (report.runPhase !== undefined && report.runPhase !== null &&
    !SUMMARY_RUN_PHASES.has(report.runPhase)) {
    throw summaryValidationError('SUMMARY_RUN_PHASE_INVALID', 'Invalid summary run phase')
  }
}

function assertSummaryReportPatch(fields) {
  if (fields.status !== undefined && !SUMMARY_STATUSES.has(fields.status)) {
    throw summaryValidationError('INVALID_SUMMARY_STATUS', 'Invalid summary report status')
  }
  if (fields.generatedBy !== undefined && !SUMMARY_GENERATORS.has(fields.generatedBy)) {
    throw summaryValidationError('INVALID_SUMMARY_GENERATED_BY', 'Invalid summary report origin')
  }
  if (fields.executionMode !== undefined && !SUMMARY_EXECUTION_MODES.has(fields.executionMode)) {
    throw summaryValidationError('INVALID_SUMMARY_EXECUTION_MODE', 'Invalid summary execution mode')
  }
  if (fields.sessionId !== undefined && fields.sessionId !== null &&
    (typeof fields.sessionId !== 'string' || !fields.sessionId.trim())) {
    throw summaryValidationError('INVALID_SUMMARY_SESSION_ID', 'Invalid summary session id')
  }
  if (fields.runPhase !== undefined && fields.runPhase !== null &&
    !SUMMARY_RUN_PHASES.has(fields.runPhase)) {
    throw summaryValidationError('SUMMARY_RUN_PHASE_INVALID', 'Invalid summary run phase')
  }
}

function summaryValidationError(code, message) {
  return Object.assign(new TypeError(message), { code })
}

function rowToUsageEvent(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    scope: row.scope,
    projectPath: row.project_path || null,
    adapterId: row.adapter_id,
    model: row.model || null,
    observedAt: row.observed_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_available === 1 ? row.cost_usd : null,
    costAvailable: row.cost_available === 1,
    turns: row.turns,
    approvals: row.approvals
  }
}

function rowToSummaryReport(row) {
  return {
    id: row.id,
    periodType: row.period_type,
    periodStart: row.period_start,
    periodEndExclusive: row.period_end_exclusive,
    timezone: row.timezone,
    partial: row.partial === 1,
    version: row.version,
    status: row.status,
    markdown: row.markdown ?? null,
    executorId: row.executor_id || null,
    profileId: row.profile_id || null,
    model: row.model || null,
    usageSnapshot: parseJsonObject(row.usage_snapshot_json),
    coverage: parseJsonObject(row.coverage_json),
    generationUsage: parseJsonObject(row.generation_usage_json),
    generationMetrics: parseJsonObject(row.generation_metrics_json),
    generationCostUsd: row.generation_cost_usd ?? null,
    promptVersion: row.prompt_version || null,
    sourceHash: row.source_hash || null,
    isCurrent: row.is_current === 1,
    generatedBy: row.generated_by,
    errorText: row.error_text ?? null,
    executionMode: row.execution_mode || 'isolated-runner',
    sessionId: row.session_id || null,
    runPhase: row.run_phase || null,
    artifactMetadata: parseJsonObject(row.artifact_metadata_json),
    legacyImportKey: row.legacy_import_key || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToSummaryCacheEntry(row) {
  return {
    key: row.cache_key,
    kind: row.kind,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    expiresAt: row.expires_at ?? null
  }
}

function rowToAiCliProfile(row) {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    name: row.name,
    kind: row.kind,
    nativeProfileName: row.native_profile_name || null,
    providerId: row.provider_id || null,
    baseUrl: row.base_url || null,
    model: row.model || null,
    reasoningEffort: row.reasoning_effort || null,
    contextWindow: row.context_window ?? null,
    config: parseJsonObject(row.config_json),
    hasSecretHint: row.has_secret_hint === 1,
    fileSha256: row.file_sha256 || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToAiCliProfileBinding(row) {
  return {
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    adapterId: row.adapter_id,
    profileId: row.profile_id || null,
    updatedAt: row.updated_at
  }
}

function rowToAiCliProfileRevision(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    config: parseJsonObject(row.config_json),
    fileSha256: row.file_sha256 || null,
    reason: row.reason,
    createdAt: row.created_at
  }
}

function rowToAiCliProfileSecret(row) {
  return {
    profileId: row.profile_id,
    ciphertext: row.ciphertext,
    updatedAt: row.updated_at
  }
}

function rowToSkillPackage(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.source_type,
    sourceLocator: row.source_locator,
    sourceRef: row.source_ref || '',
    sourceRefType: row.source_ref_type || 'default',
    sourceSubdir: row.source_subdir || '',
    resolvedRevision: row.resolved_revision || null,
    manifest: parseJsonObject(row.manifest_json),
    contentSha256: row.content_sha256,
    lastCheckedAt: row.last_checked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToSkillInstallation(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    targetAdapterId: row.target_adapter_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    targetPath: row.target_path,
    enabled: row.enabled === 1,
    deployedSha256: row.deployed_sha256 || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function gatewaySessionRoute(row) {
  return {
    sessionId: row.session_id,
    relayEnabled: row.relay_enabled === 1,
    channelFingerprint: row.channel_fingerprint || null,
    targetId: row.target_id || null,
    rootMessageId: row.root_message_id || null,
    rootThreadId: row.root_thread_id || null,
    routeStatus: row.route_status,
    updatedAt: row.updated_at
  }
}

function gatewayMessageRoute(row) {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    relayTaskId: row.relay_task_id || null,
    decisionId: row.decision_id || null,
    routeKind: row.route_kind,
    channelFingerprint: row.channel_fingerprint,
    active: row.active === 1,
    createdAt: row.created_at
  }
}

function rowToSession(row) {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    projectPath: row.project_path,
    cwd: row.project_path, // keep legacy alias
    nativeSessionId: row.native_session_id,
    cliSessionId: row.native_session_id, // keep legacy alias
    name: row.name,
    taskNote: row.task_note,
    tier: row.tier,
    model: row.model,
    systemModel: row.system_model ?? null,
    provider: row.provider || null,
    sourceProvider: row.source_provider || null,
    providerPolicy: row.provider_policy || null,
    explicitProvider: row.explicit_provider || null,
    profileId: row.profile_id || null,
    adapterConfig: parseJsonObject(row.adapter_config_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at || null,
    stats: {
      tokens: { input: row.input_tokens || 0, output: row.output_tokens || 0 },
      costUsd: row.cost_available === 0 ? null : (row.cost_usd ?? 0),
      costAvailable: row.cost_available !== 0,
      turns: row.turns_count || 0,
      approvals: {
        autoAllowed: row.auto_allowed || 0,
        confirmed: row.confirmed || 0,
        denied: row.denied || 0
      }
    }
  }
}
