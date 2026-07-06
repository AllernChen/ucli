import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
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
    const init = await import('sql.js')
    // sql.js default export is `initSqlJs()`, an async function that returns
    // the SQL module (which has `.Database`, `.Statement`, etc.)
    const initFn = init.default || init
    SQL = await initFn()
  }
  let buffer
  if (existsSync(dbPath)) {
    buffer = readFileSync(dbPath)
  }
  const instance = new SQL.Database(buffer)
  const db = new Db(instance, dbPath)
  db._ensureSchema()
  return db
}

// singleton — set by orchestrator after openDb
let _db = null
export function getDb() { return _db }

class Db {
  constructor(sql, path) {
    this.sql = sql
    this.path = path
    _db = this
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
        status            TEXT DEFAULT 'offline',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS session_stats (
        session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd      REAL DEFAULT 0,
        turns_count   INTEGER DEFAULT 0,
        auto_allowed  INTEGER DEFAULT 0,
        confirmed     INTEGER DEFAULT 0,
        denied        INTEGER DEFAULT 0
      )
    `)
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS model_stats (
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model         TEXT NOT NULL,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd      REAL DEFAULT 0,
        PRIMARY KEY (session_id, model)
      )
    `)
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
      `INSERT INTO sessions (id, project_path, adapter_id, native_session_id, name, task_note, tier, model, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.project_path, s.adapter_id, s.native_session_id || null, s.name || null,
       s.task_note || '', s.tier, s.model || null, s.status, s.created_at, Date.now()]
    )
    this.sql.run(
      `INSERT OR IGNORE INTO session_stats (session_id) VALUES (?)`, [s.id]
    )
  }

  updateSession(sessionId, fields) {
    const allowed = ['native_session_id', 'name', 'task_note', 'status']
    const sets = []
    const vals = []
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]) }
    }
    if (!sets.length) return
    sets.push('updated_at=?'); vals.push(Date.now()); vals.push(sessionId)
    this.sql.run(`UPDATE sessions SET ${sets.join(',')} WHERE id=?`, vals)
  }

  deleteSession(id) {
    this.sql.run('DELETE FROM session_stats WHERE session_id=?', [id])
    this.sql.run('DELETE FROM sessions WHERE id=?', [id])
  }

  listSessions() {
    const r = this.sql.exec(
      `SELECT s.*,
              st.input_tokens, st.output_tokens, st.cost_usd, st.turns_count,
              st.auto_allowed, st.confirmed, st.denied
       FROM sessions s
       LEFT JOIN session_stats st ON st.session_id = s.id
       ORDER BY s.updated_at DESC`
    )
    return rows(r).map(rowToSession)
  }

  getSession(id) {
    const r = this.sql.exec(
      `SELECT s.*,
              st.input_tokens, st.output_tokens, st.cost_usd, st.turns_count,
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
    // Accumulate into the summary — each call ADDS the delta.
    this.sql.run(
      `INSERT INTO session_stats (session_id, input_tokens, output_tokens, cost_usd, turns_count, auto_allowed, confirmed, denied)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens  = input_tokens  + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cost_usd      = max(cost_usd, excluded.cost_usd),
         turns_count   = turns_count   + excluded.turns_count,
         auto_allowed  = auto_allowed  + excluded.auto_allowed,
         confirmed     = confirmed     + excluded.confirmed,
         denied        = denied        + excluded.denied`,
      [sessionId, stats.inputTokens || 0, stats.outputTokens || 0, stats.costUsd || 0,
       stats.turnsDelta || 0, stats.autoAllowed || 0, stats.confirmed || 0, stats.denied || 0]
    )
  }

  // ---- per-model stats ----
  upsertModelStats(sessionId, model, stats) {
    this.sql.run(
      `INSERT INTO model_stats (session_id, model, input_tokens, output_tokens, cost_usd)
       VALUES (?,?,?,?,?)
       ON CONFLICT(session_id, model) DO UPDATE SET
         input_tokens  = input_tokens  + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cost_usd      = MAX(cost_usd, excluded.cost_usd)`,
      [sessionId, model, stats.inputTokens || 0, stats.outputTokens || 0, stats.costUsd || 0]
    )
  }

  getModelStats() {
    const r = this.sql.exec(
      `SELECT model,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_usd)      AS cost_usd,
              COUNT(DISTINCT session_id) AS session_count
       FROM model_stats
       GROUP BY model
       ORDER BY input_tokens DESC`
    )
    return rows(r)
  }

  getModelStatsForSession(sessionId) {
    const r = this.sql.exec(
      'SELECT model, input_tokens, output_tokens, cost_usd FROM model_stats WHERE session_id=?', [sessionId]
    )
    return rows(r)
  }

  /** Full aggregate for the stats dashboard. */
  getStats() {
    const r = this.sql.exec(
      `SELECT s.project_path, s.adapter_id,
              SUM(st.input_tokens)  AS input_tokens,
              SUM(st.output_tokens) AS output_tokens,
              SUM(st.cost_usd)      AS cost_usd,
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
            `INSERT INTO session_stats (session_id, input_tokens, output_tokens, cost_usd, turns_count, auto_allowed, confirmed, denied)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(session_id) DO UPDATE SET
               input_tokens = excluded.input_tokens,
               output_tokens = excluded.output_tokens,
               cost_usd = excluded.cost_usd,
               turns_count = excluded.turns_count,
               auto_allowed = excluded.auto_allowed,
               confirmed = excluded.confirmed,
               denied = excluded.denied`,
            [id,
             s.stats?.tokens?.input || s.stats?.input_tokens || 0,
             s.stats?.tokens?.output || s.stats?.output_tokens || 0,
             s.stats?.costUsd || s.stats?.cost_usd || 0,
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
      writeFileSync(this.path, data)
    } catch { /* best effort */ }
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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: {
      tokens: { input: row.input_tokens || 0, output: row.output_tokens || 0 },
      costUsd: row.cost_usd || 0,
      turns: row.turns_count || 0,
      approvals: {
        autoAllowed: row.auto_allowed || 0,
        confirmed: row.confirmed || 0,
        denied: row.denied || 0
      }
    }
  }
}
