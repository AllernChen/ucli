import { spawn } from 'child_process'
import { BaseAdapter } from './cliAdapter.js'

const DISPLAY_NAME = 'Codex'
const ICON = '🟢'

/**
 * Drives `codex app-server --listen stdio://` as a stateful JSON-RPC 2.0 peer.
 *
 *   spawn → initialize → thread/start (per session) → turn/start (per prompt)
 *   Notifications stream deltas, token usage, item lifecycle, turn completion.
 *   Server *requests* (item/.../requestApproval) are the approval channel: we
 *   route each through the permission engine and respond accept/decline.
 *
 * Method/field names are taken from `codex app-server generate-json-schema`
 * (v2). Parsing is defensive — codex is experimental and shapes may shift; we
 * verify against a live run in the smoke test.
 */
export class CodexAdapter extends BaseAdapter {
  constructor({ session, engine, settings }) {
    super({ id: 'codex', displayName: DISPLAY_NAME, session, engine })
    /** @type {import('child_process').ChildProcess|null} */
    this.proc = null
    this._buffer = ''
    this._nextId = 1
    /** @type {Map<number, {resolve, reject}>} pending ClientRequest responses */
    this._pending = new Map()
    this._threadId = null
    this._initialized = false
  }

  async start() {
    this.proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: this.session.cwd,
      shell: true,
      env: { ...process.env, UCLI_SESSION_ID: this.session.id }
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      const s = chunk.toString().trim()
      if (s) this.emitEvent({ type: 'command_output', stream: 'stderr', text: s })
    })
    // Flip the card to idle as soon as the process is alive (before the
    // initialize/thread/start handshake completes).
    this.proc.on('spawn', () => this.emitEvent({ type: 'ready' }))
    this.proc.on('exit', (code, signal) => this.emitEvent({ type: 'exit', code, signal }))
    this.proc.on('error', (err) =>
      this.emitEvent({ type: 'error', message: 'spawn failed: ' + (err?.message || String(err)) })
    )

    // JSON-RPC handshake, then open a thread.
    try {
      await this._request('initialize', {
        clientInfo: { name: 'ucli', version: '0.1.0' }
      })
      this._initialized = true
      const res = await this._request('thread/start', {
        cwd: this.session.cwd,
        model: this.session.model || undefined,
        sandbox: 'workspace-write',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user'
      })
      this._threadId = res?.thread?.id || res?.threadId || res?.id
      this.emitEvent({
        type: 'init',
        cliSessionId: this._threadId,
        model: this.session.model,
        cwd: this.session.cwd
      })
    } catch (err) {
      this.emitEvent({ type: 'error', message: 'codex init failed: ' + (err?.message || String(err)) })
    }
  }

  // ---- JSON-RPC transport ----

  _request(method, params) {
    const id = this._nextId++
    const msg = { jsonrpc: '2.0', id, method, params: params || {} }
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error('timeout waiting for response to ' + method))
        }
      }, 60000)
    })
  }

  _notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params: params || {} }
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  _respond(id, result) {
    const msg = { jsonrpc: '2.0', id, result }
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  _onStdout(chunk) {
    this._buffer += chunk
    let nl
    while ((nl = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, nl).trim()
      this._buffer = this._buffer.slice(nl + 1)
      if (line) {
        try {
          this._handleMessage(JSON.parse(line))
        } catch {
          this.emitEvent({ type: 'command_output', stream: 'stdout', text: line })
        }
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // Response to a ClientRequest we sent.
      const p = this._pending.get(msg.id)
      if (p) {
        this._pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.id !== undefined && msg.method) {
      // Server→client request (approval). Must respond by id.
      this._handleServerRequest(msg.id, msg.method, msg.params || {}).catch((err) => {
        this._respond(msg.id, { decision: 'decline' })
        this.emitEvent({ type: 'error', message: 'approval handling failed: ' + (err?.message || err) })
      })
      return
    }
    if (msg.method) {
      // Server→client notification.
      this._handleNotification(msg.method, msg.params || {})
    }
  }

  // ---- notifications ----

  _handleNotification(method, params) {
    switch (method) {
      case 'thread/started':
        if (!this._threadId && params.thread?.id) this._threadId = params.thread.id
        break
      case 'thread/tokenUsage/updated': {
        const tu = params.tokenUsage || {}
        const total = tu.total || {}
        this.emitEvent({
          type: 'token_usage',
          usage: {
            inputTokens: total.inputTokens || 0,
            outputTokens: total.outputTokens || 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: total.cachedInputTokens || 0,
            reasoningOutputTokens: total.reasoningOutputTokens || 0
          },
          costUsd: null,
          contextWindow: tu.modelContextWindow || null,
          cumulative: true
        })
        break
      }
      case 'item/agentMessage/delta':
        if (params.delta) this.emitEvent({ type: 'message', role: 'assistant', text: params.delta, partial: true })
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (params.delta) this.emitEvent({ type: 'reasoning', text: params.delta, partial: true })
        break
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        if (params.delta) this.emitEvent({ type: 'command_output', stream: 'stdout', text: decodeB64(params.delta) })
        break
      case 'item/fileChange/patchUpdated':
        this.emitEvent({ type: 'file_diff', path: params.path || '', diff: params.patch || params.diff || '' })
        break
      case 'item/started':
        this._emitItemEvent(params.item || params, 'started')
        break
      case 'item/completed':
        this._emitItemEvent(params.item || params, 'completed')
        break
      case 'turn/completed':
        this.emitEvent({
          type: 'turn_complete',
          result: extractFinalText(params.turn || params),
          status: params.turn?.status || params.status,
          isError: (params.turn?.status || params.status) === 'failed'
        })
        break
      default:
        break
    }
  }

  _emitItemEvent(item, phase) {
    if (!item) return
    // Defensive tag detection — codex item shapes are a tagged union.
    if (item.command || item.type === 'commandExecution' || item.type === 'command_execution') {
      if (phase === 'started') {
        this.emitEvent({ type: 'tool_call', toolUseId: item.id || item.itemId, tool: 'Bash', input: { command: item.command, cwd: item.cwd } })
      } else {
        this.emitEvent({
          type: 'tool_result',
          toolUseId: item.id || item.itemId,
          content: item.aggregatedOutput || item.aggregated_output || '',
          isError: item.exitCode ? item.exitCode !== 0 : false
        })
      }
    } else if (item.changes || item.type === 'fileChange' || item.type === 'file_change') {
      const changes = item.changes || []
      for (const c of changes) {
        if (phase === 'started') {
          this.emitEvent({ type: 'tool_call', toolUseId: item.id || item.itemId, tool: 'Edit', input: { file_path: c.path, path: c.path } })
        }
        this.emitEvent({ type: 'file_diff', path: c.path, diff: c.diff || '' })
      }
      if (phase === 'completed') {
        this.emitEvent({ type: 'tool_result', toolUseId: item.id || item.itemId, content: changes.map((c) => c.path).join(', '), isError: false })
      }
    } else if (item.type === 'agentMessage' || item.type === 'agent_message' || (item.text && item.phase)) {
      // Finalize the streamed assistant message (deltas arrived as partials).
      if (phase === 'completed') {
        this.emitEvent({ type: 'message', role: 'assistant', text: item.text || '' })
      }
    }
  }

  // ---- approval server requests ----

  async _handleServerRequest(id, method, params) {
    let tool = 'Bash'
    let callInput = {}
    if (method === 'item/commandExecution/requestApproval') {
      tool = 'Bash'
      callInput = { command: params.command, cwd: params.cwd }
    } else if (method === 'item/fileChange/requestApproval') {
      tool = 'Edit'
      callInput = { path: params.grantRoot || params.path || '' }
    } else if (method === 'item/permissions/requestApproval') {
      tool = 'Permissions'
      callInput = { permissions: params.permissions }
    } else {
      // Unknown request type — decline safely.
      this._respond(id, { decision: 'decline' })
      return
    }

    const verdict = await this.decide({ tool, input: callInput, cwd: params.cwd })
    // allow → accept, deny → decline (agent continues the turn).
    const decision = verdict.verdict === 'allow' ? 'accept' : 'decline'
    // Surface the tool call in the UI stream regardless.
    this.emitEvent({
      type: 'tool_call',
      toolUseId: params.itemId,
      tool,
      input: callInput,
      approval: { requestId: id, decision, classification: verdict.classification, reason: verdict.reason }
    })
    this._respond(id, { decision })
  }

  // ---- session ops ----

  async sendTurn(text) {
    if (!this._threadId) throw new Error('codex thread not started')
    await this._request('turn/start', {
      threadId: this._threadId,
      input: [{ type: 'text', text }]
    })
  }

  async interrupt() {
    if (this._threadId) {
      try {
        await this._request('turn/interrupt', { threadId: this._threadId })
      } catch {
        // fall through to hard kill
      }
    }
    if (this.proc && process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { shell: true })
    }
  }

  async resume(cliSessionId) {
    // codex threads are server-side state; reopen by thread id.
    this._threadId = cliSessionId
    this.emitEvent({ type: 'init', cliSessionId, model: this.session.model, cwd: this.session.cwd })
  }

  async dispose() {
    this._disposed = true
    await this.interrupt().catch(() => {})
    this.proc = null
    super.dispose()
  }
}

function decodeB64(s) {
  try {
    return Buffer.from(s, 'base64').toString('utf8')
  } catch {
    return s
  }
}

function extractFinalText(turn) {
  const items = turn?.items || []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'agentMessage' || it.type === 'agent_message' || it.text) {
      if (it.phase === 'final_answer' || it.phase === 'finalAnswer' || it.text) return it.text || ''
    }
  }
  return ''
}

export const codexDescriptor = {
  id: 'codex',
  displayName: DISPLAY_NAME,
  icon: ICON,
  models: ['gpt-5', 'gpt-5.5', 'o3'],
  create: (opts) => new CodexAdapter(opts)
}
