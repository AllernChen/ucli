<template>
  <figure class="usage-trend-chart">
    <svg
      class="chart"
      role="img"
      :aria-labelledby="`${titleId} ${descriptionId}`"
      :viewBox="`0 0 ${width} ${chartHeight}`"
      :style="{ height: `${chartHeight}px` }"
      preserveAspectRatio="xMidYMid meet"
    >
      <title :id="titleId">{{ chartTitle }}</title>
      <desc :id="descriptionId">{{ chartDescription }}</desc>
      <line
        :x1="padding.left"
        :x2="width - padding.right"
        :y1="baseline"
        :y2="baseline"
        class="axis"
      />
      <g v-for="bar in chartBars" :key="bar.key">
        <rect
          class="bar"
          :class="{ active: activeIndex === bar.index }"
          :x="bar.x"
          :y="bar.y"
          :width="bar.width"
          :height="bar.height"
          rx="2"
          tabindex="0"
          @mouseenter="activate(bar.index)"
          @mouseleave="deactivate(bar.index)"
          @focus="activate(bar.index)"
          @blur="deactivate(bar.index)"
        >
          <title>{{ bar.label }}：{{ formatValue(bar.value) }}</title>
        </rect>
        <text
          v-if="bar.showLabel"
          :x="bar.x + bar.width / 2"
          :y="chartHeight - 8"
          text-anchor="middle"
          class="axis-label"
        >{{ shortLabel(bar.label) }}</text>
      </g>
    </svg>

    <div v-if="activeBucket" class="tooltip" role="status" aria-live="polite">
      <strong>{{ activeBucket.label }}</strong>
      <span>{{ metricLabel }}：{{ formatValue(metricValue(activeBucket)) }}</span>
    </div>

    <details class="bucket-details">
      <summary>查看逐桶数据</summary>
      <div class="table-scroll">
        <table>
          <caption>逐桶数据：{{ metricLabel }}</caption>
          <thead><tr><th scope="col">时间</th><th scope="col">{{ metricLabel }}</th></tr></thead>
          <tbody>
            <tr v-for="(bucket, index) in buckets" :key="bucket.start ?? index">
              <th scope="row">{{ bucket.label }}</th>
              <td>{{ formatValue(metricValue(bucket)) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<script setup>
import { computed, ref, useId } from 'vue'
import { buildUsageTrendGeometry, usageMetricValue } from './usageTrendGeometry.js'

const props = defineProps({
  buckets: { type: Array, default: () => [] },
  metric: { type: String, default: 'totalTokens' },
  height: { type: Number, default: 260 }
})

const metricLabels = Object.freeze({
  totalTokens: '总 Tokens',
  inputTokens: '输入 Tokens',
  outputTokens: '输出 Tokens',
  knownCostUsd: '已知费用',
  turns: '轮次',
  activeSessions: '活跃会话',
  approvals: '审批次数'
})

const width = 960
const padding = Object.freeze({ top: 20, right: 12, bottom: 34, left: 12 })
const activeIndex = ref(null)
const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const titleId = `usage-trend-title-${instanceId}`
const descriptionId = `usage-trend-description-${instanceId}`
const chartHeight = computed(() => Math.max(140, props.height))
const metricLabel = computed(() => metricLabels[props.metric] || props.metric)

function metricValue(bucket) {
  return usageMetricValue(bucket, props.metric)
}

const geometry = computed(() => buildUsageTrendGeometry({
  buckets: props.buckets,
  metric: props.metric,
  width,
  height: chartHeight.value,
  padding
}))
const baseline = computed(() => geometry.value.baseline)
const maxValue = computed(() => geometry.value.maxValue)
const chartBars = computed(() => geometry.value.bars)

const activeBucket = computed(() => (
  activeIndex.value == null ? null : props.buckets[activeIndex.value] || null
))
const chartTitle = computed(() => `${metricLabel.value}使用趋势`)
const chartDescription = computed(() => (
  `共 ${props.buckets.length} 个时间桶，最大值 ${formatValue(maxValue.value)}。可聚焦每个柱形查看数值。`
))

function activate(index) {
  activeIndex.value = index
}

function deactivate(index) {
  if (activeIndex.value === index) activeIndex.value = null
}

function shortLabel(label) {
  const value = String(label || '')
  if (value.includes(' ')) {
    const [date, time] = value.split(' ')
    return `${date.slice(5)} ${time.slice(0, 5)}`
  }
  return value.length > 5 ? value.slice(5) : value
}

function formatValue(value) {
  if (props.metric === 'knownCostUsd') return `$${Number(value || 0).toFixed(4)}`
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
</script>

<style scoped>
.usage-trend-chart { margin: 0; }
.chart { display: block; width: 100%; min-height: 140px; overflow: visible; }
.axis { stroke: #d9d9d9; stroke-width: 1; }
.bar { fill: #1677ff; outline: none; transition: opacity 0.15s ease; }
.bar:hover, .bar:focus, .bar.active { fill: #0958d9; opacity: 0.9; }
.bar:focus { stroke: #10239e; stroke-width: 2; }
.axis-label { fill: #8c8c8c; font-size: 11px; }
.tooltip { display: flex; gap: 10px; align-items: center; min-height: 28px; color: #262626; }
.tooltip span { color: #595959; }
.bucket-details { margin-top: 8px; color: #595959; }
.bucket-details summary { cursor: pointer; width: fit-content; }
.table-scroll { margin-top: 8px; max-height: 240px; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
caption { text-align: left; font-weight: 600; padding: 6px 0; }
th, td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; text-align: left; }
td { text-align: right; }
</style>
