import assert from 'node:assert/strict'
import test from 'node:test'

import { mapBounded } from '../electron/summaries/boundedExecutor.js'
import {
  createSummaryPipeline,
  planSummaryExecution
} from '../electron/summaries/chunkPlanner.js'
import { finalReportSchema } from '../electron/summaries/summarySchema.js'

function digest(project) {
  return {
    project,
    accomplishments: ['implemented'],
    status: 'in_progress',
    blockers: [],
    risks: [],
    nextSteps: ['test'],
    evidenceRefs: ['evidence:1'],
    confidence: 'high'
  }
}

function finalValue(projects = [digest('/work/a')]) {
  return {
    executiveSummary: 'progress',
    usageAnalysis: { summary: 'stable', observations: [] },
    projectDigests: projects,
    crossProjectObservations: [],
    prioritizedNextSteps: ['test'],
    coverageNotes: []
  }
}

function evidence(projects) {
  return {
    blocks: projects.map((project, index) => ({
      id: `evidence:${index + 1}`,
      projectPath: project,
      text: `work ${index + 1}`
    })),
    coverage: { sessionsIncluded: projects.length }
  }
}

const period = { start: 's', endExclusive: 'e', timezone: 'UTC' }

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve))
}

test('mapBounded overlaps only the limit and restores input result order', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const started = []
  const settled = []
  const resultPromise = mapBounded(
    ['chunk:1', 'chunk:2', 'chunk:3'],
    2,
    async (item, index) => {
      started.push(item)
      await gates[index].promise
      return item
    },
    { onSettled: event => settled.push(event.settled) }
  )

  await nextTurn()
  assert.deepEqual(started, ['chunk:1', 'chunk:2'])
  gates[1].resolve()
  await nextTurn()
  assert.deepEqual(started, ['chunk:1', 'chunk:2', 'chunk:3'])
  gates[2].resolve()
  gates[0].resolve()

  assert.deepEqual(await resultPromise, ['chunk:1', 'chunk:2', 'chunk:3'])
  assert.deepEqual(settled, [1, 2, 3])
})

test('mapBounded aborts queued work and drains tasks already started', async () => {
  const controller = new AbortController()
  const gates = [deferred(), deferred(), deferred()]
  const started = []
  let rejected = false
  const resultPromise = mapBounded(
    ['chunk:1', 'chunk:2', 'chunk:3'],
    2,
    async (item, index) => {
      started.push(item)
      await gates[index].promise
      return item
    },
    { signal: controller.signal }
  ).catch(error => {
    rejected = true
    throw error
  })

  await nextTurn()
  controller.abort()
  await nextTurn()
  assert.equal(rejected, false)
  gates[0].resolve()
  gates[1].resolve()

  await assert.rejects(resultPromise, error => error?.code === 'SUMMARY_PIPELINE_ABORTED')
  assert.deepEqual(started, ['chunk:1', 'chunk:2'])
})

test('mapBounded stops after the first worker error and waits for active work', async () => {
  const first = deferred()
  const typed = Object.assign(new Error('typed failure'), { code: 'SUMMARY_RUNNER_EXIT' })
  const started = []
  let rejected = false
  const resultPromise = mapBounded(
    ['chunk:1', 'chunk:2', 'chunk:3'],
    2,
    async (item, index) => {
      started.push(item)
      if (index === 1) throw typed
      await first.promise
      return item
    }
  ).catch(error => {
    rejected = true
    throw error
  })

  await nextTurn()
  assert.equal(rejected, false)
  assert.deepEqual(started, ['chunk:1', 'chunk:2'])
  first.resolve()
  await assert.rejects(resultPromise, error => error === typed)
  assert.deepEqual(started, ['chunk:1', 'chunk:2'])
})

function fakeRunner() {
  const calls = []
  return {
    calls,
    async run(options) {
      calls.push(options)
      if (options.schema === finalReportSchema) {
        return { value: finalValue(), usage: {} }
      }
      const project = options.prompt.includes('/work/b') ? '/work/b' : '/work/a'
      return { value: digest(project), usage: {} }
    }
  }
}

function memoryCache() {
  const values = new Map()
  return {
    values,
    gets: [],
    puts: [],
    evictions: [],
    async get(key) {
      this.gets.push(key)
      return values.has(key) ? structuredClone(values.get(key)) : null
    },
    async put(entry) {
      this.puts.push(structuredClone(entry))
      values.set(entry.key, structuredClone(entry.value))
      return structuredClone(entry.value)
    },
    async evict(key) {
      this.evictions.push(key)
      return values.delete(key)
    }
  }
}

