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
