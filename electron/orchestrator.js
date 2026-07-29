import { app, ipcMain, dialog, shell, Notification } from 'electron'
import { join } from 'path'
import { readFileSync, readdirSync, existsSync, unlinkSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { openAllowedExternalUrl } from './externalLinks.js'
import { PermissionEngine } from './permission/engine.js'
import { startHookServer } from './permission/hookServer.js'
import { describeBlacklist } from './permission/blacklist.js'
import { classify, toClassifierInput, parsePattern } from './permission/classifier.js'
import { DEFAULT_RULESET, upgradeDefaultRuleset } from './permission/defaultRules.js'
import { claudeDescriptor } from './adapters/claudeAdapter.js'
import { codexDescriptor } from './adapters/codexAdapter.js'
import { openCodeDescriptor, resolveOpenCodeLaunch } from './adapters/openCodeAdapter.js'
import { TIER } from './adapters/cliAdapter.js'
import { openDb, getDb } from './persistence/db.js'
import { initLogger, log } from './logger.js'
import { inspectCliTools, runCliToolAction } from './cliTools.js'
import { createDiagnosticsService } from './diagnosticsService.js'
import { annotateImportedSessions, listClaudeTranscriptFiles, parseCodexProviderConfig, resolveCodexResumeProvider } from './sessionDiscovery.js'
import { listOpenCodeSessions } from './openCodeSessions.js'
import { exportOpenCodeSession } from './openCodeStats.js'
import { createSessionHistoryService, registerSessionHistoryIpc } from './sessionHistoryService.js'
import {
  advanceSessionNotification,
  advanceTaskCompletion,
  describeApprovalNotification,
  describeSessionAttentionNotification,
  describeTaskCompletionNotification,
  operationTypeForTool,
  shouldShowApprovalNotification
} from './approvalNotification.js'

const DEFAULT_SETTINGS = {
  defaultTier: TIER.SAFETY_RULES,
  defaultAdapter: 'claude',
  defaultCwd: '',
  language: 'zh-CN',
  theme: 'light'
}

export function createOrchestrator() {
  initLogger()
  log('createOrchestrator() — starting')
  const adapters = new Map([claudeDescriptor, codexDescriptor, openCodeDescriptor].map((d) => [d.id, d]))
  const sessions = new Map() // sessionId -> { adapter?, session, status, stats, lastActivity, createdAt, _dirtyStats, _lastCumTokens }
  let mainWindow = null
  let rulesets = { default: structuredClone(DEFAULT_RULESET) }
  let settings = { ...DEFAULT_SETTINGS }
  let persistenceRecovery = null
  const approvalNotifications = new Map()
  const completionNotifications = new Set()
  const diagnostics = createDiagnosticsService({
    getRuntime: () => ({
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node
    }),
    inspectCliTools,
    getPersistence: () => ({ available: Boolean(getDb()), recoveryInfo: persistenceRecovery }),
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
    writeFile: writeFileSync
  })
  const historyService = createSessionHistoryService({
    resolveSession: (sessionId) => {
      const entry = sessions.get(sessionId)
      return entry
        ? {
            ...entry.session,
            historyRevision: entry._lastCompletedTurns
          }
        : null
    },
    exportOpenCode: (nativeSessionId) => {
      const launch = resolveOpenCodeLaunch()
      return exportOpenCodeSession(nativeSessionId, {
        executable: launch.file,
        prefixArgs: launch.prefixArgs
      })
    }
  })

  // ---- DB init (async — callers must await) ----
  const dbPath = join(app.getPath('userData'), 'ucli.db')
  let flushTimer = null

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => getDb()?.flush(), 5000)
  }

  async function initPersistence() {
    const db = await openDb(dbPath)
    log('initPersistence — openDb returned:', !!db, 'path:', dbPath)
    if (!db) {
      console.error('Persistence not available — running without saving data')
      log('initPersistence — DB is null, persistence disabled')
      return // app continues without DB (stats work from in-memory sessions)
    }
    persistenceRecovery = db.recoveryInfo || null

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
      const upgradedDefault = upgradeDefaultRuleset(rulesets.default)
      if (upgradedDefault !== rulesets.default) {
        rulesets = { ...rulesets, default: upgradedDefault }
        db.saveRules(rulesets)
      }
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
      // Recover/enrich native metadata using the matching adapter only.
      let cliSessionId = s.cliSessionId || s.nativeSessionId || null
      let sessionName = s.name || null
      let provider = s.provider || null
      let sourceProvider = s.sourceProvider || null
      if (!cliSessionId && s.cwd && s.adapterId === 'claude') {
        const found = findClaudeSessionIndex(s.cwd, s.createdAt)
        if (found) {
          cliSessionId = found.sessionId
          sessionName = sessionName || found.name
          db.updateSession(s.id, { native_session_id: cliSessionId, name: sessionName })
        }
      }
      if (!cliSessionId && s.cwd && s.adapterId === 'opencode') {
        const found = await findOpenCodeSessionIndex(s.cwd, s.createdAt)
        if (found) {
          cliSessionId = found.sessionId
          sessionName = sessionName || found.name
          db.updateSession(s.id, { native_session_id: cliSessionId, name: sessionName })
        }
      }
      if (cliSessionId && s.cwd && s.adapterId === 'codex' && !provider) {
        const found = listCodexSessions(s.cwd).find((item) => item.sessionId === cliSessionId)
        if (found) {
          provider = found.resumeProvider || null
          sourceProvider = found.sourceProvider || null
          db.updateSession(s.id, { provider, source_provider: sourceProvider })
        }
      }
      const entry = {
        adapter: null, // offline — CLI process not running
        session: {
          id: s.id, adapterId: s.adapterId,
          cwd: s.cwd || s.projectPath,
          model: s.model, tier: s.tier, rulesetId: 'default',
          provider,
          sourceProvider,
          cliSessionId,
          name: sessionName,
          taskNote: s.taskNote || ''
        },
        status: 'offline',
        stats: s.stats,
        lastActivity: '已离线',
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || s.createdAt || Date.now(),
        _dirtyStats: null,
        _lastCumTokens: null,
        _lastCompletedTurns: null,
        _lastNotification: null
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
    onApprovalRequest(req) {
      send('session:approval-request', req)
      showApprovalNotification(req)
    },
    onApprovalResolved(req) {
      dismissApprovalNotification(req.requestId)
      send('session:approval-resolved', req)
    },
    onDecision(d) {
      const s = sessions.get(d.sessionId)
      if (!s) return
      const key = d.asked
        ? (d.verdict === 'allow' ? 'confirmed' : 'denied')
        : (d.verdict === 'allow' ? 'autoAllowed' : 'denied')
      s.stats.approvals[key] = (s.stats.approvals[key] || 0) + 1
      scheduleFlush()
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
      if (
        result.verdict === 'allow' &&
        ['AskUserQuestion', 'ExitPlanMode'].includes(payload.tool)
      ) {
        showSessionAttentionNotification(payload.sessionId, {
          kind: 'approval',
          operation: operationTypeForTool(payload.tool)
        })
      }
      return { verdict: result.verdict, reason: result.reason }
    })
    return srv
  })

  function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  function setMainWindow(win) { mainWindow = win }

  function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.flashFrame(false)
  }

  function showApprovalNotification(request) {
    if (!shouldShowApprovalNotification(mainWindow)) return
    mainWindow.flashFrame(true)
    if (!Notification.isSupported()) return

    const entry = sessions.get(request.sessionId)
    const notification = new Notification(
      describeApprovalNotification(request, entry?.session)
    )
    approvalNotifications.set(request.requestId, notification)
    notification.on('click', () => {
      focusMainWindow()
      send('session:focus-session', { sessionId: request.sessionId })
      notification.close()
    })
    notification.on('close', () => {
      approvalNotifications.delete(request.requestId)
    })
    notification.show()
  }

  function dismissApprovalNotification(requestId) {
    const notification = approvalNotifications.get(requestId)
    if (notification) notification.close()
    approvalNotifications.delete(requestId)
    if (!approvalNotifications.size && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false)
    }
  }

  function showTaskCompletionNotification(sessionId, session) {
    showSessionAttentionNotification(sessionId, {
      kind: 'complete',
      operation: '任务完成'
    }, describeTaskCompletionNotification(session))
  }

  function showSessionAttentionNotification(sessionId, attention, description = null) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    const key = `${attention.kind}:${attention.operation}`
    const next = advanceSessionNotification(entry._lastNotification, key)
    entry._lastNotification = next.state
    if (!next.deliver || !shouldShowApprovalNotification(mainWindow)) return
    mainWindow.flashFrame(true)
    if (!Notification.isSupported()) return

    const notification = new Notification(
      description || describeSessionAttentionNotification(attention, entry.session)
    )
    completionNotifications.add(notification)
    notification.on('click', () => {
      focusMainWindow()
      send('session:focus-session', { sessionId })
      notification.close()
    })
    notification.on('close', () => completionNotifications.delete(notification))
    notification.show()
  }

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
      provider: config.provider || null,
      sourceProvider: config.sourceProvider || null,
      cliSessionId: config.cliSessionId || null,
      name: config.name || null,
      taskNote: ''
    }
    engine.setSession(sessionId, { tier, rulesetId, ruleset: rulesets[rulesetId] })
    const adapter = descriptor.create({
      session,
      engine,
      settings: { hookRunnerPath, hookPort: null, ruleset: rulesets[rulesetId] }
    })
    const entry = {
      adapter, session,
      status: 'starting', // not yet started — renderer calls start-adapter when pane is ready
      stats: {
        tokens: { input: 0, output: 0 },
        costUsd: adapterId === 'opencode' ? null : 0,
        costAvailable: adapterId !== 'opencode',
        turns: 0,
        approvals: { autoAllowed: 0, confirmed: 0, denied: 0 }
      },
      lastActivity: '启动中…',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _dirtyStats: null,
      _lastCumTokens: null,
      _lastCompletedTurns: session.cliSessionId ? null : 0,
      _lastNotification: null
    }
    sessions.set(sessionId, entry)
    adapter.on('event', (evt) => handleAdapterEvent(sessionId, evt))

    // Persist to SQLite
    const db = getDb()
    if (db) {
      db.touchProject(cwd, session.name || cwd.split(/[\\/]/).pop() || cwd)
      db.insertSession({
        id: sessionId, project_path: cwd, adapter_id: adapterId,
        native_session_id: session.cliSessionId, name: session.name, task_note: '', tier, model: session.model,
        provider: session.provider, source_provider: session.sourceProvider,
        status: 'starting', created_at: entry.createdAt
      })
      db.flush()
    }
    return { sessionId }
  }

  async function handleAdapterEvent(sessionId, evt) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    entry.updatedAt = evt.ts || Date.now()
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
      case 'attention':
        showSessionAttentionNotification(sessionId, {
          kind: evt.kind,
          operation: evt.operation
        })
        if (evt.kind === 'approval') {
          entry.status = 'waiting'
          entry.lastActivity = `等待用户操作：${evt.operation}`
        }
        break
      case 'stats_update':
        entry.stats.tokens = { input: evt.usage.inputTokens, output: evt.usage.outputTokens }
        if (evt.costAvailable === false) {
          entry.stats.costAvailable = false
          entry.stats.costUsd = null
        } else if (evt.costUsd != null) {
          entry.stats.costAvailable = true
          entry.stats.costUsd = evt.costUsd
        }
        if (evt.turns != null) entry.stats.turns = evt.turns
        if (evt.completedTurns != null) {
          const completion = advanceTaskCompletion(entry._lastCompletedTurns, evt.completedTurns)
          entry._lastCompletedTurns = completion.turns
          if (completion.completed) {
            showTaskCompletionNotification(sessionId, entry.session)
          }
        }
        if (evt.contextWindow) entry.session.contextWindow = evt.contextWindow
        if (evt.model && evt.model !== entry.session.model) {
          entry.session.model = evt.model
          const db = getDb()
          if (db) db.updateSession(sessionId, { model: evt.model })
        }
        {
          const db = getDb()
          if (db) {
            db.upsertStats(sessionId, {
              inputTokens: entry.stats.tokens.input,
              outputTokens: entry.stats.tokens.output,
              costUsd: entry.stats.costUsd,
              costAvailable: entry.stats.costAvailable,
              turnsDelta: entry.stats.turns,
              autoAllowed: entry.stats.approvals.autoAllowed,
              confirmed: entry.stats.approvals.confirmed,
              denied: entry.stats.approvals.denied
            })
          }
        }
        // Persist per-model breakdown to model_stats table
        if (evt.modelBreakdown && evt.modelBreakdown.length) {
          const db = getDb()
          if (db) {
            for (const mb of evt.modelBreakdown) {
              db.upsertModelStats(sessionId, mb.model, {
                inputTokens: mb.inputTokens,
                outputTokens: mb.outputTokens,
                costUsd: mb.costUsd,
                costAvailable: mb.costAvailable
              })
            }
          }
        } else if (evt.model) {
          const db = getDb()
          if (db) {
            db.upsertModelStats(sessionId, evt.model, {
              inputTokens: entry.stats.tokens.input,
              outputTokens: entry.stats.tokens.output,
              costUsd: entry.stats.costUsd,
              costAvailable: entry.stats.costAvailable
            })
          }
        }
        scheduleFlush()
        break
    }
    send('session:event', { sessionId, ...evt, status: entry.status })
  }


  // ---- session discovery helpers ----
  const home = process.env.HOME || process.env.USERPROFILE || '~'

  /** Read the last ~16 KB of a transcript file and extract the last text-bearing
   *  message (user or assistant). Returns a short preview string or null. */
  function _extractLastText(jsonlPath) {
    try {
      const content = readFileSync(jsonlPath, 'utf8')
      const tail = content.length > 16384 ? content.slice(-16384) : content
      const lines = tail.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          // Claude format
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const b of obj.message.content) {
              if (b.type === 'text' && b.text) return b.text.slice(0, 120)
            }
          }
          if (obj.type === 'user' && obj.message?.content) {
            for (const b of obj.message.content) {
              if (b.type === 'text' && b.text) return b.text.slice(0, 120)
            }
          }
          // Codex format: response_item with payload.type === "message"
          if (obj.type === 'response_item' && obj.payload?.type === 'message') {
            const p = obj.payload
            if (p.content && Array.isArray(p.content)) {
              for (const b of p.content) {
                if ((b.type === 'output_text' || b.type === 'text') && b.text) return b.text.slice(0, 120)
              }
            }
          }
          // Codex format: event_msg with payload.type === "agent_message"
          if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message' && obj.payload.message) {
            return String(obj.payload.message).slice(0, 120)
          }
        } catch { /* skip */ }
      }
      return null
    } catch { return null }
  }

  /** Build a session-index lookup from ~/.claude/sessions/*.json for name
   *  metadata. Keys are sessionId strings. */
  function _claudeIndexByName() {
    const map = new Map()
    try {
      const dir = join(home, '.claude', 'sessions')
      if (!existsSync(dir)) return map
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'))
          if (raw.sessionId) map.set(raw.sessionId, raw)
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    return map
  }

  /** Discover Claude sessions for a cwd by scanning
   *  ~/.claude/projects/<hash>/*.jsonl directly, then enriching with name
   *  metadata from ~/.claude/sessions/.
   *  Returns array of { sessionId, name, startedAt, model, turns }. */
  function listClaudeSessionsByCwd(cwd) {
    try {
      if (!cwd) return []
      const idx = _claudeIndexByName()
      const found = []
      for (const transcript of listClaudeTranscriptFiles(home, cwd)) {
        const sessionId = transcript.sessionId
        const meta = idx.get(sessionId) || {}
        const fullPath = transcript.fullPath
        let model = meta.model || null
        let turns = 0
        try {
          const content = readFileSync(fullPath, 'utf8')
          // Extract model from init line (first ~2KB)
          for (const line of content.slice(0, 2048).split('\n').filter(Boolean)) {
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'system' && obj.subtype === 'init' && !model) model = obj.model
              if (obj.type === 'result' && obj.num_turns) turns = obj.num_turns
            } catch { /* skip */ }
          }
          // Also scan for result lines with num_turns
          if (!turns) {
            for (const line of content.split('\n')) {
              try {
                const obj = JSON.parse(line)
                if (obj.type === 'result' && obj.num_turns) { turns = obj.num_turns; break }
              } catch { /* skip */ }
            }
          }
        } catch { /* metadata extraction is best-effort */ }

        found.push({
          sessionId,
          name: meta.name || null,
          startedAt: meta.startedAt || transcript.startedAt,
          model: model || meta.model || null,
          turns,
          lastMessage: _extractLastText(fullPath)
        })
      }
      return found
    } catch { return [] }
  }

  /** Discover Codex sessions by scanning ~/.codex/sessions/<year>/<month>/<day>/
   *  for rollout-*.jsonl files. Reads the first line (session_meta) of each to
   *  extract cwd, sessionId, and timestamp. Falls back to session_index.jsonl
   *  for session names.
   *  If cwd is given, only returns sessions matching that directory.
   *  Returns array of { sessionId, name, startedAt }. */
  function listCodexSessions(cwd) {
    try {
      const sessionsDir = join(home, '.codex', 'sessions')
      if (!existsSync(sessionsDir)) return []
      let providerConfig = parseCodexProviderConfig('')
      try {
        const configPath = join(home, '.codex', 'config.toml')
        if (existsSync(configPath)) providerConfig = parseCodexProviderConfig(readFileSync(configPath, 'utf8'))
      } catch { /* default to the built-in provider */ }

      // Build name lookup from session_index.jsonl
      const nameMap = new Map()
      try {
        const idxPath = join(home, '.codex', 'session_index.jsonl')
        if (existsSync(idxPath)) {
          const lines = readFileSync(idxPath, 'utf8').split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const obj = JSON.parse(line)
              if (obj.id) {
                nameMap.set(obj.id, (obj.thread_name || '').replace(/<[^>]+>/g, '').trim() || null)
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* ok */ }

      const normCwd = cwd ? (cwd || '').replace(/\\/g, '/').toLowerCase() : null
      const found = []

      // Walk year/month/day directories
      const years = readdirSync(sessionsDir)
      for (const year of years) {
        const yearDir = join(sessionsDir, year)
        let months
        try { months = readdirSync(yearDir) } catch { continue }
        for (const month of months) {
          const monthDir = join(yearDir, month)
          let days
          try { days = readdirSync(monthDir) } catch { continue }
          for (const day of days) {
            const dayDir = join(monthDir, day)
            let files
            try { files = readdirSync(dayDir) } catch { continue }
            for (const f of files) {
              if (!f.endsWith('.jsonl')) continue
              const fullPath = join(dayDir, f)
              let meta = null
              try {
                // Codex session_meta lines can be large — read 64 KB for the first line
                const head = readFileSync(fullPath, 'utf8').slice(0, 65536)
                const nl = head.indexOf('\n')
                if (nl > 0) {
                  const firstLine = head.slice(0, nl)
                  const obj = JSON.parse(firstLine)
                  if (obj.type === 'session_meta' && obj.payload) {
                    meta = obj.payload
                  }
                }
              } catch { /* unreadable — skip */ }
              if (!meta || !meta.session_id && !meta.id) continue
              const sessionId = meta.session_id || meta.id
              if (normCwd) {
                const metaCwd = (meta.cwd || '').replace(/\\/g, '/').toLowerCase()
                if (metaCwd !== normCwd) continue
              }
              const provider = resolveCodexResumeProvider(meta.model_provider || null, providerConfig)
              found.push({
                sessionId,
                name: nameMap.get(sessionId) || null,
                startedAt: meta.timestamp ? new Date(meta.timestamp).getTime() : statSync(fullPath).birthtimeMs,
                ...provider,
                lastMessage: _extractLastText(fullPath)
              })
            }
          }
        }
      }

      // Deduplicate by sessionId (latest file wins)
      const seen = new Map()
      for (const s of found) {
        const existing = seen.get(s.sessionId)
        if (!existing || (s.startedAt || 0) > (existing.startedAt || 0)) {
          seen.set(s.sessionId, s)
        }
      }
      return Array.from(seen.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    } catch { return [] }
  }

  /** Find the session closest to `createdAt` in `cwd`. */
  function findClaudeSessionIndex(cwd, nearTs) {
    const found = listClaudeSessionsByCwd(cwd)
    if (!found.length) return null
    if (!nearTs) return found[0]
    let best = null, bestDist = Infinity
    for (const s of found) {
      const dist = Math.abs((s.startedAt || 0) - nearTs)
      if (dist < bestDist) { bestDist = dist; best = s }
    }
    return best
  }

  /** Recover a blank UCLI OpenCode record only from a nearby native session. */
  async function findOpenCodeSessionIndex(cwd, nearTs) {
    if (!nearTs) return null
    const found = await listOpenCodeSessions(cwd)
    if (!found.length) return null
    let best = null
    let bestDist = Infinity
    for (const session of found) {
      const dist = Math.abs((session.startedAt || session.updatedAt || 0) - nearTs)
      if (dist < bestDist) { bestDist = dist; best = session }
    }
    // Prevent binding an old UCLI session to an unrelated OpenCode record.
    return bestDist <= 10 * 60 * 1000 ? best : null
  }

  function listSessions() {
    return Array.from(sessions.entries()).map(([id, e]) => ({
      id,
      adapterId: e.session.adapterId,
      cwd: e.session.cwd,
      model: e.session.model,
      provider: e.session.provider || null,
      sourceProvider: e.session.sourceProvider || null,
      tier: e.session.tier,
      status: e.status,
      stats: e.stats,
      cliSessionId: e.session.cliSessionId || null,
      nativeSessionId: e.session.cliSessionId || null,
      name: e.session.name || null,
      taskNote: e.session.taskNote || '',
      contextWindow: e.session.contextWindow || null,
      lastActivity: e.lastActivity || '',
      startedAt: e.createdAt || null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt || e.createdAt
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
    const adapter = descriptor.create({
      session: entry.session,
      engine,
      settings: {
        hookRunnerPath,
        hookPort: null,
        ruleset: rulesets[entry.session.rulesetId]
      }
    })
    entry.adapter = adapter
    entry.status = 'starting'
    entry._dirtyStats = null
    entry._lastCumTokens = null
    entry._lastCompletedTurns = entry.session.cliSessionId ? null : 0
    entry._lastNotification = null
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
    ipcMain.handle('cli-tools:list', () => inspectCliTools())
    ipcMain.handle('cli-tools:run', (_e, id, action) => runCliToolAction(id, action))
    ipcMain.handle('diagnostics:get', () => diagnostics.getReport())
    ipcMain.handle('diagnostics:export', () => diagnostics.exportReport())
    registerSessionHistoryIpc(ipcMain, historyService)

    ipcMain.handle('dialog:pick-directory', async () => {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })

    // Discover all CLI sessions for a cwd, grouped by adapter type.
    // Returns { claude: [...], codex: [...], opencode: [...] }
    ipcMain.handle('session:discover', async (_e, cwd) => {
      const imported = new Set()
      for (const e of sessions.values()) {
        if (e.session.cliSessionId) imported.add(e.session.cliSessionId)
      }
      const decorate = (list) => annotateImportedSessions(list, imported)
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 30)

      const openCode = await listOpenCodeSessions(cwd)
      return {
        claude: decorate(listClaudeSessionsByCwd(cwd)),
        codex: decorate(listCodexSessions(cwd)),
        opencode: decorate(openCode)
      }
    })

    // Legacy: keep old handlers for backwards compat
    ipcMain.handle('session:scan-claude', (_e, cwd) => {
      return [] // deprecated — use session:discover
    })

    ipcMain.handle('session:create', (_e, config) => {
      const { sessionId } = createSession(config)
      return { sessionId }
    })

    // Renderer calls this after it has registered the terminal-output listener
    ipcMain.handle('session:start-adapter', async (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (!e || !e.adapter) return false
      await hookReady
      e.adapter.hookPort = hookPort
      await e.adapter.start()
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
      const e = sessions.get(sessionId)
      if (e?.adapter && typeof e.adapter.replayHistory === 'function') {
        e.adapter.replayHistory()
      }
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
        if (db) { db.removeSession(sessionId); scheduleFlush() }
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
      const db = getDb()
      for (const [id, e] of sessions) {
        // Persist full stats (tokens + approvals) to DB — upsertStats uses
        // absolute-value semantics, so pass the cumulative totals.
        if (db) {
          db.upsertStats(id, {
            inputTokens: e.stats.tokens.input,
            outputTokens: e.stats.tokens.output,
            costUsd: e.stats.costUsd,
            costAvailable: e.stats.costAvailable,
            turnsDelta: e.stats.turns,
            autoAllowed: e.stats.approvals.autoAllowed,
            confirmed: e.stats.approvals.confirmed,
            denied: e.stats.approvals.denied
          })
        }
      }

      // Statistics are historical records. Read removed sessions from the DB
      // as well, then overlay live in-memory entries with their latest state.
      const historical = db?.listSessions({ includeRemoved: true }) || []
      const source = new Map(historical.map((s) => [s.id, {
        adapterId: s.adapterId,
        model: s.model,
        cwd: s.cwd,
        status: s.removedAt ? 'removed' : s.status,
        ...s.stats
      }]))
      for (const [id, e] of sessions) {
        source.set(id, {
          adapterId: e.session.adapterId,
          model: e.session.model,
          cwd: e.session.cwd,
          status: e.status,
          ...e.stats
        })
      }

      const perSession = Object.fromEntries(source)
      const total = { input: 0, output: 0, costUsd: 0, costUnavailableCount: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
      for (const row of source.values()) {
        total.input += row.tokens.input
        total.output += row.tokens.output
        if (row.costAvailable === false) total.costUnavailableCount += 1
        else total.costUsd += row.costUsd || 0
        total.turns += row.turns
        for (const k of Object.keys(total.approvals)) total.approvals[k] += row.approvals[k] || 0
      }
      if (db) scheduleFlush()
      const result = { total, perSession, modelStats: db?.getModelStats() || [] }
      return result
    })

    ipcMain.handle('settings:get', () => settings)
    ipcMain.handle('settings:update', (_e, s) => {
      settings = { ...settings, ...s }
      const db = getDb(); if (db) { db.saveSettings(settings); scheduleFlush() }
      return true
    })

    ipcMain.handle('log:write', (_e, level, ...args) => {
      log(`[renderer/${level}]`, ...args)
    })

    ipcMain.handle('workbench:get', () => {
      log('IPC workbench:get called')
      const db = getDb()
      const result = db ? db.getWorkbench() : null
      log('IPC workbench:get result:', result)
      return result
    })
    ipcMain.handle('workbench:save', (_e, state) => {
      log('IPC workbench:save called with:', JSON.stringify(state))
      const db = getDb()
      if (db) {
        db.saveWorkbench(state)
        log('IPC workbench:save — db.saveWorkbench completed, calling db.flush()')
        db.flush()
        log('IPC workbench:save — db.flush completed')
      } else {
        log('IPC workbench:save — db is NULL, cannot save!')
      }
      return true
    })

    ipcMain.handle('shell:open-external', async (_e, url) => {
      try {
        return await openAllowedExternalUrl(url, (allowedUrl) => shell.openExternal(allowedUrl))
      } catch (err) {
        log('shell:open-external failed for', url, err)
        return false
      }
    })
  }

  let shutdownPromise = null
  function shutdown() {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      log('shutdown() called')
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      for (const notification of approvalNotifications.values()) notification.close()
      approvalNotifications.clear()
      for (const notification of completionNotifications) notification.close()
      completionNotifications.clear()
      const db = getDb()
      for (const [id, entry] of sessions) {
        if (entry.adapter) {
          try { await Promise.resolve(entry.adapter.dispose()) }
          catch (error) { console.error(`Failed to dispose session ${id}:`, error) }
          entry.adapter = null
        }
        entry.status = 'offline'
        if (db) db.updateSession(id, { status: 'offline' })
      }
      if (db) {
        log('shutdown — calling db.flush()')
        db.flush()
        log('shutdown — db.flush() done')
      }
      try {
        const server = hookServer || await hookReady
        await server?.close()
      } catch (error) {
        console.error('Failed to close permission hook server:', error)
      }
      log('shutdown() complete')
    })()
    return shutdownPromise
  }

  return {
    registerIpc,
    setMainWindow,
    hookReady,
    initPersistence,
    shutdown,
    getPersistenceRecovery: () => persistenceRecovery
  }
}