function evidenceAwareRunner() {
  const calls = []
  return {
    calls,
    async run(options) {
      calls.push(options)
      if (options.schema === finalReportSchema) {
        const projects = ['/work/a', '/work/b']
          .filter(project => options.prompt.includes(project))
          .map(project => digest(project))
        return { value: finalValue(projects.length ? projects : [digest('/work/a')]), usage: {
          inputTokens: 10, outputTokens: 2, costUsd: 0.01
        } }
      }
      const project = options.prompt.includes('/work/b') ? '/work/b' : '/work/a'
      const marker = options.prompt.includes('changed B') ? 'changed B' : 'original'
      return {
        value: { ...digest(project), accomplishments: [`${project}:${marker}`] },
        usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 }
      }
    }
  }
}

test('small complete evidence uses one direct AI call with deterministic metrics', async () => {
  const runner = fakeRunner()
  const times = [1000, 1125]
  const pipeline = createSummaryPipeline({
    runner,
    contextWindow: 10_000,
    now: () => times.shift()
  })

  const result = await pipeline.run({
    executorId: 'claude', evidence: evidence(['/work/a']), period, usage: {}, mode: 'manual'
  })

  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].schema, finalReportSchema)
  assert.deepEqual(result.generationMetrics, {
    strategy: 'direct',
    plannedCalls: 1,
    aiCalls: 1,
    cacheHits: 0,
    durationMs: 125
  })
})

test('forced map-reduce reuses a single project digest and plans exact calls', async () => {
  const runner = fakeRunner()
  const pipeline = createSummaryPipeline({ runner, contextWindow: 10_000, now: () => 1000 })
  const input = {
    evidence: evidence(['/work/a']), period, usage: {}, forceMapReduce: true
  }

  const plan = planSummaryExecution({ ...input, contextWindow: 10_000 })
  const result = await pipeline.run({ executorId: 'claude', ...input })

  assert.equal(plan.strategy, 'map-reduce')
  assert.equal(plan.chunks.length, 1)
  assert.equal(plan.plannedCalls, 2)
  assert.equal(runner.calls.length, 2)
  assert.equal(result.generationMetrics.plannedCalls, runner.calls.length)
  assert.equal(result.generationMetrics.aiCalls, runner.calls.length)
})

test('estimate exactly matches uncached direct, single-project, and multi-project calls', async () => {
  for (const fixture of [
    { projects: ['/work/a'], forceMapReduce: false, expected: 1 },
    { projects: ['/work/a'], forceMapReduce: true, expected: 2 },
    { projects: ['/work/a', '/work/b'], forceMapReduce: true, expected: 3 }
  ]) {
    const runner = fakeRunner()
    const pipeline = createSummaryPipeline({ runner, contextWindow: 10_000, now: () => 1000 })
    const input = {
      evidence: evidence(fixture.projects),
      period,
      usage: {},
      forceMapReduce: fixture.forceMapReduce
    }
    const estimate = pipeline.estimate(input)
    const result = await pipeline.run({ executorId: 'claude', ...input })

    assert.equal(estimate.plannedCalls, fixture.expected)
    assert.equal(estimate.estimatedCalls, fixture.expected)
    assert.equal(result.generationMetrics.plannedCalls, fixture.expected)
    assert.equal(result.generationMetrics.aiCalls, fixture.expected)
    assert.equal(runner.calls.length, fixture.expected)
  }
})

test('an exact repeated map-reduce run uses only validated cache hits', async () => {
  const runner = evidenceAwareRunner()
  const cache = memoryCache()
  const pipeline = createSummaryPipeline({
    runner,
    cache,
    contextWindow: 10_000,
    promptVersion: 'summary-v2',
    profileFingerprint: 'profile:safe',
    now: () => 1000
  })
  const input = {
    executorId: 'claude', model: 'sonnet',
    evidence: evidence(['/work/a', '/work/b']),
    period, usage: {}, forceMapReduce: true
  }

  const first = await pipeline.run(input)
  const callsAfterFirst = runner.calls.length
  const second = await pipeline.run(input)

  assert.equal(callsAfterFirst, 3)
  assert.equal(runner.calls.length, callsAfterFirst)
  assert.equal(first.generationMetrics.aiCalls, 3)
  assert.equal(first.generationMetrics.cacheHits, 0)
  assert.equal(second.generationMetrics.aiCalls, 0)
  assert.equal(second.generationMetrics.cacheHits, 3)
  assert.deepEqual(second.markdown, first.markdown)
  assert.deepEqual(second.generationUsage, { inputTokens: 0, outputTokens: 0, costUsd: null })
  assert.deepEqual(cache.puts.map(entry => entry.kind), ['map', 'map', 'final'])
})

