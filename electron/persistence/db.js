import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync
} from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'

import {
  isPersistedSummaryErrorText,
  summaryAutomaticDuplicateReportId
} from '../summaries/interactiveSummaryContracts.js'
import {
  assertSafeSummaryHash,
  normalizeCompletedArtifactMetadata,
  normalizeSummaryJsonField
} from '../summaries/summaryPersistenceValidation.js'
import { normalizeSummaryTaskMetadata } from '../../shared/summaryTaskContracts.js'
import {
  SERVICE_ADAPTER_PROTOCOL,
  stableServiceProfileId
} from '../serverConnection/serviceProfileCatalog.js'

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
export async function openDb(dbPath, { deferUsageLedgerInitialization = false, testHooks = null } = {}) {
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
    const db = new Db(instance, dbPath, null, testHooks)
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
        db = new Db(instance, dbPath, null, testHooks)
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
      db = new Db(instance, dbPath, null, testHooks)
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
  constructor(sql, path, recoveryInfo = null, testHooks = null) {
    this.sql = sql
    this.path = path
    this.recoveryInfo = recoveryInfo
    this._testHooks = testHooks
    this._transactionTail = Promise.resolve()
    this._transactionActive = false
  }

  _runImmediateTransaction(work) {
    if (this._transactionActive) return work()
    this.sql.run('BEGIN IMMEDIATE')
    this._transactionActive = true
    try {
      const result = work()
      this.sql.run('COMMIT')
      return result
    } catch (error) {
      try { this.sql.run('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    } finally {
      this._transactionActive = false
    }
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
        profile_source_kind TEXT,
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
    if (!sessionColumns.some((column) => column.name === 'profile_source_kind')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN profile_source_kind TEXT')
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
    const bindingColumns = rows(this.sql.exec('PRAGMA table_info(ai_cli_profile_bindings)'))
    if (!bindingColumns.some((column) => column.name === 'model_id')) {
      this.sql.run('ALTER TABLE ai_cli_profile_bindings ADD COLUMN model_id TEXT')
    }
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
      CREATE TABLE IF NOT EXISTS server_installation (
        singleton_key   INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        installation_id TEXT NOT NULL,
        device_name     TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS server_connections (
        id                       TEXT PRIMARY KEY,
        slot                     TEXT NOT NULL UNIQUE CHECK (slot IN ('current', 'candidate')),
        server_origin            TEXT NOT NULL,
        refresh_token_ciphertext TEXT NOT NULL,
        account_id               TEXT NOT NULL,
        account_display_name     TEXT NOT NULL,
        organization_id          TEXT NOT NULL,
        organization_name        TEXT NOT NULL,
        authorization_expires_at TEXT,
        server_time              TEXT,
        received_local_time      INTEGER NOT NULL,
        server_offset_ms         INTEGER NOT NULL,
        last_synced_at           INTEGER,
        connection_revision      INTEGER NOT NULL,
        degraded_reason          TEXT,
        reminder_state_json      TEXT NOT NULL DEFAULT '{}'
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS server_service_profiles (
        profile_id TEXT PRIMARY KEY,
        server_origin TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        organization_name TEXT NOT NULL,
        connection_revision TEXT NOT NULL,
        availability_status TEXT NOT NULL,
        UNIQUE(server_origin, organization_id)
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS server_service_models (
        service_profile_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        context_size INTEGER NOT NULL,
        protocols_json TEXT NOT NULL,
        availability_status TEXT NOT NULL,
        catalog_order INTEGER NOT NULL,
        codex_file_sha256 TEXT,
        PRIMARY KEY(service_profile_id, model_id),
        FOREIGN KEY(service_profile_id) REFERENCES server_service_profiles(profile_id) ON DELETE CASCADE
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS server_skill_versions (
        version_id          TEXT PRIMARY KEY,
        server_origin       TEXT NOT NULL,
        organization_id     TEXT NOT NULL,
        organization_name   TEXT,
        slug                TEXT NOT NULL,
        version             TEXT NOT NULL,
        name                TEXT NOT NULL,
        description         TEXT NOT NULL,
        sha256              TEXT NOT NULL,
        size_bytes          INTEGER NOT NULL,
        published_at        TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        download_url        TEXT NOT NULL,
        lifecycle_status    TEXT NOT NULL,
        connection_revision INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS server_skill_packages (
        package_id      TEXT PRIMARY KEY,
        version_id      TEXT NOT NULL,
        server_origin   TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        slug            TEXT NOT NULL,
        version         TEXT NOT NULL
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
    const serverSkillVersionColumns = rows(this.sql.exec('PRAGMA table_info(server_skill_versions)'))
    if (!serverSkillVersionColumns.some((column) => column.name === 'organization_name')) {
      this.sql.run('ALTER TABLE server_skill_versions ADD COLUMN organization_name TEXT')
    }
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS skill_source_identities (
        package_id          TEXT PRIMARY KEY,
        origin_kind         TEXT NOT NULL CHECK (origin_kind IN (
          'organization', 'local', 'github', 'gitlab', 'plugin', 'discovered'
        )),
        server_origin       TEXT,
        organization_id     TEXT,
        organization_name   TEXT,
        identity_status     TEXT NOT NULL CHECK (identity_status IN ('resolved', 'name_pending')),
        catalog_version_id  TEXT,
        artifact_sha256     TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS skill_cli_desired_states (
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
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS skill_removal_operations (
        package_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
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
        title                 TEXT,
        task_note             TEXT NOT NULL DEFAULT '',
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
      ['legacy_import_key', 'ALTER TABLE summary_reports ADD COLUMN legacy_import_key TEXT'],
      ['title', 'ALTER TABLE summary_reports ADD COLUMN title TEXT'],
      ['task_note', "ALTER TABLE summary_reports ADD COLUMN task_note TEXT NOT NULL DEFAULT ''"]
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
    this._migrateLegacyServerModelProfiles()
    this._backfillSessionServiceProfileSourceKinds()
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
      `INSERT INTO sessions (id, project_path, adapter_id, native_session_id, name, task_note, tier, model, system_model, provider, source_provider, provider_policy, explicit_provider, profile_id, profile_source_kind, adapter_config_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.project_path, s.adapter_id, s.native_session_id || null, s.name || null,
       s.task_note || '', s.tier, s.model || null,
       Object.hasOwn(s, 'system_model') ? (s.system_model || null) : (s.model || null),
       s.provider || null, s.source_provider || null, s.provider_policy || null, s.explicit_provider || null,
       s.profile_id || null, normalizeSessionProfileSourceKind(s.profile_source_kind),
       s.adapter_config_json || '{}', s.status, s.created_at, Date.now()]
    )
    this.sql.run(
      `INSERT OR IGNORE INTO session_stats (session_id) VALUES (?)`, [s.id]
    )
  }

  updateSession(sessionId, fields) {
    const allowed = ['native_session_id', 'name', 'task_note', 'status', 'model', 'system_model', 'provider', 'source_provider', 'provider_policy', 'explicit_provider', 'profile_id', 'profile_source_kind', 'adapter_config_json']
    const sets = []
    const vals = []
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k}=?`)
        vals.push(k === 'profile_source_kind' ? normalizeSessionProfileSourceKind(fields[k]) : fields[k])
      }
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
    return this.transactionSync(() => {
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
  async createSummaryReport(report) {
    assertSummaryReport(report)
    if (report.status === 'completed' || report.isCurrent === true) {
      throw summaryValidationError(
        'INVALID_SUMMARY_STATUS',
        'Completed summary reports require the dedicated completion or import path'
      )
    }
    return this.transactionSync(() => this.#insertSummaryReportSync(report))
  }

  async createQueuedSummaryReport(report) {
    if (report?.version !== undefined) {
      throw summaryValidationError('INVALID_SUMMARY_VERSION', 'Invalid summary report version')
    }
    const candidate = { ...report, version: 1 }
    assertSummaryReport(candidate)
    if (candidate.status !== 'queued' || candidate.isCurrent === true) {
      throw summaryValidationError('INVALID_SUMMARY_STATUS', 'Invalid queued summary report')
    }
    return this.transactionSync(() => {
      const latest = rows(this.sql.exec(
        `SELECT COALESCE(MAX(version), 0) AS version FROM summary_reports
         WHERE period_type = ? AND period_start = ?
           AND period_end_exclusive = ? AND timezone = ?`,
        [candidate.periodType, candidate.periodStart,
          candidate.periodEndExclusive, candidate.timezone]
      ))[0]
      return this.#insertSummaryReportSync({
        ...candidate,
        version: Number(latest?.version || 0) + 1
      })
    })
  }

  async updateSummaryTask(reportId, fields) {
    const metadata = normalizeSummaryTaskMetadata(fields)
    return this.transactionSync(() => {
      const target = this.getSummaryReport(reportId)
      if (!target) throw Object.assign(new Error('Summary report not found'), {
        code: 'SUMMARY_REPORT_NOT_FOUND'
      })
      const report = this.#updateSummaryReportSync(reportId, {
        ...metadata,
        updatedAt: fields.updatedAt
      })
      let sessionUpdated = false
      if (target.sessionId) {
        const other = rows(this.sql.exec(
          'SELECT id FROM summary_reports WHERE session_id = ? AND id <> ? LIMIT 1',
          [target.sessionId, reportId]
        ))[0]
        if (!other) {
          this.sql.run(
            `UPDATE sessions SET name = ?, task_note = ?, updated_at = ?
             WHERE id = ? AND removed_at IS NULL`,
            [metadata.title, metadata.taskNote, fields.updatedAt, target.sessionId]
          )
          sessionUpdated = this.sql.getRowsModified() > 0
        }
      }
      return { report, sessionId: target.sessionId || null, sessionUpdated }
    })
  }

  #insertSummaryReportSync(report) {
    assertSummaryReport(report)
    assertAutomaticDuplicateTarget(this, report, report.errorText)
    const metadata = normalizeSummaryTaskMetadata({
      title: report.title,
      taskNote: report.taskNote
    })
    const createdAt = Number.isFinite(report.createdAt) ? report.createdAt : Date.now()
    const updatedAt = Number.isFinite(report.updatedAt) ? report.updatedAt : createdAt
    this.sql.run(
      `INSERT INTO summary_reports (
         id, period_type, period_start, period_end_exclusive, timezone, partial,
         version, status, title, task_note, markdown, executor_id, profile_id, model,
         usage_snapshot_json, coverage_json, generation_usage_json, generation_metrics_json,
         generation_cost_usd, prompt_version, source_hash, is_current,
         generated_by, error_text, execution_mode, session_id, run_phase,
         artifact_metadata_json, legacy_import_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.id, report.periodType, report.periodStart, report.periodEndExclusive,
        report.timezone, report.partial ? 1 : 0, report.version, report.status,
        metadata.title, metadata.taskNote, report.markdown ?? null, report.executorId || null,
        report.profileId || null,
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

  async updateSummaryReport(reportId, fields = {}) {
    assertSummaryReportPatch(fields)
    if (fields.status === 'completed' || fields.runPhase === 'completed') {
      throw summaryValidationError(
        'INVALID_SUMMARY_STATUS',
        'Completed summary reports require the dedicated completion path'
      )
    }
    return this.transactionSync(() => this.#updateSummaryReportSync(reportId, fields))
  }

  #updateSummaryReportSync(reportId, fields = {}) {
    assertSummaryReportPatch(fields)
    const existing = this.getSummaryReport(reportId)
    const candidate = existing ? { ...existing, ...fields } : existing
    assertAutomaticDuplicateTarget(this, candidate, candidate?.errorText)
    if (fields.status !== undefined && fields.status !== 'completed' && existing?.isCurrent) {
      throw summaryValidationError(
        'SUMMARY_REPORT_NOT_COMPLETED',
        'A current summary report must remain completed'
      )
    }
    const columns = {
      status: 'status', title: 'title', taskNote: 'task_note', markdown: 'markdown', executorId: 'executor_id',
      profileId: 'profile_id', model: 'model', generationCostUsd: 'generation_cost_usd',
      promptVersion: 'prompt_version', sourceHash: 'source_hash', generatedBy: 'generated_by',
      errorText: 'error_text', executionMode: 'execution_mode', sessionId: 'session_id',
      runPhase: 'run_phase', legacyImportKey: 'legacy_import_key', updatedAt: 'updated_at'
    }
    const sets = []
    const values = []
    const metadata = fields.title !== undefined || fields.taskNote !== undefined
      ? normalizeSummaryTaskMetadata({
        title: fields.title ?? 'summary task',
        taskNote: fields.taskNote ?? ''
      })
      : null
    for (const [field, column] of Object.entries(columns)) {
      if (fields[field] === undefined) continue
      sets.push(`${column} = ?`)
      values.push(field === 'title' ? metadata.title : field === 'taskNote' ? metadata.taskNote : fields[field])
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
    assertSummaryCompletion(fields)
    return this.transactionSync(() => {
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
      this.#updateSummaryReportSync(reportId, fields)
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
    assertSummaryCompletion(report)
    return this.transactionSync(() => {
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
      const created = this.#insertSummaryReportSync({
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
    return this.transactionSync(() => {
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
    return this.transactionSync(() => {
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

      let removedSessionId = null
      if (target.sessionId) {
        const otherOwner = rows(this.sql.exec(
          'SELECT id FROM summary_reports WHERE session_id = ? AND id <> ? LIMIT 1',
          [target.sessionId, reportId]
        ))[0]
        if (!otherOwner) {
          const timestamp = Date.now()
          this.sql.run(
            `UPDATE sessions SET status = 'removed', removed_at = ?, updated_at = ? WHERE id = ?`,
            [timestamp, timestamp, target.sessionId]
          )
          if (this.sql.getRowsModified() > 0) {
            this.deactivateGatewayRoutesForSession(target.sessionId)
            removedSessionId = target.sessionId
          }
        }
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
      return { deletedReportId: reportId, currentReportId, removedSessionId }
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
         scope_type, scope_key, adapter_id, profile_id, model_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_type, scope_key, adapter_id) DO UPDATE SET
          profile_id = excluded.profile_id,
          model_id = excluded.model_id,
          updated_at = excluded.updated_at`,
      [
        binding.scopeType,
        binding.scopeKey,
        binding.adapterId,
        binding.profileId || null,
        binding.modelId || null,
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

  // ---- Server connection persistence ----
  getServerInstallation() {
    return rows(this.sql.exec('SELECT * FROM server_installation WHERE singleton_key = 1'))
      .map(rowToServerInstallation)[0] || null
  }

  createServerInstallation({ installationId, deviceName, createdAt }) {
    this.sql.run(
      `INSERT INTO server_installation (singleton_key, installation_id, device_name, created_at)
       VALUES (1, ?, ?, ?)`,
      [installationId, deviceName, createdAt]
    )
    return this.getServerInstallation()
  }

  getServerConnection(slot) {
    if (slot !== 'current' && slot !== 'candidate') return null
    return rows(this.sql.exec('SELECT * FROM server_connections WHERE slot = ?', [slot]))
      .map(rowToServerConnection)[0] || null
  }

  saveServerConnection(record) {
    this.sql.run(
      `INSERT INTO server_connections (
         id, slot, server_origin, refresh_token_ciphertext, account_id, account_display_name,
         organization_id, organization_name, authorization_expires_at, server_time,
         received_local_time, server_offset_ms, last_synced_at, connection_revision,
         degraded_reason, reminder_state_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         id = excluded.id,
         server_origin = excluded.server_origin,
         refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         account_id = excluded.account_id,
         account_display_name = excluded.account_display_name,
         organization_id = excluded.organization_id,
         organization_name = excluded.organization_name,
         authorization_expires_at = excluded.authorization_expires_at,
         server_time = excluded.server_time,
         received_local_time = excluded.received_local_time,
         server_offset_ms = excluded.server_offset_ms,
         last_synced_at = excluded.last_synced_at,
         connection_revision = excluded.connection_revision,
         degraded_reason = excluded.degraded_reason,
         reminder_state_json = excluded.reminder_state_json`,
      serverConnectionValues(record)
    )
    return this.getServerConnection(record.slot)
  }

  promoteServerConnection({ candidateId, nextRevision }) {
    const candidate = this.getServerConnection('candidate')
    if (!candidate || candidate.id !== candidateId) {
      throw Object.assign(new Error('Candidate server connection was not found'), {
        code: 'SERVER_CANDIDATE_NOT_FOUND'
      })
    }
    this.sql.run("DELETE FROM server_connections WHERE slot = 'current'")
    this.sql.run(
      "UPDATE server_connections SET slot = 'current', connection_revision = ? WHERE id = ? AND slot = 'candidate'",
      [nextRevision, candidateId]
    )
    return this.getServerConnection('current')
  }

  updateServerConnection(connectionId, fields = {}) {
    const columns = {
      serverOrigin: 'server_origin',
      refreshTokenCiphertext: 'refresh_token_ciphertext',
      accountId: 'account_id',
      accountDisplayName: 'account_display_name',
      organizationId: 'organization_id',
      organizationName: 'organization_name',
      authorizationExpiresAt: 'authorization_expires_at',
      serverTime: 'server_time',
      receivedLocalTime: 'received_local_time',
      serverOffsetMs: 'server_offset_ms',
      lastSyncedAt: 'last_synced_at',
      connectionRevision: 'connection_revision',
      degradedReason: 'degraded_reason'
    }
    const sets = []
    const values = []
    for (const [field, column] of Object.entries(columns)) {
      if (fields[field] === undefined) continue
      sets.push(`${column} = ?`)
      values.push(fields[field])
    }
    if (fields.reminderState !== undefined) {
      sets.push('reminder_state_json = ?')
      values.push(stringifyJsonObject(fields.reminderState))
    }
    if (!sets.length) return false
    values.push(connectionId)
    this.sql.run(`UPDATE server_connections SET ${sets.join(', ')} WHERE id = ?`, values)
    return this.sql.getRowsModified() > 0
  }

  clearServerConnections() {
    this._runImmediateTransaction(() => {
      this.clearServerServiceCatalog()
      this.sql.run('DELETE FROM server_skill_versions')
      this.sql.run('DELETE FROM server_connections')
    })
  }

  clearCurrentServerConnection({ connectionId }) {
    return this._runImmediateTransaction(() => {
      this.sql.run("DELETE FROM server_connections WHERE slot = 'current' AND id = ?", [connectionId])
      if (this.sql.getRowsModified() === 0) return false
      this.clearServerServiceCatalog()
      this.sql.run('DELETE FROM server_skill_versions')
      return true
    })
  }

  listServerModelProfiles() {
    const result = []
    for (const model of this.listServerServiceModels()) {
      for (const [adapterId, protocol] of Object.entries(SERVICE_ADAPTER_PROTOCOL)) {
        if (!model.protocols.includes(protocol)) continue
        result.push({
          profileId: model.serviceProfileId,
          serverOrigin: model.serverOrigin,
          organizationId: model.organizationId,
          organizationName: model.organizationName,
          modelId: model.modelId,
          adapterId,
          displayName: model.displayName,
          contextSize: model.contextSize,
          connectionRevision: model.connectionRevision,
          availabilityStatus: model.availabilityStatus,
          codexFileSha256: model.codexFileSha256
        })
      }
    }
    return result.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.profileId.localeCompare(right.profileId))
  }

  replaceServerModelProfiles({ connectionRevision, profiles }) {
    const catalogs = new Map()
    for (const legacy of profiles || []) {
      const profileId = stableServiceProfileId({
        serverOrigin: legacy.serverOrigin,
        organizationId: legacy.organizationId
      })
      const key = profileId
      const catalog = catalogs.get(key) || {
        profile: {
          id: profileId,
          serverOrigin: legacy.serverOrigin,
          organization: { id: legacy.organizationId, name: legacy.organizationName },
          connectionRevision: String(connectionRevision),
          availabilityStatus: legacy.availabilityStatus
        },
        models: new Map()
      }
      const protocol = SERVICE_ADAPTER_PROTOCOL[legacy.adapterId]
      if (protocol) {
        const model = catalog.models.get(legacy.modelId) || {
          id: legacy.modelId,
          displayName: legacy.displayName,
          contextSize: legacy.contextSize,
          protocols: [],
          availabilityStatus: legacy.availabilityStatus,
          codexFileSha256: legacy.codexFileSha256 ?? null
        }
        if (!model.protocols.includes(protocol)) model.protocols.push(protocol)
        catalog.models.set(legacy.modelId, model)
      }
      catalogs.set(key, catalog)
    }
    this._runImmediateTransaction(() => {
      for (const catalog of catalogs.values()) {
        this.replaceServerServiceCatalog({ ...catalog, models: [...catalog.models.values()] })
      }
    })
  }

  listServerServiceProfiles() {
    return rows(this.sql.exec(
      'SELECT * FROM server_service_profiles ORDER BY server_origin, organization_id'
    )).map(rowToServerServiceProfile)
  }

  listServerServiceModels(serviceProfileId = null) {
    const query = serviceProfileId == null
      ? `SELECT models.*, profiles.server_origin, profiles.organization_id, profiles.organization_name,
          profiles.connection_revision
         FROM server_service_models AS models
         JOIN server_service_profiles AS profiles ON profiles.profile_id = models.service_profile_id
         ORDER BY models.service_profile_id, models.catalog_order, models.model_id`
      : `SELECT models.*, profiles.server_origin, profiles.organization_id, profiles.organization_name,
          profiles.connection_revision
         FROM server_service_models AS models
         JOIN server_service_profiles AS profiles ON profiles.profile_id = models.service_profile_id
         WHERE models.service_profile_id = ?
         ORDER BY models.catalog_order, models.model_id`
    return rows(this.sql.exec(query, serviceProfileId == null ? [] : [serviceProfileId]))
      .map(rowToServerServiceModel)
  }

  replaceServerServiceCatalog({ profile, models }) {
    const organizationId = profile?.organization?.id ?? profile?.organizationId
    const organizationName = profile?.organization?.name ?? profile?.organizationName
    const profileId = stableServiceProfileId({ serverOrigin: profile?.serverOrigin, organizationId })
    const serverOrigin = profileId.slice(0, profileId.indexOf('::'))
    const catalogModels = Array.isArray(models) ? models : []
    for (const model of catalogModels) assertServiceModelProtocols(model)
    return this._runImmediateTransaction(() => {
      this.sql.run(
        `INSERT INTO server_service_profiles (
           profile_id, server_origin, organization_id, organization_name, connection_revision, availability_status
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           server_origin = excluded.server_origin,
           organization_id = excluded.organization_id,
           organization_name = excluded.organization_name,
           connection_revision = excluded.connection_revision,
           availability_status = excluded.availability_status`,
        [
          profileId, serverOrigin, organizationId, organizationName,
          String(profile.connectionRevision), profile.availabilityStatus
        ]
      )
      this.sql.run('DELETE FROM server_service_models WHERE service_profile_id = ?', [profileId])
      for (const [catalogOrder, model] of catalogModels.entries()) {
        this.sql.run(
          `INSERT INTO server_service_models (
             service_profile_id, model_id, display_name, context_size, protocols_json,
             availability_status, catalog_order, codex_file_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            profileId, model.id ?? model.modelId, model.displayName, model.contextSize,
            stringifyProtocolArray(model.protocols), model.availabilityStatus, catalogOrder,
            model.codexFileSha256 ?? null
          ]
        )
      }
      return this.listServerServiceProfiles().find((candidate) => candidate.profileId === profileId) || null
    })
  }

  updateServerServiceModelArtifact({ serviceProfileId, modelId, codexFileSha256 }) {
    this.sql.run(
      `UPDATE server_service_models SET codex_file_sha256 = ?
       WHERE service_profile_id = ? AND model_id = ?`,
      [codexFileSha256 ?? null, serviceProfileId, modelId]
    )
    return this.sql.getRowsModified() > 0
  }

  clearServerServiceCatalog() {
    return this._runImmediateTransaction(() => {
      this.sql.run('DELETE FROM server_service_models')
      this.sql.run('DELETE FROM server_service_profiles')
    })
  }

  _migrateLegacyServerModelProfiles() {
    const exists = rows(this.sql.exec(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'server_model_profiles'"
    )).length > 0
    if (!exists) return

    this._runImmediateTransaction(() => {
      const requiredColumns = [
        'profile_id', 'server_origin', 'organization_id', 'organization_name', 'model_id', 'adapter_id',
        'display_name', 'context_size', 'connection_revision', 'availability_status', 'codex_file_sha256'
      ]
      const columns = rows(this.sql.exec('PRAGMA table_info(server_model_profiles)')).map((column) => column.name)
      if (!requiredColumns.every((column) => columns.includes(column))) {
        return
      }

      const legacyRows = rows(this.sql.exec('SELECT * FROM server_model_profiles ORDER BY rowid'))
      const catalogs = new Map()
      const selectionByLegacyProfile = new Map()
      for (const legacy of legacyRows) {
        const protocol = SERVICE_ADAPTER_PROTOCOL[legacy.adapter_id]
        if (!protocol || !isLegacyServerModelProfile(legacy)) continue
        let profileId
        try {
          profileId = stableServiceProfileId({
            serverOrigin: legacy.server_origin,
            organizationId: legacy.organization_id
          })
        } catch {
          continue
        }
        const catalog = catalogs.get(profileId) || {
          profile: {
            id: profileId,
            serverOrigin: legacy.server_origin,
            organization: { id: legacy.organization_id, name: legacy.organization_name },
            connectionRevision: String(legacy.connection_revision),
            availabilityStatus: legacy.availability_status
          },
          models: new Map()
        }
        const model = catalog.models.get(legacy.model_id) || {
          id: legacy.model_id,
          displayName: legacy.display_name,
          contextSize: legacy.context_size,
          protocols: [],
          availabilityStatus: legacy.availability_status,
          codexFileSha256: legacy.codex_file_sha256 ?? null
        }
        if (!model.protocols.includes(protocol)) model.protocols.push(protocol)
        catalog.models.set(legacy.model_id, model)
        catalogs.set(profileId, catalog)

        const selection = { profileId, modelId: legacy.model_id, adapterId: legacy.adapter_id }
        const existing = selectionByLegacyProfile.get(legacy.profile_id) || []
        existing.push(selection)
        selectionByLegacyProfile.set(legacy.profile_id, existing)
      }

      for (const catalog of catalogs.values()) {
        const models = [...catalog.models.values()].sort((left, right) => left.id.localeCompare(right.id))
        this.replaceServerServiceCatalog({ profile: catalog.profile, models })
      }

      const localProfileIds = new Set(rows(this.sql.exec('SELECT id FROM ai_cli_profiles')).map((profile) => profile.id))
      const sessions = rows(this.sql.exec('SELECT id, adapter_id, model, profile_id FROM sessions WHERE profile_id IS NOT NULL'))
      for (const session of sessions) {
        const selection = uniquelyMappedSelection(selectionByLegacyProfile.get(session.profile_id), session.adapter_id)
        if (!selection) continue
        this.sql.run('UPDATE sessions SET profile_id = ?, model = ? WHERE id = ?', [selection.profileId, selection.modelId, session.id])
      }

      const bindings = rows(this.sql.exec('SELECT * FROM ai_cli_profile_bindings'))
      for (const binding of bindings) {
        if (binding.profile_id == null || localProfileIds.has(binding.profile_id)) continue
        const selection = uniquelyMappedSelection(selectionByLegacyProfile.get(binding.profile_id), binding.adapter_id)
        if (!selection) {
          this.sql.run(
            `DELETE FROM ai_cli_profile_bindings
             WHERE scope_type = ? AND scope_key = ? AND adapter_id = ?`,
            [binding.scope_type, binding.scope_key, binding.adapter_id]
          )
          continue
        }
        this.sql.run(
          `UPDATE ai_cli_profile_bindings SET profile_id = ?, model_id = ?
           WHERE scope_type = ? AND scope_key = ? AND adapter_id = ?`,
          [selection.profileId, selection.modelId, binding.scope_type, binding.scope_key, binding.adapter_id]
        )
      }

      this._testHooks?.beforeLegacyServerModelTableDrop?.(Object.freeze({
        run: (statement, params = []) => this.sql.run(statement, params)
      }))
      this.sql.run('DROP TABLE server_model_profiles')
    })
  }

  _backfillSessionServiceProfileSourceKinds() {
    this.sql.run(`
      UPDATE sessions
      SET profile_source_kind = 'server'
      WHERE profile_source_kind IS NULL
        AND profile_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM server_service_profiles
          WHERE server_service_profiles.profile_id = sessions.profile_id
        )
    `)
  }

  replaceServerSkillVersions({ connectionRevision, versions }) {
    this.sql.run('DELETE FROM server_skill_versions')
    for (const version of versions) {
      this.sql.run(
        `INSERT INTO server_skill_versions (
         version_id, server_origin, organization_id, organization_name, slug, version, name, description, sha256,
           size_bytes, published_at, created_at, download_url, lifecycle_status, connection_revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          version.versionId, version.serverOrigin, version.organizationId, version.organizationName ?? null, version.slug, version.version,
          version.name, version.description, version.sha256, version.sizeBytes, version.publishedAt,
          version.createdAt, version.downloadUrl, version.lifecycleStatus, connectionRevision
        ]
      )
    }
  }

  listServerSkillVersions() {
    return rows(this.sql.exec(
      'SELECT * FROM server_skill_versions ORDER BY created_at, version_id'
    )).map(rowToServerSkillVersion)
  }

  getServerSkillVersion(versionId) {
    return rows(this.sql.exec('SELECT * FROM server_skill_versions WHERE version_id = ?', [versionId]))
      .map(rowToServerSkillVersion)[0] || null
  }

  clearServerSkillVersions() {
    this.sql.run('DELETE FROM server_skill_versions')
  }

  linkServerSkillPackage(mapping) {
    this.sql.run(
      `INSERT INTO server_skill_packages (
         package_id, version_id, server_origin, organization_id, slug, version
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(package_id) DO UPDATE SET
         version_id = excluded.version_id,
         server_origin = excluded.server_origin,
         organization_id = excluded.organization_id,
         slug = excluded.slug,
         version = excluded.version`,
      [
        mapping.packageId, mapping.versionId, mapping.serverOrigin, mapping.organizationId,
        mapping.slug, mapping.version
      ]
    )
  }

  getServerSkillPackage(packageId) {
    return rows(this.sql.exec('SELECT * FROM server_skill_packages WHERE package_id = ?', [packageId]))
      .map(rowToServerSkillPackage)[0] || null
  }

  findServerSkillPackage({ serverOrigin, organizationId, slug, version }) {
    return rows(this.sql.exec(
      `SELECT * FROM server_skill_packages
       WHERE server_origin = ? AND organization_id = ? AND slug = ? AND version = ?`,
      [serverOrigin, organizationId, slug, version]
    )).map(rowToServerSkillPackage)[0] || null
  }

  findServerSkillPackageForSkill({ serverOrigin, organizationId, slug }) {
    return rows(this.sql.exec(
      `SELECT * FROM server_skill_packages
       WHERE server_origin = ? AND organization_id = ? AND slug = ?`,
      [serverOrigin, organizationId, slug]
    )).map(rowToServerSkillPackage)[0] || null
  }

  listServerSkillPackagesForSkill({ serverOrigin, organizationId, slug }) {
    return rows(this.sql.exec(
      `SELECT * FROM server_skill_packages
       WHERE server_origin = ? AND organization_id = ? AND slug = ? ORDER BY package_id`,
      [serverOrigin, organizationId, slug]
    )).map(rowToServerSkillPackage)
  }

  listServerSkillPackages() {
    return rows(this.sql.exec('SELECT * FROM server_skill_packages ORDER BY package_id'))
      .map(rowToServerSkillPackage)
  }

  removeServerSkillPackage(packageId) {
    this.sql.run('DELETE FROM server_skill_packages WHERE package_id = ?', [packageId])
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
    return this._runImmediateTransaction(() => {
      this.removeServerSkillPackage(packageId)
      this.deleteSkillSourceIdentity(packageId)
      this.deleteSkillCliDesiredStates(packageId)
      this.sql.run('DELETE FROM skill_packages WHERE id = ?', [packageId])
      return this.sql.getRowsModified() > 0
    })
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

  upsertSkillSourceIdentity(identity) {
    const value = normalizeSkillSourceIdentity(identity)
    assertSkillPackageExists(this, value.packageId, 'SKILL_SOURCE_IDENTITY_INVALID')
    this.sql.run(
      `INSERT INTO skill_source_identities (
         package_id, origin_kind, server_origin, organization_id, organization_name,
         identity_status, catalog_version_id, artifact_sha256, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(package_id) DO UPDATE SET
         origin_kind = excluded.origin_kind,
         server_origin = excluded.server_origin,
         organization_id = excluded.organization_id,
         organization_name = excluded.organization_name,
         identity_status = excluded.identity_status,
         catalog_version_id = excluded.catalog_version_id,
         artifact_sha256 = excluded.artifact_sha256,
         updated_at = excluded.updated_at`,
      [
        value.packageId, value.originKind, value.serverOrigin, value.organizationId,
        value.organizationName, value.identityStatus, value.catalogVersionId, value.artifactSha256,
        value.createdAt, value.updatedAt
      ]
    )
    return this.getSkillSourceIdentity(value.packageId)
  }

  getSkillSourceIdentity(packageId) {
    return rows(this.sql.exec(
      'SELECT * FROM skill_source_identities WHERE package_id = ?', [packageId]
    )).map(rowToSkillSourceIdentity)[0] || null
  }

  listSkillSourceIdentities() {
    return rows(this.sql.exec('SELECT * FROM skill_source_identities ORDER BY package_id'))
      .map(rowToSkillSourceIdentity)
  }

  deleteSkillSourceIdentity(packageId) {
    this.sql.run('DELETE FROM skill_source_identities WHERE package_id = ?', [packageId])
    return this.sql.getRowsModified() > 0
  }

  upsertSkillCliDesiredState(state) {
    const value = normalizeSkillCliDesiredState(state)
    assertSkillPackageExists(this, value.packageId, 'SKILL_CLI_DESIRED_STATE_INVALID')
    this.sql.run(
      `INSERT INTO skill_cli_desired_states (
         package_id, scope_type, scope_key, adapter_id, desired_state,
         enforcement_status, reason_code, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(package_id, scope_type, scope_key, adapter_id) DO UPDATE SET
         desired_state = excluded.desired_state,
         enforcement_status = excluded.enforcement_status,
         reason_code = excluded.reason_code,
         updated_at = excluded.updated_at`,
      [
        value.packageId, value.scopeType, value.scopeKey, value.adapterId, value.desiredState,
        value.enforcementStatus, value.reasonCode, value.updatedAt
      ]
    )
    return this.listSkillCliDesiredStates({
      packageId: value.packageId,
      scopeType: value.scopeType,
      scopeKey: value.scopeKey,
      adapterId: value.adapterId
    })[0] || null
  }

  listSkillCliDesiredStates(filters = {}) {
    const columns = {
      packageId: 'package_id', scopeType: 'scope_type', scopeKey: 'scope_key', adapterId: 'adapter_id'
    }
    const clauses = []
    const values = []
    for (const [field, column] of Object.entries(columns)) {
      if (filters[field] === undefined) continue
      clauses.push(`${column} = ?`)
      values.push(filters[field])
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return rows(this.sql.exec(
      `SELECT * FROM skill_cli_desired_states${where}
       ORDER BY package_id, scope_type, scope_key, adapter_id`,
      values
    )).map(rowToSkillCliDesiredState)
  }

  deleteSkillCliDesiredStates(packageId) {
    this.sql.run('DELETE FROM skill_cli_desired_states WHERE package_id = ?', [packageId])
    return this.sql.getRowsModified() > 0
  }

  recordSkillRemovalOperation(operation) {
    const value = normalizeSkillRemovalOperation(operation)
    this.sql.run(
      `INSERT INTO skill_removal_operations (package_id, created_at)
       VALUES (?, ?)
       ON CONFLICT(package_id) DO UPDATE SET created_at = excluded.created_at`,
      [value.packageId, value.createdAt]
    )
    return this.getSkillRemovalOperation(value.packageId)
  }

  getSkillRemovalOperation(packageId) {
    return rows(this.sql.exec(
      'SELECT * FROM skill_removal_operations WHERE package_id = ?', [packageId]
    )).map(rowToSkillRemovalOperation)[0] || null
  }

  listSkillRemovalOperations() {
    return rows(this.sql.exec(
      'SELECT * FROM skill_removal_operations ORDER BY created_at, package_id'
    )).map(rowToSkillRemovalOperation)
  }

  deleteSkillRemovalOperation(packageId) {
    this.sql.run('DELETE FROM skill_removal_operations WHERE package_id = ?', [packageId])
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
      this._transactionActive = true
      try {
        const result = await work()
        this.sql.run('COMMIT')
        return result
      } catch (error) {
        try { this.sql.run('ROLLBACK') } catch { /* preserve original error */ }
        throw error
      } finally {
        this._transactionActive = false
      }
    }
    const result = this._transactionTail.then(run, run)
    this._transactionTail = result.catch(() => {})
    return result
  }

  transactionSync(work) {
    const run = () => {
      this.sql.run('BEGIN IMMEDIATE')
      this._transactionActive = true
      try {
        const result = work()
        if (result && typeof result.then === 'function') {
          throw Object.assign(new TypeError('Database transactions must be synchronous'), {
            code: 'ASYNC_DATABASE_TRANSACTION_FORBIDDEN'
          })
        }
        this.sql.run('COMMIT')
        return result
      } catch (error) {
        try { this.sql.run('ROLLBACK') } catch { /* preserve original error */ }
        throw error
      } finally {
        this._transactionActive = false
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
    if (this._transactionActive) return false
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

const SERVICE_MODEL_PROTOCOLS = Object.freeze([
  'openai_responses', 'openai_chat', 'anthropic_messages'
])
const SERVICE_MODEL_PROTOCOL_SET = new Set(SERVICE_MODEL_PROTOCOLS)

function canonicalServiceModelProtocols(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((protocol) => !SERVICE_MODEL_PROTOCOL_SET.has(protocol))) return null
  const seen = new Set(value)
  return SERVICE_MODEL_PROTOCOLS.filter((protocol) => seen.has(protocol))
}

function parseProtocolArray(value) {
  if (typeof value !== 'string') return []
  try {
    const protocols = JSON.parse(value)
    return canonicalServiceModelProtocols(protocols) || []
  } catch {
    return []
  }
}

function stringifyProtocolArray(value) {
  return JSON.stringify(canonicalServiceModelProtocols(value))
}

function assertServiceModelProtocols(model) {
  if (!canonicalServiceModelProtocols(model?.protocols)) {
    throw Object.assign(new TypeError('Service model protocols must be a non-empty public protocol array'), {
      code: 'INVALID_SERVICE_MODEL_PROTOCOLS'
    })
  }
}

function isLegacyServerModelProfile(row) {
  return [
    row.profile_id, row.server_origin, row.organization_id, row.organization_name,
    row.model_id, row.adapter_id, row.display_name, row.availability_status
  ].every((value) => typeof value === 'string' && value.trim() !== '') &&
    Number.isSafeInteger(row.context_size) && row.context_size > 0
}

function uniquelyMappedSelection(selections, adapterId) {
  const matches = (selections || []).filter((selection) => selection.adapterId === adapterId)
  return matches.length === 1 ? matches[0] : null
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
function assertSummaryJson(value, field) {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw summaryValidationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  try {
    normalizeSummaryJsonField(value, field)
  } catch (error) {
    if (field !== 'artifactMetadata' || error?.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN') {
      throw error
    }
    throw summaryValidationError(
      'INVALID_SUMMARY_ARTIFACT_METADATA',
      'Invalid summary artifact metadata'
    )
  }
}

function assertSummaryErrorText(value) {
  if (value !== undefined && !isPersistedSummaryErrorText(value)) {
    throw summaryValidationError('INVALID_SUMMARY_ERROR_CODE', 'Invalid summary error code')
  }
}

function assertAutomaticDuplicateTarget(db, report, errorText) {
  const targetId = summaryAutomaticDuplicateReportId(errorText)
  if (!targetId) return
  const target = db.getSummaryReport(targetId)
  if (!report || !target || report.generatedBy !== 'automatic' ||
    !report.sourceHash || target.sourceHash !== report.sourceHash ||
    target.status !== 'completed' ||
    target.periodType !== report.periodType || target.periodStart !== report.periodStart ||
    target.periodEndExclusive !== report.periodEndExclusive || target.timezone !== report.timezone) {
    throw summaryValidationError('INVALID_SUMMARY_ERROR_CODE', 'Invalid summary error code')
  }
}

function assertSummaryCompletion(fields) {
  if (typeof fields.markdown !== 'string' || !fields.markdown.trim()) {
    throw summaryValidationError(
      'INVALID_SUMMARY_CANONICAL_REPORT',
      'Invalid canonical summary report'
    )
  }
  assertSafeSummaryHash(fields.sourceHash)
  normalizeCompletedArtifactMetadata(fields.markdown, fields.artifactMetadata)
}

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
  assertSummaryErrorText(report.errorText)
  normalizeSummaryTaskMetadata({ title: report.title, taskNote: report.taskNote })
  for (const field of [
    'usageSnapshot', 'coverage', 'generationUsage', 'generationMetrics', 'artifactMetadata'
  ]) assertSummaryJson(report[field], field)
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
  assertSummaryErrorText(fields.errorText)
  if (fields.title !== undefined || fields.taskNote !== undefined) {
    normalizeSummaryTaskMetadata({
      title: fields.title ?? 'summary task',
      taskNote: fields.taskNote ?? ''
    })
  }
  for (const field of [
    'usageSnapshot', 'coverage', 'generationUsage', 'generationMetrics', 'artifactMetadata'
  ]) assertSummaryJson(fields[field], field)
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
    title: row.title ?? null,
    taskNote: row.task_note ?? '',
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
    modelId: row.model_id || null,
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

function serverConnectionValues(record) {
  return [
    record.id, record.slot, record.serverOrigin, record.refreshTokenCiphertext,
    record.accountId, record.accountDisplayName, record.organizationId, record.organizationName,
    record.authorizationExpiresAt ?? null, record.serverTime ?? null, record.receivedLocalTime,
    record.serverOffsetMs, record.lastSyncedAt ?? null, record.connectionRevision,
    record.degradedReason ?? null, stringifyJsonObject(record.reminderState)
  ]
}

function rowToServerInstallation(row) {
  return {
    installationId: row.installation_id,
    deviceName: row.device_name,
    createdAt: row.created_at
  }
}

function rowToServerConnection(row) {
  return {
    id: row.id,
    slot: row.slot,
    serverOrigin: row.server_origin,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    accountId: row.account_id,
    accountDisplayName: row.account_display_name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    authorizationExpiresAt: row.authorization_expires_at ?? null,
    serverTime: row.server_time ?? null,
    receivedLocalTime: row.received_local_time,
    serverOffsetMs: row.server_offset_ms,
    lastSyncedAt: row.last_synced_at ?? null,
    connectionRevision: row.connection_revision,
    degradedReason: row.degraded_reason ?? null,
    reminderState: parseJsonObject(row.reminder_state_json)
  }
}

function rowToServerModelProfile(row) {
  return {
    profileId: row.profile_id,
    serverOrigin: row.server_origin,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    modelId: row.model_id,
    adapterId: row.adapter_id,
    displayName: row.display_name,
    contextSize: row.context_size,
    connectionRevision: row.connection_revision,
    availabilityStatus: row.availability_status,
    codexFileSha256: row.codex_file_sha256 ?? null
  }
}

function rowToServerServiceProfile(row) {
  return {
    profileId: row.profile_id,
    serverOrigin: row.server_origin,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    connectionRevision: row.connection_revision,
    availabilityStatus: row.availability_status
  }
}

function rowToServerServiceModel(row) {
  return {
    serviceProfileId: row.service_profile_id,
    serverOrigin: row.server_origin,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    connectionRevision: row.connection_revision,
    modelId: row.model_id,
    displayName: row.display_name,
    contextSize: row.context_size,
    protocols: parseProtocolArray(row.protocols_json),
    availabilityStatus: row.availability_status,
    catalogOrder: row.catalog_order,
    codexFileSha256: row.codex_file_sha256 ?? null
  }
}

function rowToServerSkillVersion(row) {
  return {
    versionId: row.version_id,
    serverOrigin: row.server_origin,
    organizationId: row.organization_id,
    ...(row.organization_name == null ? {} : { organizationName: row.organization_name }),
    slug: row.slug,
    version: row.version,
    name: row.name,
    description: row.description,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    downloadUrl: row.download_url,
    lifecycleStatus: row.lifecycle_status,
    connectionRevision: row.connection_revision
  }
}

function rowToServerSkillPackage(row) {
  return {
    packageId: row.package_id,
    versionId: row.version_id,
    serverOrigin: row.server_origin,
    organizationId: row.organization_id,
    slug: row.slug,
    version: row.version
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

const SKILL_SOURCE_ORIGIN_KINDS = new Set([
  'organization', 'local', 'github', 'gitlab', 'plugin', 'discovered'
])
const SKILL_IDENTITY_STATUSES = new Set(['resolved', 'name_pending'])
const SKILL_SCOPE_TYPES = new Set(['user', 'project'])
const SKILL_DESIRED_STATES = new Set(['enabled', 'disabled', 'inherit'])
const SKILL_ENFORCEMENT_STATUSES = new Set([
  'satisfied', 'migration_required', 'blocked', 'error', 'recovery_required'
])
const SKILL_ARTIFACT_SHA256 = /^[a-f0-9]{64}$/
const SKILL_REMOVAL_OPERATION_PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function skillMetadataError(code, message) {
  return Object.assign(new TypeError(message), { code })
}

function requireNonEmptyString(value, code, message) {
  if (typeof value !== 'string' || !value.trim()) throw skillMetadataError(code, message)
  return value
}

function requireTimestamp(value, code) {
  if (!Number.isInteger(value) || value < 0) {
    throw skillMetadataError(code, 'Skill metadata timestamp is invalid')
  }
  return value
}

function normalizeSkillSourceIdentity(value) {
  const code = 'SKILL_SOURCE_IDENTITY_INVALID'
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SKILL_SOURCE_ORIGIN_KINDS.has(value.originKind)) {
    throw skillMetadataError(code, 'Skill source identity is invalid')
  }
  const packageId = requireNonEmptyString(value.packageId, code, 'Skill source identity is invalid')
  if (!SKILL_IDENTITY_STATUSES.has(value.identityStatus)) {
    throw skillMetadataError(code, 'Skill source identity is invalid')
  }
  const organization = value.originKind === 'organization'
  if (!organization) {
    if (value.serverOrigin != null || value.organizationId != null || value.organizationName != null ||
      value.catalogVersionId != null || value.artifactSha256 != null || value.identityStatus !== 'resolved') {
      throw skillMetadataError(code, 'Skill source identity is invalid')
    }
    return {
      packageId,
      originKind: value.originKind,
      serverOrigin: null,
      organizationId: null,
      organizationName: null,
      identityStatus: 'resolved',
      catalogVersionId: null,
      artifactSha256: null,
      createdAt: requireTimestamp(value.createdAt, code),
      updatedAt: requireTimestamp(value.updatedAt, code)
    }
  }

  let serverOrigin
  try {
    serverOrigin = new URL(requireNonEmptyString(value.serverOrigin, code, 'Skill source identity is invalid')).origin
  } catch {
    throw skillMetadataError(code, 'Skill source identity is invalid')
  }
  const organizationId = requireNonEmptyString(value.organizationId, code, 'Skill source identity is invalid')
  const organizationName = requireNonEmptyString(value.organizationName, code, 'Skill source identity is invalid')
  const catalogVersionId = requireNonEmptyString(value.catalogVersionId, code, 'Skill source identity is invalid')
  if (typeof value.artifactSha256 !== 'string' || !SKILL_ARTIFACT_SHA256.test(value.artifactSha256)) {
    throw skillMetadataError(code, 'Skill source identity is invalid')
  }
  return {
    packageId,
    originKind: 'organization',
    serverOrigin,
    organizationId,
    organizationName,
    identityStatus: value.identityStatus,
    catalogVersionId,
    artifactSha256: value.artifactSha256,
    createdAt: requireTimestamp(value.createdAt, code),
    updatedAt: requireTimestamp(value.updatedAt, code)
  }
}

function normalizeSkillCliDesiredState(value) {
  const code = 'SKILL_CLI_DESIRED_STATE_INVALID'
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !SKILL_SCOPE_TYPES.has(value.scopeType) || !SKILL_DESIRED_STATES.has(value.desiredState) ||
    !SKILL_ENFORCEMENT_STATUSES.has(value.enforcementStatus)) {
    throw skillMetadataError(code, 'Skill CLI desired state is invalid')
  }
  if (value.reasonCode != null && (typeof value.reasonCode !== 'string' || !value.reasonCode.trim())) {
    throw skillMetadataError(code, 'Skill CLI desired state is invalid')
  }
  return {
    packageId: requireNonEmptyString(value.packageId, code, 'Skill CLI desired state is invalid'),
    scopeType: value.scopeType,
    scopeKey: requireNonEmptyString(value.scopeKey, code, 'Skill CLI desired state is invalid'),
    adapterId: requireNonEmptyString(value.adapterId, code, 'Skill CLI desired state is invalid'),
    desiredState: value.desiredState,
    enforcementStatus: value.enforcementStatus,
    reasonCode: value.reasonCode ?? null,
    updatedAt: requireTimestamp(value.updatedAt, code)
  }
}

function normalizeSkillRemovalOperation(value) {
  const code = 'SKILL_REMOVAL_OPERATION_INVALID'
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw skillMetadataError(code, 'Skill removal operation is invalid')
  }
  const packageId = requireNonEmptyString(value.packageId, code, 'Skill removal operation is invalid')
  if (!SKILL_REMOVAL_OPERATION_PACKAGE_ID.test(packageId)) {
    throw skillMetadataError(code, 'Skill removal operation is invalid')
  }
  return { packageId, createdAt: requireTimestamp(value.createdAt, code) }
}

function assertSkillPackageExists(db, packageId, code) {
  if (!db.getSkillPackage(packageId)) {
    throw skillMetadataError(code, 'Skill package is not available')
  }
}

function rowToSkillSourceIdentity(row) {
  return {
    packageId: row.package_id,
    originKind: row.origin_kind,
    serverOrigin: row.server_origin ?? null,
    organizationId: row.organization_id ?? null,
    organizationName: row.organization_name ?? null,
    identityStatus: row.identity_status,
    catalogVersionId: row.catalog_version_id ?? null,
    artifactSha256: row.artifact_sha256 ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToSkillCliDesiredState(row) {
  return {
    packageId: row.package_id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    adapterId: row.adapter_id,
    desiredState: row.desired_state,
    enforcementStatus: row.enforcement_status,
    reasonCode: row.reason_code ?? null,
    updatedAt: row.updated_at
  }
}

function rowToSkillRemovalOperation(row) {
  return normalizeSkillRemovalOperation({ packageId: row.package_id, createdAt: row.created_at })
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
    profileSourceKind: normalizeSessionProfileSourceKind(row.profile_source_kind),
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

function normalizeSessionProfileSourceKind(value) {
  return value === 'server' ? 'server' : null
}
