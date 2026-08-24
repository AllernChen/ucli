<template>
  <div class="work-summary-panel">
    <div class="toolbar">
      <a-button @click="refresh">刷新</a-button>
      <a-button type="primary" @click="dialogOpen = true">生成总结</a-button>
    </div>
    <a-alert v-if="summaries.error" type="error" show-icon message="无法完成总结操作，请稍后重试。" />
    <a-spin :spinning="summaries.loading">
      <a-row :gutter="14">
        <a-col :span="7">
          <a-list :data-source="summaries.reports" row-key="id" :locale="{ emptyText: '还没有生成的工作总结' }">
            <template #renderItem="{ item }">
              <a-list-item :class="{ selected: item.id === summaries.selectedReportId }" @click="select(item.id)">
                <a-list-item-meta :title="`v${item.version} · ${item.status}`" :description="item.progressText || item.runPhase || '等待生成'" />
              </a-list-item>
            </template>
          </a-list>
          <SummaryHistory :versions="summaries.versions" @select="select" @retry="retry" @set-current="setCurrent" @delete-report="remove" />
        </a-col>
        <a-col :span="17">
          <SummaryReportView :report="summaries.selectedReport" :progress="selectedProgress" :html-exporting="htmlExporting" @cancel="cancel" @export-markdown="exportMarkdown" @export-html="openHtmlExport" @delete-report="remove" @open-conversation="openConversation" />
        </a-col>
      </a-row>
    </a-spin>
    <SummaryConversationDrawer v-model:open="drawerOpen" :report-id="conversationReport?.id" :session-id="conversationReport?.sessionId || null" />
    <SummaryGenerateDialog v-model:open="dialogOpen" @submit="generate" />
    <SummaryHtmlStyleDialog v-model:open="htmlStyleDialogOpen" :confirm-loading="htmlExporting" @submit="exportHtml" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSummariesStore } from '../../stores/summaries.js'
import SummaryGenerateDialog from './SummaryGenerateDialog.vue'
import SummaryConversationDrawer from './SummaryConversationDrawer.vue'
import SummaryHistory from './SummaryHistory.vue'
import SummaryReportView from './SummaryReportView.vue'
import SummaryHtmlStyleDialog from './SummaryHtmlStyleDialog.vue'

const summaries = useSummariesStore()
const dialogOpen = ref(false)
const drawerOpen = ref(false)
const conversationReport = ref(null)
const htmlStyleDialogOpen = ref(false)
const htmlExportReportId = ref(null)
const htmlExporting = ref(false)
const selectedProgress = computed(() => summaries.progress[summaries.selectedReportId] || null)
const owner = Symbol('work-summary-panel')
let alive = true

onMounted(async () => {
  try {
    await summaries.init(owner)
    if (!alive) return
    const initial = summaries.reports.find(report => report.isCurrent) || summaries.reports[0]
    if (initial) await summaries.selectReport(initial.id)
  } catch {
    if (alive) summaries.error = new Error('无法读取总结报告')
  }
})
onBeforeUnmount(() => {
  alive = false
  summaries.dispose(owner)
})

async function refresh() {
  await summaries.loadReports()
  if (summaries.selectedReportId) await summaries.selectReport(summaries.selectedReportId)
}
async function select(reportId) { await summaries.selectReport(reportId) }
async function generate(request) {
  try { await summaries.generateInteractive(request) } catch { summaries.error = new Error('无法创建总结报告') }
}
async function retry(report) {
  try { await summaries.retry(report) } catch { summaries.error = new Error('无法重新生成总结报告') }
}
async function cancel(reportId) { await summaries.cancel(reportId) }
async function setCurrent(reportId) { await summaries.setCurrent(reportId) }
async function remove(reportId) { await summaries.deleteReport(reportId) }
function openConversation(report) { conversationReport.value = report; drawerOpen.value = true }
async function exportMarkdown(reportId) {
  const report = summaries.reports.find(item => item.id === reportId)
  if (report?.status !== 'completed') return
  try {
    await summaries.exportMarkdown(report.id)
  } catch {
    summaries.error = new Error('无法导出总结报告')
  }
}
function openHtmlExport(reportId) {
  const report = summaries.reports.find(item => item.id === reportId)
  if (report?.status !== 'completed' || htmlExporting.value) return
  htmlExportReportId.value = report.id
  htmlStyleDialogOpen.value = true
}
async function exportHtml(style) {
  const reportId = htmlExportReportId.value
  const report = summaries.reports.find(item => item.id === reportId)
  if (!reportId || report?.status !== 'completed' || htmlExporting.value) return
  htmlExporting.value = true
  try {
    const result = await summaries.exportHtml(reportId, style)
    if (result?.canceled === false) htmlStyleDialogOpen.value = false
  } catch {
    summaries.error = new Error('无法导出总结报告')
  } finally {
    htmlExporting.value = false
  }
}
</script>

<style scoped>
.toolbar { display:flex; justify-content:flex-end; gap:8px; margin-bottom:12px; }
.selected { background:#e6f4ff; }
</style>
