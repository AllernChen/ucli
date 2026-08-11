<template>
  <div class="work-summary-panel">
    <div class="toolbar">
      <a-space>
        <a-select v-model:value="summaries.filters.periodType" allow-clear placeholder="全部周期" :options="periodOptions" @change="reload" />
        <a-button @click="reload">刷新</a-button>
        <a-button type="primary" @click="dialogOpen = true">生成总结</a-button>
      </a-space>
    </div>
    <a-alert v-if="summaries.error" type="error" show-icon :message="summaries.error.message" />
    <a-spin :spinning="summaries.loading">
      <a-row :gutter="14">
        <a-col :span="7">
          <a-list bordered :data-source="summaries.reports" class="report-list">
            <template #renderItem="{ item }">
              <a-list-item @click="selectReport(item.id)">
                <a-list-item-meta :title="`${item.periodType} · v${item.version}`" :description="`${item.status} · ${new Date(item.periodStart).toLocaleDateString()}`" />
              </a-list-item>
            </template>
          </a-list>
          <SummaryHistory :versions="summaries.versions" @select="selectReport" @set-current="setCurrent" @retry="retry" />
        </a-col>
        <a-col :span="17">
          <SummaryReportView
            :report="summaries.selectedReport"
            :progress="summaries.progress[summaries.selectedReport?.id]"
            @cancel="cancel"
            @confirm="confirm"
            @export-markdown="exportMarkdown"
            @export-html="exportHtml"
          />
        </a-col>
      </a-row>
    </a-spin>
    <SummaryGenerateDialog v-model:open="dialogOpen" @generated="onGenerated" />
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useSummariesStore } from '../../stores/summaries.js'
import SummaryGenerateDialog from './SummaryGenerateDialog.vue'
import SummaryHistory from './SummaryHistory.vue'
import SummaryReportView from './SummaryReportView.vue'

const summaries = useSummariesStore()
const dialogOpen = ref(false)
const periodOptions = [
  { label: '日', value: 'day' }, { label: '周', value: 'week' }, { label: '月', value: 'month' },
  { label: '季度', value: 'quarter' }, { label: '年', value: 'year' }
]
onMounted(async () => {
  try {
    await summaries.init()
    const current = summaries.reports.find(report => report.isCurrent) || summaries.reports[0]
    if (current) await summaries.selectReport(current.id)
  } catch (error) { summaries.error = error }
})
onUnmounted(() => summaries.dispose())
function onGenerated(reportId) {
  return safely(async () => {
    await summaries.refreshReport(reportId)
    await summaries.selectReport(reportId)
  })
}
async function safely(operation) {
  try { summaries.error = null; return await operation() }
  catch (error) { summaries.error = error; return null }
}
function reload() { return safely(() => summaries.loadReports()) }
function selectReport(reportId) { return safely(() => summaries.selectReport(reportId)) }
function setCurrent(reportId) { return safely(() => summaries.setCurrent(reportId)) }
function retry(report) { return safely(() => summaries.retry(report)) }
function cancel(reportId) { return safely(() => summaries.cancel(reportId)) }
function confirm(reportId) { return safely(() => summaries.confirm(reportId)) }
function exportMarkdown(reportId) { return safely(() => summaries.exportMarkdown(reportId)) }
function exportHtml(reportId) { return safely(() => summaries.exportHtml(reportId, { mode: 'light' })) }
</script>
<style scoped>.toolbar{display:flex;justify-content:flex-end;margin-bottom:12px}.report-list{margin-bottom:12px;max-height:360px;overflow:auto}.report-list :deep(.ant-list-item){cursor:pointer}</style>
