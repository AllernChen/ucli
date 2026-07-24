import { execFile } from 'child_process'

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageTokens(tokens = {}) {
  return {
    inputTokens: number(tokens.input),
    outputTokens: number(tokens.output),
    cachedInputTokens: number(tokens.cache?.read),
    reasoningOutputTokens: number(tokens.reasoning)
  }
}

function modelName(providerID, modelID) {
  if (!modelID) return null
  return providerID ? `${providerID}/${modelID}` : modelID
}

function addModelUsage(target, tokens, cost, costAvailable) {
  target.inputTokens += tokens.inputTokens
  target.outputTokens += tokens.outputTokens
  target.costUsd += cost
  target.costAvailable = target.costAvailable && costAvailable
}

export class OpenCodeStatsScheduler {
  constructor({ onRun, idleDelayMs, maxWaitMs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    this.onRun = onRun
    this.idleDelayMs = idleDelayMs
    this.maxWaitMs = maxWaitMs
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.idleTimer = null
    this.maxTimer = null
  }

  schedule() {
    if (this.idleTimer) this.clearTimeoutFn(this.idleTimer)
    this.idleTimer = this.setTimeoutFn(() => this.run(), this.idleDelayMs)
    if (!this.maxTimer) this.maxTimer = this.setTimeoutFn(() => this.run(), this.maxWaitMs)
  }

  run() {
    if (this.idleTimer) this.clearTimeoutFn(this.idleTimer)
    if (this.maxTimer) this.clearTimeoutFn(this.maxTimer)
    this.idleTimer = null
    this.maxTimer = null
    this.onRun()
  }

  dispose() {
    if (this.idleTimer) this.clearTimeoutFn(this.idleTimer)
    if (this.maxTimer) this.clearTimeoutFn(this.maxTimer)
    this.idleTimer = null
    this.maxTimer = null
  }
}

export function loadOpenCodeSessionStats(sessionId, {
  execFileFn = execFile,
  executable = 'opencode',
  prefixArgs = []
} = {}) {
  if (!sessionId) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFileFn(executable, [...prefixArgs, 'export', sessionId, '--sanitize'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        resolve(parseOpenCodeSessionStats(JSON.parse(stdout)))
      } catch {
        resolve(null)
      }
    })
  })
}

export function parseOpenCodeSessionStats(source) {
  const info = source?.info || {}
  const sessionTokens = usageTokens(info.tokens)
  const sessionCostAvailable = Number.isFinite(info.cost)
  const messages = Array.isArray(source?.messages) ? source.messages : []
  const models = new Map()
  let turnsCount = 0
  let completedTurnsCount = 0
  let lastModel = modelName(info.model?.providerID, info.model?.id)

  for (const message of messages) {
    const messageInfo = message?.info || {}
    if (messageInfo.role === 'user') {
      turnsCount += 1
      continue
    }
    if (messageInfo.role !== 'assistant') continue

    if (messageInfo.finish === 'stop') completedTurnsCount += 1
    const model = modelName(messageInfo.providerID, messageInfo.modelID) || lastModel
    if (!model) continue
    lastModel = model

    const tokens = usageTokens(messageInfo.tokens)
    const costAvailable = Number.isFinite(messageInfo.cost)
    if (!models.has(model)) {
      models.set(model, {
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costAvailable: true
      })
    }
    addModelUsage(models.get(model), tokens, number(messageInfo.cost), costAvailable)
  }

  return {
    ...sessionTokens,
    turnsCount,
    completedTurnsCount,
    costUsd: sessionCostAvailable ? info.cost : null,
    costAvailable: sessionCostAvailable,
    lastModel,
    modelBreakdown: [...models.values()]
  }
}
