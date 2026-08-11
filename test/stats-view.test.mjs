import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { baseParse, NodeTypes } from '@vue/compiler-dom'
import { compileScript, compileTemplate, parse as parseSfc } from '@vue/compiler-sfc'

function loadSfc(relativePath) {
  const url = new URL(relativePath, import.meta.url)
  const source = readFileSync(url, 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: url.pathname })
  assert.deepEqual(errors, [], `${relativePath} must parse as a Vue SFC`)
  if (descriptor.scriptSetup) compileScript(descriptor, { id: relativePath })
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: url.pathname,
    id: relativePath
  })
  assert.deepEqual(compiled.errors, [], `${relativePath} template must compile`)
  return { source, ast: baseParse(descriptor.template.content) }
}

function findElements(node, predicate, matches = []) {
  if (node.type === NodeTypes.ELEMENT && predicate(node)) matches.push(node)
  for (const child of node.children || []) findElements(child, predicate, matches)
  return matches
}

function attribute(node, name) {
  return node.props.find((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === name)?.value?.content
}

function directive(node, name, argument = null) {
  return node.props.find((prop) =>
    prop.type === NodeTypes.DIRECTIVE && prop.name === name &&
    (argument === null || prop.arg?.content === argument)
  )
}

test('usage trends panel exposes all query dimensions and explicit reload handlers', () => {
  const { source, ast } = loadSfc('../src/components/stats/UsageTrendsPanel.vue')

  for (const granularity of ["value: 'hour'", "value: 'day'", "value: 'week'", "value: 'month'"]) {
    assert.match(source, new RegExp(granularity))
  }
  for (const label of ['项目筛选', 'CLI 筛选', '模型筛选', '统计指标']) {
    assert.ok(findElements(ast, (node) => attribute(node, 'aria-label') === label).length, label)
  }
  assert.match(source, /onGranularityChange/)
  assert.match(source, /onFilterChange/)
  assert.match(source, /stats\.loadTrend\(\)/)
  assert.doesNotMatch(source, /\bwatch\s*\(/)
})

test('usage trends panel owns loading, empty, error, exact-since, and legacy states', () => {
  const { source, ast } = loadSfc('../src/components/stats/UsageTrendsPanel.vue')

  assert.ok(findElements(ast, (node) => node.tag === 'a-spin').length)
  assert.ok(findElements(ast, (node) => node.tag === 'a-alert').length)
  assert.ok(findElements(ast, (node) => node.tag === 'a-empty').length)
  assert.match(source, /trendLoading/)
  assert.match(source, /trendError/)
  assert.match(source, /exactSince/)
  assert.match(source, /精确统计起点/)
  assert.match(source, /升级前累计/)
  assert.match(source, /legacyBaseline\?\.available/)
  assert.match(source, /legacyUnavailableLabel/)
  assert.match(source, /suggestedGranularity/)
})

test('usage trend chart is dependency-free, accessible, interactive, and has a table fallback', () => {
  const { source, ast } = loadSfc('../src/components/stats/UsageTrendChart.vue')
  const svg = findElements(ast, (node) => node.tag === 'svg')[0]
  const title = findElements(ast, (node) => node.tag === 'title')[0]
  const bars = findElements(ast, (node) => node.tag === 'rect')
  const tables = findElements(ast, (node) => node.tag === 'table')

  assert.ok(svg)
  assert.equal(attribute(svg, 'role'), 'img')
  assert.ok(directive(svg, 'bind', 'aria-labelledby'))
  assert.ok(title)
  assert.ok(bars.some((bar) => attribute(bar, 'tabindex') === '0'))
  assert.ok(bars.every((bar) => attribute(bar, 'role') === 'img'))
  assert.ok(bars.every((bar) => directive(bar, 'bind', 'aria-label')))
  assert.ok(bars.some((bar) => directive(bar, 'on', 'focus')))
  assert.ok(bars.some((bar) => directive(bar, 'on', 'mouseenter')))
  const liveRegion = findElements(ast, (node) => attribute(node, 'aria-live') === 'polite')[0]
  assert.ok(liveRegion)
  assert.equal(directive(liveRegion, 'if'), undefined)
  assert.ok(tables.length)
  assert.match(source, /逐桶数据/)
  assert.match(source, /bucketAriaLabel/)
  assert.match(source, /chartBars/)
  assert.match(source, /maxValue/)
  assert.doesNotMatch(source, /chart\.js|echarts|d3|highcharts/i)
})

test('statistics view keeps cumulative usage under a trend-first tab and defers summary work', () => {
  const { source, ast } = loadSfc('../src/views/Stats.vue')
  const tabs = findElements(ast, (node) => node.tag === 'a-tab-pane')

  assert.equal(tabs.length, 2)
  assert.deepEqual(tabs.map((tab) => attribute(tab, 'tab')), ['使用统计', '工作总结'])
  assert.match(source, /UsageTrendsPanel/)
  assert.ok(source.indexOf('<UsageTrendsPanel') < source.indexOf('stats.total.input'))
  assert.match(source, /工作总结将在后续任务中启用/)
  assert.match(source, /v-if="activeTab === 'summary'"/)
  assert.match(source, /stats\.total\.input/)
  assert.match(source, /stats\.modelStats/)
  assert.match(source, /stats\.perSession/)
})

test('usage trend geometry uses a zero-based proportional scale', async () => {
  const { buildUsageTrendGeometry } = await import('../src/components/stats/usageTrendGeometry.js')
  const geometry = buildUsageTrendGeometry({
    buckets: [
      { start: 1, label: 'zero', totalTokens: -1 },
      { start: 2, label: 'half', totalTokens: 50 },
      { start: 3, label: 'full', totalTokens: 100 }
    ],
    metric: 'totalTokens',
    width: 300,
    height: 140,
    padding: { top: 10, right: 10, bottom: 30, left: 10 }
  })

  assert.equal(geometry.maxValue, 100)
  assert.equal(geometry.baseline, 110)
  assert.deepEqual(geometry.bars.map(bar => bar.height), [0, 50, 100])
  assert.deepEqual(geometry.bars.map(bar => bar.y), [110, 60, 10])
})

test('cost coverage keeps zero percent as data and formats it as a percentage', async () => {
  const {
    formatUsageMetricValue,
    hasUsageMetricData
  } = await import('../src/components/stats/usageTrendGeometry.js')

  assert.equal(hasUsageMetricData([{ costCoverage: 0 }], 'costCoverage'), true)
  assert.equal(hasUsageMetricData([{ costCoverage: null }], 'costCoverage'), false)
  assert.equal(formatUsageMetricValue(0, 'costCoverage'), '0%')
  assert.equal(formatUsageMetricValue(0.875, 'costCoverage'), '87.5%')
  assert.equal(formatUsageMetricValue(1, 'costCoverage'), '100%')

  const { source } = loadSfc('../src/components/stats/UsageTrendsPanel.vue')
  assert.match(source, /label: '费用覆盖率', value: 'costCoverage'/)
  assert.match(source, /hasUsageMetricData/)
})
