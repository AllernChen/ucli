import { app, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, readdirSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { PermissionEngine } from './permission/engine.js'
import { startHookServer } from './permission/hookServer.js'
import { describeBlacklist } from './permission/blacklist.js'
import { classify, toClassifierInput, parsePattern } from './permission/classifier.js'
import { claudeDescriptor } from './adapters/claudeAdapter.js'
import { codexDescriptor } from './adapters/codexAdapter.js'
import { TIER } from './adapters/cliAdapter.js'
import { openDb, getDb } from './persistence/db.js'

const DEFAULT_RULESET = {
  id: 'default',
  name: '默认规则集',
  deny: [],
  highRisk: [
    'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(git push:*)', 'Bash(git reset --hard:*)',
    'Bash(git clean -fd:*)', 'Bash(npm publish:*)', 'Bash(docker rm:*)', 'Bash(docker rmi:*)',
    'Bash(docker system prune:*)', 'Bash(sudo:*)', 'Bash(chmod:*)',
    'Bash(re:curl\\s.*\\|\\s*(sh|bash))', 'Bash(re:wget\\s.*\\|\\s*(sh|bash))',
    'Write(.env*)', 'Edit(.env*)', 'Write(~/.ssh/**)', 'Edit(~/.ssh/**)',
    'Write(~/.aws/**)', 'Edit(~/.gitconfig)'
  ],
  allow: [
    'Bash(ls:*)', 'Bash(cat:*)', 'Bash(pwd:*)', 'Bash(git status:*)',
    'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(echo:*)',
    'Read(*)'
  ]
}

const DEFAULT_SETTINGS = {
  defaultTier: TIER.SAFETY_RULES,
  defaultAdapter: 'claude',
  defaultCwd: '',
  language: 'zh-CN',
  theme: 'light'
}

export function createOrchestrator() {
  const adapters = new Map([claudeDescriptor, codexDescriptor].map((d) => [d.id, d]))
  const sessions = new Map() // sessionId -> { adapter?, session, status, stats, lastActivity, createdAt, _dirtyStats, _lastCumTokens }
  let mainWindow = null
  let rulesets = { default: structuredClone(DEFAULT_RULESET) }
  let settings = { ...DEFAULT_SETTINGS }

  // ---- DB init (async — callers must await) ----
  const dbPath = join(app.getPath('userData'), 'ucli.db')
  let flushTimer = null

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => getDb()?.flush(), 5000)
  }

  async function initPersistence() {
    const db = await openDb(dbPath)

    // Migrate old JSON files if they exist
    const configPath = join(app.getPath('userData'), 'ucli-config.json')
    const sessionsPath = join(app.getPath('userData'), 'ucli-sessions.json')
    let oldCfg = null, oldSessions = null
    try {
      if (existsSync(configPath)) {
        oldCfg = JSON.parse(readFileSync(configPath, 'utf8'))
      }
    } catch { /* ignore */ }
    try {
      if (existsSync(sessionsPath)) {
        oldSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'))
      }
    } catch { /* ignore */ }

    const existingSessions = db.listSessions()
    if (!existingSessions.length && oldCfg) {
      db.migrateFromJson(
        oldCfg.rulesets || null,
        oldCfg.settings || null,
        oldSessions || null
      )
      db.flush()
      // Remove old files after successful migration
      try { if (existsSync(configPath)) unlinkSync(configPath) } catch { /* ok */ }
      try { if (existsSync(sessionsPath)) unlinkSync(sessionsPath) } catch { /* ok */ }
    }

    // Load from DB
    const dbRules = db.getRules()
    if (Object.keys(dbRules).length) {
      rulesets = dbRules
    } else {
      db.saveRules(rulesets)
    }
    const dbSettings = db.getSettings()
    if (Object.keys(dbSettings).length) {
      settings = { ...DEFAULT_SETTINGS, ...dbSettings }
    } else {
      db.saveSettings(settings)
    }

    // Restore session entries (metadata only — no running adapters)
    const dbSessions = db.listSessions()
    for (const s of dbSessions) {
      // Recover native_session_id from claude index if missing
      let cliSessionId = s.cliSessionId || s.nativeSessionId || null
      let sessionName = s.name || null
      if (!cliSessionId && s.cwd) {
        const found = findClaudeSessionIndex(s.cwd, s.createdAt)
        if (found) {
          cliSessionId = found.sessionId
          sessionName = sessionName || found.name
          db.updateSession(s.id, { native_session_id: cliSessionId, name: sessionName })
        }
      }
      const entry = {
        adapter: null, // offline — CLI process not running
        session: {
          id: s.id, adapterId: s.adapterId,
          cwd: s.cwd || s.projectPath,
          model: s.model, tier: s.tier, rulesetId: 'default',
          cliSessionId,
          name: sessionName,
          taskNote: s.taskNote || ''
        },
        status: 'offline',
        stats: s.stats,
        lastActivity: '已离线',
        createdAt: s.createdAt || Date.now(),
        _dirtyStats: null,
        _lastCumTokens: null
      }
      sessions.set(s.id, entry)
      engine.setSession(s.id, { tier: s.tier, rulesetId: 'default', ruleset: rulesets['default'] })
    }
    db.flush()
  }

  // ---- hook runner path (dev vs packaged) ----
  const hookRunnerPath = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'claudeHook.runner.mjs')
    : join(app.getAppPath(), 'resources', 'claudeHook.runner.mjs')

  // ---- permission engine ----
  const engine = new PermissionEngine({
    onApprovalRequest(req) { send('session:approval-request', req) },
    onApprovalResolved(req) { send('session:approval-resolved', req) },
    onDecision(d) {
      const s = sessions.get(d.sessionId)
      if (!s) return
      const key = d.asked
        ? (d.verdict === 'allow' ? 'confirmed' : 'denied')
        : (d.verdict === 'allow' ? 'autoAllowed' : 'denied')
      const dirty = s._dirtyStats || (s._dirtyStats = { inputTokens: 0, outputTokens: 0, costUsd: 0, turnsDelta: 0, autoAllowed: 0, confirmed: 0, denied: 0 })
      dirty[key] = (dirty[key] || 0) + 1
    }
  })

  // ---- hook HTTP server ----
  let hookPort = null
  let hookServer = null
  const hookReady = startHookServer().then((srv) => {
    hookServer = srv
    hookPort = srv.port
    srv.setHandler(async (payload) => {
      const result = await engine.decide(payload.sessionId, {
        tool: payload.tool, input: payload.input, cwd: payload.cwd
      })
      return { verdict: result.verdict, reason: result.reason }
    })
    return srv
  })

  function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  function setMainWindow(win) { mainWindow = win }

  // ---- session lifecycle ----
  function createSession(config) {
    const sessionId = randomUUID()
    const tier = config.tier || settings.defaultTier
    const rulesetId = config.rulesetId || 'default'
    const adapterId = config.adapterId || settings.defaultAdapter
    const descriptor = adapters.get(adapterId)
    if (!descriptor) throw new Error('unknown adapter: ' + adapterId)
    const cwd = config.cwd || settings.defaultCwd || process.cwd()

    const session = {
      id: sessionId, adapterId, cwd,
      model: config.model || null, tier, rulesetId,
      cliSessionId: config.cliSessionId || null,
      name: config.name || null,
      taskNote: ''
    }
    engine.setSession(sessionId, { tier, rulesetId, ruleset: rulesets[rulesetId] })
    const adapter = descriptor.create({ session, engine, settings: { hookRunnerPath, hookPort: null } })
    const entry = {
      adapter, session,
      status: 'idle',
      stats: { tokens: { input: 0, output: 0 }, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } },
      lastActivity: '启动中…',
      createdAt: Date.now(),
      _dirtyStats: null,
      _lastCumTokens: null
    }
    sessions.set(sessionId, entry)
    adapter.on('event', (evt) => handleAdapterEvent(sessionId, evt))

    // Persist to SQLite
    const db = getDb()
    if (db) {
      db.touchProject(cwd, session.name || cwd.split(/[\\/]/).pop() || cwd)
      db.insertSession({
        id: sessionId, project_path: cwd, adapter_id: adapterId,
        native_session_id: null, name: session.name, task_note: '', tier, model: session.model,
        status: 'idle', created_at: entry.createdAt
      })
      db.flush()
    }
    return { sessionId }
  }

  async function handleAdapterEvent(sessionId, evt) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    switch (evt.type) {
      case 'ready':
        entry.status = 'idle'
        entry.lastActivity = '已就绪'
        break
      case 'init':
        // cliSessionId discovered from PTY output (new session) or from transcript
        if (evt.cliSessionId && !entry.session.cliSessionId) {
          entry.session.cliSessionId = evt.cliSessionId
          const db = getDb()
          if (db) { db.updateSession(sessionId, { native_session_id: evt.cliSessionId }); db.flush() }
        }
        break
      case 'exit':
        entry.status = 'exited'
        entry.lastActivity = `进程退出 (${evt.code})`
        break
      case 'error':
        entry.status = 'error'
        entry.lastActivity = `错误: ${evt.message}`
        break
      case 'terminal':
        send('session:terminal-output', { sessionId, data: evt.data })
        entry.status = 'running'
        break
      case 'stats_update':
        entry.stats.tokens = { input: evt.usage.inputTokens, output: evt.usage.outputTokens }
        if (evt.costUsd) entry.stats.costUsd = evt.costUsd
        if (evt.turns) entry.stats.turns = evt.turns
        if (evt.model && evt.model !== entry.session.model) {
          entry.session.model = evt.model
          const db = getDb()
          if (db) db.updateSession(sessionId, { model: evt.model })
        }
        // Persist per-model breakdown to model_stats table
        if (evt.modelBreakdown && evt.modelBreakdown.length) {
          const db = getDb()
          if (db) {
            for (const mb of evt.modelBreakdown) {
              db.upsertModelStats(sessionId, mb.model, { inputTokens: mb.inputTokens, outputTokens: mb.outputTokens, costUsd: mb.costUsd })
            }
          }
        }
        scheduleFlush()
        break
    }
    send('session:event', { sessionId, ...evt, status: entry.status })
  }


  // ---- claude session index helpers ----
  /** Scan ~/.claude/sessions/*.json for the session closest to `createdAt` in `cwd`. */
  function findClaudeSessionIndex(cwd, nearTs) {
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '~'
      const sessionsDir = join(home, '.claude', 'sessions')
      if (!existsSync(sessionsDir)) return null
      const normCwd = (cwd || '').replace(/\\/g, '/').toLowerCase()
      let best = null, bestDist = Infinity
      for (const f of readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
          const rawCwd = (raw.cwd || '').replace(/\\/g, '/').toLowerCase()
          if (rawCwd !== normCwd) continue
          const dist = nearTs ? Math.abs((raw.startedAt || 0) - nearTs) : 0
          if (dist < bestDist) {
            bestDist = dist
            best = raw
          }
        } catch { /* skip */ }
      }
      if (best && bestDist < 120_000) return { sessionId: best.sessionId, name: best.name, startedAt: best.startedAt } // within 2 min
      if (best) return { sessionId: best.sessionId, name: best.name, startedAt: best.startedAt } // no timestamp, take newest
      return null
    } catch { return null }
  }

  function listSessions() {
    return Array.from(sessions.entries()).map(([id, e]) => ({
      id,
      adapterId: e.session.adapterId,
      cwd: e.session.cwd,
      model: e.session.model,
      tier: e.session.tier,
      status: e.status,
      stats: e.stats,
      cliSessionId: e.session.cliSessionId || null,
      nativeSessionId: e.session.cliSessionId || null,
      name: e.session.name || null,
      taskNote: e.session.taskNote || '',
      lastActivity: e.lastActivity || '',
      startedAt: e.createdAt || null,
      createdAt: e.createdAt
    }))
  }

  /** Respawn an offline (persisted) session. */
  async function restartSession(sessionId) {
    const entry = sessions.get(sessionId)
    if (!entry) throw new Error('no session')
    if (entry.adapter) throw new Error('session already running')
    const descriptor = adapters.get(entry.session.adapterId)
    if (!descriptor) throw new Error('unknown adapter: ' + entry.session.adapterId)
    engine.setSession(sessionId, { tier: entry.session.tier, rulesetId: entry.session.rulesetId, ruleset: rulesets[entry.session.rulesetId] })
    const adapter = descriptor.create({ session: entry.session, engine, settings: { hookRunnerPath, hookPort: null } })
    entry.adapter = adapter
    entry.status = 'starting'
    entry._dirtyStats = null
    entry._lastCumTokens = null
    adapter.on('event', (evt) => handleAdapterEvent(sessionId, evt))
    adapter.hookPort = hookPort
    await adapter.start()
    const db = getDb()
    if (db) { db.updateSession(sessionId, { status: 'idle' }); scheduleFlush() }
    send('session:event', { sessionId, type: 'ready', status: entry.status })
  }

  // ---- IPC registration ----
  function registerIpc() {
    ipcMain.handle('adapters:list', () =>
      Array.from(adapters.values()).map((d) => ({ id: d.id, displayName: d.displayName, icon: d.icon, models: d.models }))
    )

    ipcMain.handle('dialog:pick-directory', async () => {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })

    // Scan the user's claude sessions dir for sessions matching `cwd`.
    ipcMain.handle('session:scan-claude', (_e, cwd) => {
      try {
        const home = process.env.HOME || process.env.USERPROFILE || '~'
        const sessionsDir = join(home, '.claude', 'sessions')
        if (!existsSync(sessionsDir)) return []
        const normCwd = (cwd || '').replace(/\\/g, '/').toLowerCase()
        // Collect already-imported claude session IDs to exclude
        const imported = new Set()
        for (const e of sessions.values()) {
          if (e.session.cliSessionId) imported.add(e.session.cliSessionId)
        }
        const found = []
        for (const f of readdirSync(sessionsDir)) {
          if (!f.endsWith('.json')) continue
          try {
            const raw = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
            const rawCwd = (raw.cwd || '').replace(/\\/g, '/').toLowerCase()
            if (rawCwd === normCwd && !imported.has(raw.sessionId)) {
              found.push({
                sessionId: raw.sessionId || null,
                name: raw.name || null,
                startedAt: raw.startedAt || null
              })
            }
          } catch { /* skip corrupted files */ }
        }
        found.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        return found.slice(0, 30) // show at most 30
      } catch { return [] }
    })

    ipcMain.handle('session:create', (_e, config) => {
      const { sessionId } = createSession(config)
      return { sessionId }
    })

    // Renderer calls this after it has registered the terminal-output listener
    ipcMain.handle('session:start-adapter', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (!e || !e.adapter) return false
      hookReady.then(() => {
        e.adapter.hookPort = hookPort
        return e.adapter.start()
      })
      return true
    })
    ipcMain.handle('session:send-turn', (_e, sessionId, text) => {
      const e = sessions.get(sessionId)
      if (!e) throw new Error('no session')
      if (!e.adapter) throw new Error('会话已离线，请先重新启动')
      e.status = 'running'
      return e.adapter.sendTurn(text)
    })
    ipcMain.handle('session:send-terminal-input', (_e, sessionId, data) => {
      const e = sessions.get(sessionId)
      if (e && e.adapter && typeof e.adapter.writeInput === 'function') {
        return e.adapter.writeInput(data)
      }
      return false
    })
    ipcMain.handle('session:terminal-resize', (_e, sessionId, cols, rows) => {
      const e = sessions.get(sessionId)
      if (e && e.adapter && typeof e.adapter.resize === 'function') {
        e.adapter.resize(cols, rows)
      }
    })
    ipcMain.handle('session:attach-terminal', (_e, sessionId) => {
      return true
    })
    ipcMain.handle('session:respond-approval', (_e, sessionId, requestId, verdict) => {
      return engine.respondApproval(requestId, verdict)
    })
    ipcMain.handle('session:interrupt', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (!e || !e.adapter) throw new Error('会话已离线')
      return e.adapter.interrupt()
    })
    ipcMain.handle('session:resume', (_e, sessionId, cliSessionId) => {
      const e = sessions.get(sessionId)
      if (!e) throw new Error('no session')
      if (!e.adapter) throw new Error('会话已离线，请先重新启动')
      return e.adapter.resume(cliSessionId)
    })
    ipcMain.handle('session:restart', (_e, sessionId) => restartSession(sessionId))
    ipcMain.handle('session:stop', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (e) {
        if (e.adapter) e.adapter.dispose()
        e.adapter = null
        e.status = 'offline'
        const db = getDb()
        if (db) { db.updateSession(sessionId, { status: 'offline' }); scheduleFlush() }
      }
      return true
    })
    ipcMain.handle('session:delete', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (e) {
        if (e.adapter) e.adapter.dispose()
        sessions.delete(sessionId)
        const db = getDb()
        if (db) { db.deleteSession(sessionId); scheduleFlush() }
      }
      return true
    })
    ipcMain.handle('session:list', () => listSessions())
    ipcMain.handle('session:update-note', (_e, sessionId, note) => {
      const e = sessions.get(sessionId)
      if (e) { e.session.taskNote = note; const db = getDb(); if (db) { db.updateSession(sessionId, { task_note: note }); scheduleFlush() } }
      return true
    })
    ipcMain.handle('session:update-name', (_e, sessionId, name) => {
      const e = sessions.get(sessionId)
      if (e) { e.session.name = name; const db = getDb(); if (db) { db.updateSession(sessionId, { name }); scheduleFlush() } }
      return true
    })

    ipcMain.handle('rules:get', () => rulesets)
    ipcMain.handle('rules:update', (_e, next) => {
      rulesets = next
      for (const [id, rs] of Object.entries(rulesets)) engine.setRuleset(id, rs)
      const db = getDb(); if (db) { db.saveRules(rulesets); scheduleFlush() }
      return true
    })
    ipcMain.handle('rules:blacklist', () => describeBlacklist())
    ipcMain.handle('rules:test-pattern', (_e, { pattern, command, path } = {}) => {
      const parsed = parsePattern(pattern)
      if (!parsed) return { matches: false, parsed: null, error: '无法解析模式' }
      const input = { tool: parsed.tool === '*' ? 'Bash' : parsed.tool, command, path }
      const result = classify(input, { highRisk: [pattern] })
      return { matches: result.classification === 'high-risk', parsed, classification: result.classification }
    })

    ipcMain.handle('stats:get', () => {
      const perSession = {}
      let total = { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
      const diag = []
      for (const [id, e] of sessions) {
        const row = { adapterId: e.session.adapterId, model: e.session.model, cwd: e.session.cwd, status: e.status, ...e.stats }
        perSession[id] = row
        diag.push({ id: id.slice(0,8), tokens: e.stats.tokens, turns: e.stats.turns, cost: e.stats.costUsd })
        total.input += e.stats.tokens.input
        total.output += e.stats.tokens.output
        total.costUsd += e.stats.costUsd
        total.turns += e.stats.turns
        for (const k of Object.keys(total.approvals)) total.approvals[k] += e.stats.approvals[k] || 0
      }
      // Write diag so we can see what stats:get actually returns
      const result = { total, perSession, modelStats: getDb()?.getModelStats() || [] }
      try { writeFileSync(join(app.getPath('userData'), 'stats-diag.json'), JSON.stringify({ diag, total: result.total, keys: Object.keys(result.perSession).length, json: JSON.stringify(result).slice(0, 200) }, null, 2)) } catch {}
      return result
    })

    ipcMain.handle('settings:get', () => settings)
    ipcMain.handle('settings:update', (_e, s) => {
      settings = { ...settings, ...s }
      const db = getDb(); if (db) { db.saveSettings(settings); scheduleFlush() }
      return true
    })
  }

  return { registerIpc, setMainWindow, hookReady, initPersistence }
}
