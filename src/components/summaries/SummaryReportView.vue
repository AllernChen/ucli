<template>
  <a-card v-if="report" class="summary-report" :title="`${periodLabel} · v${report.version}`">
    <template #extra><a-tag :color="statusColor">{{ report.status }}</a-tag></template>
    <a-descriptions size="small" :column="3" bordered>
      <a-descriptions-item label="周期">{{ report.periodType }}{{ report.partial ? ' · partial' : '' }}</a-descriptions-item>
      <a-descriptions-item label="AI CLI">{{ report.executorId || '—' }}</a-descriptions-item>
      <a-descriptions-item label="模型">{{ report.model || '默认' }}</a-descriptions-item>
      <a-descriptions-item label="版本">v{{ report.version }}{{ report.isCurrent ? ' · 当前' : '' }}</a-descriptions-item>
      <a-descriptions-item label="时区">{{ report.timezone }}</a-descriptions-item>
      <a-descriptions-item label="生成费用">{{ report.generationCostUsd == null ? '不可用' : `$${report.generationCostUsd}` }}</a-descriptions-item>
    </a-descriptions>
    <a-alert v-if="coverageWarning" style="margin-top:12px" type="warning" show-icon :message="coverageWarning" />
    <a-alert
      v-if="awaitingConfirmation"
      style="margin-top:12px"
      type="warning"
      show-icon
      message="确认继续"
      :description="`预计调用 ${progress.total} 次，继续可能产生费用。确认后将在同一报告版本中继续。`"
    >
      <template #action>
        <a-button type="primary" size="small" @click="$emit('confirm', report.id)">确认继续</a-button>
      </template>
    </a-alert>
    <div v-if="progress" class="progress-row">
      <a-progress :percent="progress.total ? Math.round(progress.completed / progress.total * 100) : 0" />
      <span>{{ progress.text }}</span>
      <a-button v-if="active" danger size="small" @click="$emit('cancel', report.id)">取消生成</a-button>
    </div>
    <div class="actions">
      <a-button @click="copyMarkdown">复制 Markdown</a-button>
      <a-button @click="$emit('export-markdown', report.id)">导出 Markdown</a-button>
      <a-button @click="$emit('export-html', report.id)">导出 HTML</a-button>
    </div>
    <article v-if="report.markdown" class="markdown-body" v-html="safeHtml" />
    <a-empty v-else description="报告内容尚未生成" />
  </a-card>
  <a-empty v-else description="请选择或生成一份工作总结" />
</template>

<script setup>
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const props = defineProps({ report: Object, progress: Object })
defineEmits(['cancel', 'confirm', 'export-markdown', 'export-html'])
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const safeHtml = computed(() => DOMPurify.sanitize(markdown.render(props.report?.markdown || '')))
const active = computed(() => ['queued', 'running', 'awaiting_confirmation'].includes(props.report?.status))
const awaitingConfirmation = computed(() => props.progress?.phase === 'awaiting_confirmation')
const statusColor = computed(() => props.report?.status === 'completed' ? 'green' : props.report?.status === 'failed' ? 'red' : 'blue')
const periodLabel = computed(() => props.report ? `${new Date(props.report.periodStart).toLocaleDateString()} — ${new Date(props.report.periodEndExclusive).toLocaleDateString()}` : '')
const coverageWarning = computed(() => {
  const coverage = props.report?.coverage || {}
  if (Array.isArray(coverage.warnings) && coverage.warnings.length) return coverage.warnings.join('；')
  if (coverage.sessionsMissing || coverage.truncatedSessions) {
    return `数据覆盖不完整：缺失会话 ${coverage.sessionsMissing || 0}，截断会话 ${coverage.truncatedSessions || 0}`
  }
  return props.report?.partial ? '当前周期尚未结束，报告为部分覆盖。' : ''
})
async function copyMarkdown() { await navigator.clipboard.writeText(props.report?.markdown || '') }
</script>

<style scoped>
.progress-row,.actions { display:flex; align-items:center; gap:10px; margin-top:12px; }.progress-row :deep(.ant-progress){flex:1}.markdown-body{margin-top:18px;line-height:1.75}.markdown-body :deep(pre){overflow:auto;padding:12px;background:#f5f5f5}.markdown-body :deep(table){border-collapse:collapse}.markdown-body :deep(td),.markdown-body :deep(th){border:1px solid #ddd;padding:6px}
</style>
