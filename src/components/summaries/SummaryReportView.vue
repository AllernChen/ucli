<template>
  <a-card v-if="report" class="summary-report" :title="`${periodLabel} · v${report.version}`">
    <template #extra><a-tag :color="status.color">{{ status.label }}</a-tag></template>
    <a-descriptions size="small" :column="3" bordered>
      <a-descriptions-item label="周期">{{ report.periodType }}{{ report.partial ? ' · partial' : '' }}</a-descriptions-item>
      <a-descriptions-item label="AI CLI">{{ report.executorId || '—' }}</a-descriptions-item>
      <a-descriptions-item label="模型">{{ report.model || '默认' }}</a-descriptions-item>
      <a-descriptions-item label="版本">v{{ report.version }}{{ report.isCurrent ? ' · 当前' : '' }}</a-descriptions-item>
      <a-descriptions-item label="时区">{{ report.timezone }}</a-descriptions-item>
      <a-descriptions-item label="生成费用">{{ report.generationCostUsd == null ? '不可用' : `$${report.generationCostUsd}` }}</a-descriptions-item>
    </a-descriptions>
    <a-alert
      v-if="generationPerformance"
      style="margin-top:12px"
      type="info"
      show-icon
      message="生成性能"
      :description="generationPerformance"
    />
    <a-alert v-if="coverageWarning" style="margin-top:12px" type="warning" show-icon :message="coverageWarning" />
    <a-alert v-if="report.status === 'failed'" style="margin-top:12px" type="error" show-icon message="总结生成失败，请重试。" />
    <a-alert
      v-if="awaitingConfirmation"
      style="margin-top:12px"
      type="warning"
      show-icon
      message="旧版报告等待确认"
      description="此报告无法在此继续。请取消后重试，以创建新的总结版本。"
    />
    <div v-if="visibleProgress" class="progress-row">
      <a-progress :percent="visibleProgress.total ? Math.round(visibleProgress.completed / visibleProgress.total * 100) : 0" />
      <span>{{ visibleProgress.text }}</span>
    </div>
    <div v-if="active" class="cancel-row"><a-button danger size="small" @click="$emit('cancel', report.id)">取消生成</a-button></div>
    <div class="actions">
      <a-button aria-label="编辑总结任务" @click="$emit('edit', report)">编辑任务</a-button>
      <a-button @click="$emit('open-conversation', report)">查看关联对话</a-button>
      <a-button @click="copyMarkdown">复制 Markdown</a-button>
      <a-button :disabled="!exportable" @click="exportMarkdown">导出 Markdown</a-button>
      <a-button
        :loading="htmlExporting"
        :disabled="!exportable || htmlExporting"
        @click="exportHtml"
      >{{ htmlExporting ? '正在生成 HTML' : '导出 HTML' }}</a-button>
      <a-popconfirm
        :title="deleteTitle"
        ok-text="确认删除"
        cancel-text="取消"
        :disabled="deleting"
        @confirm="confirmDelete"
      >
        <a-button danger :loading="deleting" :disabled="deleting" :title="deleteTitle" :aria-label="deleteTitle">删除总结</a-button>
      </a-popconfirm>
    </div>
    <article
      v-if="report.markdown"
      class="markdown-body"
      v-html="safeHtml"
      @click="handleReportLink"
    />
    <a-empty v-else description="报告内容尚未生成" />
  </a-card>
  <a-empty v-else description="请选择或生成一份工作总结" />
</template>

<script setup>
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import ipc from '../../ipc.js'
import { openSummaryReportLink } from '../../summaryLinks.js'
import { summaryTaskStatusMeta } from '../../../shared/summaryTaskContracts.js'

const props = defineProps({ report: Object, progress: Object, htmlExporting: Boolean, deleting: Boolean, deleteReport: Function })
const emit = defineEmits(['cancel', 'edit', 'export-markdown', 'export-html', 'delete-report', 'open-conversation'])
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const safeHtml = computed(() => DOMPurify.sanitize(markdown.render(props.report?.markdown || '')))
const active = computed(() => ['queued', 'running', 'awaiting_confirmation'].includes(props.report?.status))
const terminal = computed(() => ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(props.report?.status))
const exportable = computed(() => props.report?.status === 'completed')
const awaitingConfirmation = computed(() => !terminal.value && props.report?.status === 'awaiting_confirmation')
const visibleProgress = computed(() => terminal.value ? null : props.progress)
const status = computed(() => summaryTaskStatusMeta(props.report, props.progress))
const displayEnd = computed(() => {
  if (!props.report) return null
  return props.report.partial ? props.report.periodEndExclusive : props.report.periodEndExclusive - 1
})
const periodLabel = computed(() => props.report ? `${formatPeriod(props.report.periodStart)} — ${formatPeriod(displayEnd.value)}` : '')
const deleteTitle = computed(() => active.value ? '取消并删除这个总结任务？' : '删除这个总结任务？')
const generationPerformance = computed(() => {
  if (props.report?.status !== 'completed') return ''
  const metrics = props.report?.generationMetrics
  if (!metrics || !['direct', 'map-reduce'].includes(metrics.strategy)) return ''
  const seconds = (metrics.durationMs / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
  const strategy = metrics.strategy === 'direct' ? '直接生成' : '分块汇总'
  return `${strategy} · 计划调用 ${metrics.plannedCalls} 次 · AI 调用 ${metrics.aiCalls} 次 · 缓存命中 ${metrics.cacheHits} 次 · 耗时 ${seconds} 秒 · 并发 ${metrics.mapConcurrency}`
})
const coverageWarning = computed(() => {
  const coverage = props.report?.coverage || {}
  if (Array.isArray(coverage.warnings) && coverage.warnings.length) return coverage.warnings.join('；')
  if (coverage.sessionsMissing || coverage.truncatedSessions) {
    return `数据覆盖不完整：缺失会话 ${coverage.sessionsMissing || 0}，截断会话 ${coverage.truncatedSessions || 0}`
  }
  return props.report?.partial ? '当前周期尚未结束，报告为部分覆盖。' : ''
})
async function copyMarkdown() { await navigator.clipboard.writeText(props.report?.markdown || '') }
function exportMarkdown() { if (exportable.value) emit('export-markdown', props.report.id) }
function exportHtml() { if (exportable.value && !props.htmlExporting) emit('export-html', props.report.id) }
function handleReportLink(event) { openSummaryReportLink(event, ipc.openExternal) }
function confirmDelete() {
  if (props.deleting) return Promise.resolve()
  if (props.deleteReport) return props.deleteReport(props.report.id)
  emit('delete-report', props.report.id)
}
function formatPeriod(value) {
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: props.report?.timezone || undefined })
}
</script>

<style scoped>
.progress-row,.actions { display:flex; align-items:center; gap:10px; margin-top:12px; }.cancel-row{margin-top:12px}.progress-row :deep(.ant-progress){flex:1}.markdown-body{margin-top:18px;line-height:1.75}.markdown-body :deep(pre){overflow:auto;padding:12px;background:#f5f5f5}.markdown-body :deep(table){border-collapse:collapse}.markdown-body :deep(td),.markdown-body :deep(th){border:1px solid #ddd;padding:6px}
</style>
