<template>
  <a-card class="usage-trends-panel" title="使用趋势">
    <div class="trend-controls">
      <a-segmented
        aria-label="统计粒度"
        :value="stats.granularity"
        :options="granularityOptions"
        @change="onGranularityChange"
      />
      <a-select
        aria-label="项目筛选"
        mode="multiple"
        allow-clear
        placeholder="全部项目"
        :value="stats.filters.projectPaths"
        :options="projectOptions"
        @change="(values) => onFilterChange('projectPaths', values)"
      />
      <a-select
        aria-label="CLI 筛选"
        mode="multiple"
        allow-clear
        placeholder="全部 CLI"
        :value="stats.filters.adapterIds"
        :options="adapterOptions"
        @change="(values) => onFilterChange('adapterIds', values)"
      />
      <a-select
        aria-label="模型筛选"
        mode="multiple"
        allow-clear
        placeholder="全部模型"
        :value="stats.filters.models"
        :options="modelOptions"
        @change="(values) => onFilterChange('models', values)"
      />
      <a-select
        v-model:value="metric"
        aria-label="统计指标"
        :options="metricOptions"
      />
      <a-button :loading="stats.trendLoading" @click="stats.loadTrend()">刷新趋势</a-button>
    </div>

    <a-alert
      v-if="stats.trendError"
      type="error"
      show-icon
      :message="stats.trendError.message || '使用趋势加载失败'"
    >
      <template v-if="stats.trendError.suggestedGranularity" #action>
        <a-button size="small" @click="useSuggestedGranularity">
          改用{{ granularityLabel(stats.trendError.suggestedGranularity) }}
        </a-button>
      </template>
    </a-alert>

    <a-spin :spinning="stats.trendLoading">
      <div class="trend-content">
        <a-empty
          v-if="stats.trend && !hasMetricData && !stats.trendError"
          description="所选指标暂无使用数据"
          :image-style="{ height: '56px' }"
        />
        <UsageTrendChart
          v-else-if="stats.trend && !stats.trendError"
          :buckets="stats.trend.buckets || []"
          :metric="metric"
          :height="260"
        />
      </div>
    </a-spin>

    <div v-if="stats.trend" class="coverage">
      <a-alert
        v-if="stats.trend.exactSince != null"
        type="info"
        show-icon
        :message="`精确统计起点：${formatTimestamp(stats.trend.exactSince)}`"
        description="分时趋势仅包含该时间点之后采集的数据；升级前数据不会回填到时间桶。"
      />
      <a-card size="small" title="升级前累计" class="legacy-card">
        <template v-if="stats.trend.legacyBaseline?.available">
          <div class="legacy-metrics">
            <span>Tokens：{{ formatNumber(legacyTokens) }}</span>
            <span>轮次：{{ formatNumber(stats.trend.legacyBaseline.metrics?.turns) }}</span>
            <span>费用：{{ legacyCost }}</span>
          </div>
        </template>
        <a-alert
          v-else
          type="warning"
          show-icon
          :message="legacyUnavailableLabel"
        />
      </a-card>
    </div>
  </a-card>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useStatsStore } from '../../stores/stats.js'
import UsageTrendChart from './UsageTrendChart.vue'

const stats = useStatsStore()
const metric = ref('totalTokens')

const granularityOptions = Object.freeze([
  { label: '小时', value: 'hour' },
  { label: '天', value: 'day' },
  { label: '周', value: 'week' },
  { label: '月', value: 'month' }
])
const metricOptions = Object.freeze([
  { label: '总 Tokens', value: 'totalTokens' },
  { label: '输入 Tokens', value: 'inputTokens' },
  { label: '输出 Tokens', value: 'outputTokens' },
  { label: '已知费用', value: 'knownCostUsd' },
  { label: '轮次', value: 'turns' },
  { label: '活跃会话', value: 'activeSessions' },
  { label: '审批次数', value: 'approvals' }
])

const cliLabels = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  ucode: 'U-Code'
})

function uniqueOptions(values, label = (value) => value) {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .map(value => ({ value, label: label(value) }))
}

const sessionRows = computed(() => Object.values(stats.perSession || {}))
const projectOptions = computed(() => uniqueOptions(sessionRows.value.map(row => row.cwd)))
const adapterOptions = computed(() => uniqueOptions(
  sessionRows.value.map(row => row.adapterId),
  value => cliLabels[value] || value
))
const modelOptions = computed(() => uniqueOptions([
  ...sessionRows.value.map(row => row.model),
  ...(stats.modelStats || []).map(row => row.model)
]))

const hasMetricData = computed(() => (stats.trend?.buckets || []).some(bucket =>
  Number(bucket[metric.value] || 0) > 0
))
const legacyMetrics = computed(() => stats.trend?.legacyBaseline?.metrics || null)
const legacyTokens = computed(() =>
  Number(legacyMetrics.value?.inputTokens || 0) + Number(legacyMetrics.value?.outputTokens || 0)
)
const legacyCost = computed(() => {
  const known = `$${Number(legacyMetrics.value?.costUsd || 0).toFixed(4)}`
  return legacyMetrics.value?.costAvailable ? known : `${known}（部分费用不可用）`
})
const legacyUnavailableLabel = computed(() => {
  const reason = stats.trend?.legacyBaseline?.reason
  if (reason === 'MODEL_BREAKDOWN_UNAVAILABLE_BEFORE_EXACT_SINCE') {
    return '升级前累计不支持按模型筛选'
  }
  return '升级前累计数据不可用'
})

async function onGranularityChange(value) {
  stats.setGranularity(value)
  await stats.loadTrend()
}

async function onFilterChange(field, values) {
  stats.setFilters({
    ...stats.filters,
    [field]: Array.isArray(values) ? values : []
  })
  await stats.loadTrend()
}

async function useSuggestedGranularity() {
  const value = stats.trendError?.suggestedGranularity
  if (!granularityOptions.some(option => option.value === value)) return
  stats.setGranularity(value)
  await stats.loadTrend()
}

function granularityLabel(value) {
  return granularityOptions.find(option => option.value === value)?.label || value
}

function formatTimestamp(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return '未知'
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      timeZone: stats.trend?.timezone || undefined,
      hour12: false
    })
  } catch {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  }
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN')
}

onMounted(() => stats.loadTrend())
</script>

<style scoped>
.usage-trends-panel { margin-bottom: 14px; }
.trend-controls { display: grid; grid-template-columns: auto minmax(150px, 1fr) minmax(130px, 0.8fr) minmax(140px, 0.8fr) minmax(140px, 0.7fr) auto; gap: 10px; align-items: center; }
.trend-content { min-height: 170px; padding-top: 16px; }
.coverage { display: grid; grid-template-columns: minmax(260px, 1.4fr) minmax(240px, 1fr); gap: 12px; margin-top: 12px; }
.legacy-card { height: 100%; }
.legacy-metrics { display: flex; flex-wrap: wrap; gap: 8px 18px; font-variant-numeric: tabular-nums; }
@media (max-width: 1100px) {
  .trend-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .coverage { grid-template-columns: 1fr; }
}
</style>
