import assert from 'node:assert/strict'
import test from 'node:test'

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