test('a partial evidence change reuses unaffected map and recomputes changed map plus final', async () => {
  const runner = evidenceAwareRunner()
  const cache = memoryCache()
  const pipeline = createSummaryPipeline({
    runner, cache, contextWindow: 10_000,
    promptVersion: 'summary-v2', profileFingerprint: 'profile:safe', now: () => 1000
  })
  const base = {
    executorId: 'claude', model: 'sonnet', period, usage: {}, forceMapReduce: true
  }
  await pipeline.run({ ...base, evidence: evidence(['/work/a', '/work/b']) })
  const changedEvidence = evidence(['/work/a', '/work/b'])
  changedEvidence.blocks[1].text = 'changed B'

  const second = await pipeline.run({ ...base, evidence: changedEvidence })

  assert.equal(second.generationMetrics.cacheHits, 1)
  assert.equal(second.generationMetrics.aiCalls, 2)
  assert.equal(runner.calls.length, 5)
})

test('invalid cache hits and cache I/O failures degrade to AI without replaying usage', async () => {
  let gets = 0
  const cache = {
    async get() {
      gets += 1
      if (gets === 1) return { project: '/work/a' }
      throw Object.assign(new Error('cache unavailable'), { code: 'SUMMARY_CACHE_IO' })
    },
    async put() {
      throw Object.assign(new Error('disk full'), { code: 'SUMMARY_CACHE_IO' })
    }
  }
  const runner = fakeRunner()
  const pipeline = createSummaryPipeline({
    runner, cache, contextWindow: 10_000,
    promptVersion: 'summary-v2', profileFingerprint: 'profile:safe', now: () => 1000
  })

  const result = await pipeline.run({
    executorId: 'claude', model: 'sonnet', evidence: evidence(['/work/a']),
    period, usage: {}, forceMapReduce: true
  })

  assert.equal(result.generationMetrics.cacheHits, 0)
  assert.equal(result.generationMetrics.aiCalls, 2)
  assert.equal(runner.calls.length, 2)
})

test('a schema-invalid hit is evicted, regenerated, and reusable on the next run', async () => {
  const runner = evidenceAwareRunner()
  const cache = memoryCache()
  const pipeline = createSummaryPipeline({
    runner, cache, contextWindow: 10_000,
    promptVersion: 'summary-v2', profileFingerprint: 'profile:safe', now: () => 1000
  })
  const input = {
    executorId: 'claude', model: 'sonnet', evidence: evidence(['/work/a']),
    period, usage: {}, forceMapReduce: true
  }
  await pipeline.run(input)
  const mapEntry = cache.puts.find(entry => entry.kind === 'map')
  cache.values.set(mapEntry.key, { project: '/work/a' })
  const callsBeforeRepair = runner.calls.length

  const repaired = await pipeline.run(input)
  const callsAfterRepair = runner.calls.length
  const warm = await pipeline.run(input)

  assert.equal(cache.evictions.length, 1)
  assert.equal(repaired.generationMetrics.aiCalls, 1)
  assert.equal(repaired.generationMetrics.cacheHits, 1)
  assert.equal(callsAfterRepair, callsBeforeRepair + 1)
  assert.equal(warm.generationMetrics.aiCalls, 0)
  assert.equal(warm.generationMetrics.cacheHits, 2)
  assert.equal(runner.calls.length, callsAfterRepair)
})

test('cache key programming input errors are not swallowed as cache misses', async () => {
  const pipeline = createSummaryPipeline({
    runner: fakeRunner(), cache: memoryCache(), contextWindow: 10_000,
    promptVersion: { invalid: true }, profileFingerprint: 'profile:safe'
  })
  await assert.rejects(
    pipeline.run({
      executorId: 'claude', model: 'sonnet', evidence: evidence(['/work/a']), period, usage: {}
    }),
    error => error?.code === 'SUMMARY_CACHE_KEY_INVALID'
  )
})

test('pipeline maps with default concurrency two and reports settled progress', async () => {
  let active = 0
  let maxActive = 0
  const progress = []
  const runner = {
    async run(options) {
      if (options.schema === finalReportSchema) return { value: finalValue(), usage: {} }
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, options.prompt.includes('/work/a') ? 15 : 5))
      active -= 1
      const project = options.prompt.match(/\/work\/[abc]/)?.[0] || '/work/a'
      return { value: digest(project), usage: {} }
    }
  }
  const pipeline = createSummaryPipeline({ runner, contextWindow: 10_000, now: () => 1000 })

  const result = await pipeline.run({
    executorId: 'claude', evidence: evidence(['/work/a', '/work/b', '/work/c']),
    period, usage: {}, forceMapReduce: true,
    onProgress: event => {
      if (event.phase === 'mapping') progress.push(event.current)
    }
  })

  assert.equal(maxActive, 2)
  assert.deepEqual(progress, [1, 2, 3])
  assert.equal(result.generationMetrics.aiCalls, 4)
})
