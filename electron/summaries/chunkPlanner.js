import { createHash } from 'node:crypto'

import {
  buildDirectReportPrompt,
  buildFinalReducePrompt,
  buildMapPrompt,
  buildProjectReducePrompt
} from './promptBuilder.js'
import {
  finalReportSchema,
  projectDigestSchema,
  renderSummaryMarkdown
} from './summarySchema.js'
import { runnerError, validateStructuredOutput } from './runners/processRunner.js'

const UNKNOWN_CONTEXT_WINDOW = 32_768
const INPUT_TARGET_RATIO = 0.6

export function inputTargetTokens(contextWindow = UNKNOWN_CONTEXT_WINDOW) {
  const context = Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow)
    : UNKNOWN_CONTEXT_WINDOW
  return Math.floor(context * INPUT_TARGET_RATIO)
}

export function estimateTokens(value) {
  const text = String(value || '')
  let ascii = 0
  let nonAscii = 0
  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1
    else nonAscii += character.length
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii)
}

function hashSources(parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(`${part.id}\0${part.text}\0`)
  return `sha256:${hash.digest('hex')}`
}

function splitToTokenTarget(text, targetTokens) {
  const parts = []
  let start = 0
  while (start < text.length) {
    let low = start + 1
    let high = Math.min(text.length, start + targetTokens * 4)
    let end = low
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (estimateTokens(text.slice(start, middle)) <= targetTokens) {
        end = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

export function planEvidenceChunks({ blocks = [], contextWindow, reservedTokens } = {}) {
  const targetTokens = inputTargetTokens(contextWindow)
  const defaultReserve = Math.min(1024, Math.floor(targetTokens * 0.1))
  const promptReserveTokens = Number.isFinite(reservedTokens) && reservedTokens >= 0
    ? Math.ceil(reservedTokens)
    : defaultReserve
  if (promptReserveTokens >= targetTokens) {
    throw runnerError('SUMMARY_INPUT_BUDGET_TOO_SMALL', 'Summary prompt metadata exceeds the input target', {
      targetTokens,
      requiredTokens: promptReserveTokens
    })
  }
  const contentTargetTokens = Math.max(1, targetTokens - promptReserveTokens)
  const byProject = new Map()
  for (const source of blocks) {
    const projectPath = String(source?.projectPath || '(unknown)')
    if (!byProject.has(projectPath)) byProject.set(projectPath, [])
    byProject.get(projectPath).push({
      id: String(source?.id || `source:${byProject.get(projectPath).length + 1}`),
      text: String(source?.text || '')
    })
  }
  const chunks = []
  for (const [projectPath, sources] of byProject) {
    const units = sources.flatMap((source) => {
      if (estimateTokens(source.text) <= contentTargetTokens) return [{ ...source, sourceId: source.id }]
      return splitToTokenTarget(source.text, contentTargetTokens).map((text, index) => ({
        id: `${source.id}#${index + 1}`,
        sourceId: source.id,
        text
      }))
    })
    let pending = []
    const flush = () => {
      if (!pending.length) return
      const text = pending.map((source) => source.text).join('\n\n')
      chunks.push({
        id: `chunk:${chunks.length + 1}`,
        projectPath,
        sourceRefs: [...new Set(pending.map((source) => source.sourceId))],
        sourceHash: hashSources(pending),
        text,
        estimatedTokens: estimateTokens(text),
        targetTokens
      })
      pending = []
    }
    for (const unit of units) {
      const candidate = [...pending, unit].map((source) => source.text).join('\n\n')
      if (pending.length && estimateTokens(candidate) > contentTargetTokens) flush()
      pending.push(unit)
    }
    flush()
  }
  return chunks
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    throw runnerError('SUMMARY_PIPELINE_ABORTED', 'Summary generation was aborted')
  }
}

function addUsage(total, usage = {}) {
  for (const key of ['inputTokens', 'outputTokens']) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0) total[key] += usage[key]
  }
  if (Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    total.costUsd = (total.costUsd || 0) + usage.costUsd
  }
}

function promptTokens(prompt, schema) {
  return estimateTokens(prompt) + estimateTokens(JSON.stringify(schema || {}))
}

function mapReserveTokens({ blocks = [], period, usage, coverage }) {
  const sourceRefs = blocks.map((item, index) => String(item?.id || `source:${index + 1}`))
  const projectPath = blocks.reduce((longest, item) => {
    const candidate = String(item?.projectPath || '(unknown)')
    return candidate.length > longest.length ? candidate : longest
  }, '(unknown)')
  return promptTokens(buildMapPrompt({
    chunk: {
      projectPath,
      sourceHash: `sha256:${'0'.repeat(64)}`,
      sourceRefs,
      text: ''
    },
    period,
    usage,
    coverage
  }), projectDigestSchema)
}

