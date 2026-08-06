import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync
} from 'fs'
import { join } from 'path'

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
export async function openDb(dbPath) {
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
    db._ensureSchema()
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
        db._ensureSchema()
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
      db._ensureSchema()
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
  }

  // ---- schema ----
  _ensureSchema() {
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
        provider          TEXT,
        source_provider   TEXT,
        provider_policy   TEXT,
        explicit_provider TEXT,
        profile_id        TEXT,
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
      `INSERT INTO sessions (id, project_path, adapter_id, native_session_id, name, task_note, tier, model, provider, source_provider, provider_policy, explicit_provider, profile_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.project_path, s.adapter_id, s.native_session_id || null, s.name || null,
       s.task_note || '', s.tier, s.model || null, s.provider || null, s.source_provider || null, s.provider_policy || null, s.explicit_provider || null,
       s.profile_id || null, s.status, s.created_at, Date.now()]
    )
    this.sql.run(
      `INSERT OR IGNORE INTO session_stats (session_id) VALUES (?)`, [s.id]
    )
  }

  updateSession(sessionId, fields) {
    const allowed = ['native_session_id', 'name', 'task_note', 'status', 'model', 'provider', 'source_provider', 'provider_policy', 'explicit_provider', 'profile_id']
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
    provider: row.provider || null,
    sourceProvider: row.source_provider || null,
    providerPolicy: row.provider_policy || null,
    explicitProvider: row.explicit_provider || null,
    profileId: row.profile_id || null,
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