export function planSummaryExecution({
  evidence = {}, period, usage = {}, contextWindow, forceMapReduce = false
} = {}) {
  const targetTokens = inputTargetTokens(contextWindow)
  const directPrompt = buildDirectReportPrompt({
    evidence, period, usage, coverage: evidence.coverage
  })
  if (!forceMapReduce && promptTokens(directPrompt, finalReportSchema) <= targetTokens) {
    return { strategy: 'direct', chunks: [], plannedCalls: 1 }
  }
  const chunks = planEvidenceChunks({
    blocks: evidence.blocks,
    contextWindow,
    reservedTokens: mapReserveTokens({
      blocks: evidence.blocks || [], period, usage, coverage: evidence.coverage
    })
  })
  const chunksPerProject = new Map()
  for (const chunk of chunks) {
    chunksPerProject.set(chunk.projectPath, (chunksPerProject.get(chunk.projectPath) || 0) + 1)
  }
  const projectReduceCalls = [...chunksPerProject.values()].filter(count => count > 1).length
  return {
    strategy: 'map-reduce',
    chunks,
    plannedCalls: chunks.length + projectReduceCalls + 1
  }
}

function fragmentReductionItem(item, fits) {
  const source = JSON.stringify(item)
  const fragments = []
  let start = 0
  while (start < source.length) {
    let low = start + 1
    let high = source.length
    let end = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const fragment = {
        fragmentOf: 'oversized-intermediate',
        index: fragments.length + 1,
        text: source.slice(start, middle)
      }
      if (fits([fragment])) {
        end = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (end === start) {
      throw runnerError('SUMMARY_INPUT_BUDGET_TOO_SMALL', 'A reduction prompt cannot fit within the input target')
    }
    fragments.push({
      fragmentOf: 'oversized-intermediate',
      index: fragments.length + 1,
      text: source.slice(start, end)
    })
    start = end
  }
  return fragments
}

function promptAwareBatches(items, buildPrompt, schema, targetTokens) {
  const fits = candidate => promptTokens(buildPrompt(candidate), schema) <= targetTokens
  const units = items.flatMap(item => fits([item]) ? [item] : fragmentReductionItem(item, fits))
  const batches = []
  let pending = []
  for (const unit of units) {
    if (pending.length && !fits([...pending, unit])) {
      batches.push(pending)
      pending = []
    }
    pending.push(unit)
  }
  if (pending.length) batches.push(pending)
  return batches
}

export function createSummaryPipeline({
  runner,
  contextWindow,
  automaticCallLimit = 20,
  now = Date.now
} = {}) {
  if (!runner || typeof runner.run !== 'function') throw new TypeError('runner.run is required')
  const callLimit = Number.isFinite(automaticCallLimit) && automaticCallLimit > 0
    ? Math.min(20, Math.floor(automaticCallLimit))
    : 20
  return {
    estimate(options = {}) {
      const plan = planSummaryExecution({ ...options, contextWindow })
      const chunks = plan.chunks
      const projects = new Set(chunks.map((chunk) => chunk.projectPath)).size
      return {
        strategy: plan.strategy,
        chunks: chunks.length,
        projects,
        plannedCalls: plan.plannedCalls,
        estimatedCalls: plan.plannedCalls
      }
    },

    async run(options = {}) {
      const {
        evidence = {}, period, usage = {}, signal, onProgress,
        mode = 'automatic', confirmed = false
      } = options
      const startedAt = now()
      abortIfNeeded(signal)
      onProgress?.({ phase: 'collecting' })
      const plan = planSummaryExecution({
        evidence, period, usage, contextWindow,
        forceMapReduce: options.forceMapReduce === true
      })
      const chunks = plan.chunks
      const estimatedCalls = plan.plannedCalls
      const reduceTargetTokens = inputTargetTokens(contextWindow)
      if (estimatedCalls > callLimit) {
        if (mode === 'manual' && !confirmed) {
          return {
            requiresConfirmation: true,
            estimatedCalls,
            callLimit,
            confirmationCallLimit: estimatedCalls
          }
        }
        if (mode !== 'manual') {
          throw runnerError(
            'SUMMARY_AUTOMATIC_CALL_LIMIT',
            `Automatic summary would require ${estimatedCalls} AI calls`,
            { estimatedCalls, callLimit }
          )
        }
      }

      let callCount = 0
      const confirmedCallLimit = Number.isFinite(options.confirmedCallLimit) &&
        options.confirmedCallLimit >= estimatedCalls
        ? Math.floor(options.confirmedCallLimit)
        : estimatedCalls
      const manualCallLimit = confirmed ? confirmedCallLimit : callLimit
      const generationUsage = { inputTokens: 0, outputTokens: 0, costUsd: null }
      const invoke = async ({ prompt, schema }) => {
        abortIfNeeded(signal)
        const requiredTokens = promptTokens(prompt, schema)
        if (requiredTokens > reduceTargetTokens) {
          throw runnerError('SUMMARY_PROMPT_BUDGET_EXCEEDED', 'Summary prompt exceeds the input target', {
            requiredTokens,
            targetTokens: reduceTargetTokens
          })
        }
        if (callCount >= (mode === 'manual' ? manualCallLimit : callLimit)) {
          if (mode === 'manual') {
            throw runnerError(
              'SUMMARY_MANUAL_CONFIRMATION_REQUIRED',
              'Summary generation requires confirmation for additional AI calls',
              {
                requiresConfirmation: true,
                estimatedCalls: callCount + 1,
                callLimit: manualCallLimit,
                confirmationCallLimit: callCount + 1
              }
            )
          }
          throw runnerError('SUMMARY_AUTOMATIC_CALL_LIMIT', 'Automatic summary call limit reached', {
            estimatedCalls, callLimit
          })
        }
        callCount += 1
        const result = await runner.run({
          executorId: options.executorId,
          prompt,
          schema,
          profileId: options.profileId,
          model: options.model,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          signal
        })
        abortIfNeeded(signal)
        validateStructuredOutput(result?.value, schema)
        addUsage(generationUsage, result?.usage)
        return result.value
      }

      if (plan.strategy === 'direct') {
        const value = await invoke({
          prompt: buildDirectReportPrompt({
            evidence, period, usage, coverage: evidence.coverage
          }),
          schema: finalReportSchema
        })
        onProgress?.({ phase: 'rendering' })
        return {
          value,
          markdown: renderSummaryMarkdown(value),
          estimatedCalls,
          callCount,
          generationUsage,
          generationMetrics: {
            strategy: plan.strategy,
            plannedCalls: plan.plannedCalls,
            aiCalls: callCount,
            cacheHits: 0,
            durationMs: Math.max(0, now() - startedAt)
          }
        }
      }

      const mappedByProject = new Map()
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        onProgress?.({ phase: 'mapping', current: index + 1, total: chunks.length })
        const value = await invoke({
          prompt: buildMapPrompt({ chunk, period, usage, coverage: evidence.coverage }),
          schema: projectDigestSchema
        })
        if (!mappedByProject.has(chunk.projectPath)) mappedByProject.set(chunk.projectPath, [])
        mappedByProject.get(chunk.projectPath).push(value)
      }

      onProgress?.({ phase: 'reducing' })
      const reduceProject = async (projectPath, digests, depth = 0) => {
        if (digests.length === 1) return digests[0]
        const buildPrompt = inputs => buildProjectReducePrompt({
          projectPath, digests: inputs, period, usage, coverage: evidence.coverage
        })
        const batches = promptAwareBatches(
          digests, buildPrompt, projectDigestSchema, reduceTargetTokens
        )
        const partials = []
        for (const batch of batches) {
          partials.push(await invoke({
            prompt: buildPrompt(batch),
            schema: projectDigestSchema
          }))
        }
        if (partials.length === 1) return partials[0]
        if (depth >= 8 || estimateTokens(JSON.stringify(partials)) >= estimateTokens(JSON.stringify(digests))) {
          throw runnerError('SUMMARY_REDUCTION_NOT_CONVERGING', 'Project summary reduction did not get smaller')
        }
        return reduceProject(projectPath, partials, depth + 1)
      }
      const projects = []
      for (const [projectPath, digests] of mappedByProject) {
        projects.push(await reduceProject(projectPath, digests))
      }
      const reduceFinal = async (inputs, depth = 0) => {
        const buildPrompt = batch => buildFinalReducePrompt({
          inputs: batch, period, usage, coverage: evidence.coverage
        })
        const batches = promptAwareBatches(inputs, buildPrompt, finalReportSchema, reduceTargetTokens)
        const partials = []
        for (const batch of batches) {
          partials.push(await invoke({
            prompt: buildPrompt(batch),
            schema: finalReportSchema
          }))
        }
        if (partials.length === 1) return partials[0]
        if (depth >= 8 || estimateTokens(JSON.stringify(partials)) >= estimateTokens(JSON.stringify(inputs))) {
          throw runnerError('SUMMARY_REDUCTION_NOT_CONVERGING', 'Final summary reduction did not get smaller')
        }
        return reduceFinal(partials, depth + 1)
      }
      const value = await reduceFinal(projects)
      onProgress?.({ phase: 'rendering' })
      return {
        value,
        markdown: renderSummaryMarkdown(value),
        estimatedCalls,
        callCount,
        generationUsage,
        generationMetrics: {
          strategy: plan.strategy,
          plannedCalls: plan.plannedCalls,
          aiCalls: callCount,
          cacheHits: 0,
          durationMs: Math.max(0, now() - startedAt)
        }
      }
    }
  }
}
