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
    <a-alert
      v-if="exportMessage"
      style="margin-bottom:12px"
      :type="exportingHtml ? 'info' : 'success'"
      show-icon
      :message="exportMessage"
    />
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
          <SummaryHistory :versions="summaries.versions" @select="selectReport" @set-current="setCurrent" @retry="retry" @delete-report="deleteReport" />
        </a-col>
        <a-col :span="17">
          <SummaryReportView
            :report="summaries.selectedReport"
            :progress="summaries.progress[summaries.selectedReport?.id]"
            :html-exporting="exportingHtml"
            @cancel="cancel"
            @confirm="confirm"
            @export-markdown="exportMarkdown"
            @export-html="chooseHtmlStyle"
            @delete-report="deleteReport"
          />
        </a-col>
      </a-row>
    </a-spin>
    <SummaryGenerateDialog v-model:open="dialogOpen" @generated="onGenerated" />
    <a-modal
      v-model:open="htmlStyleOpen"
      title="导出 HTML"
      ok-text="选择位置并生成"
      cancel-text="取消"
      :confirm-loading="exportingHtml"
      :ok-button-props="{ disabled: htmlStyle.mode === 'custom' && !htmlStyle.requirement.trim() }"
      :mask-closable="!exportingHtml"
      :closable="!exportingHtml"
      @ok="exportHtml"
    >
      <a-form layout="vertical">
        <a-form-item label="页面风格">
          <a-radio-group v-model:value="htmlStyle.mode">
            <a-radio-button value="light">浅色</a-radio-button>
            <a-radio-button value="dark">深色</a-radio-button>
            <a-radio-button value="custom">自定义</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-form-item v-if="htmlStyle.mode === 'custom'" label="自定义风格要求">
          <a-textarea
            v-model:value="htmlStyle.requirement"
            :maxlength="1000"
            :auto-size="{ minRows: 3, maxRows: 8 }"
            show-count
            placeholder="例如：深蓝色科技风，重点数字使用青色"
          />
        </a-form-item>
        <a-alert
          type="warning"
          show-icon
          message="将再次调用所选 AI CLI"
          description="HTML 排版由生成该总结时选择的 AI CLI 完成，可能需要等待并产生额外费用。只有通过安全校验后才会写入文件。"
        />
        <a-alert
          v-if="exportingHtml"
          style="margin-top:12px"
          type="info"
          show-icon
          message="正在生成 HTML"
          description="请保持 UCLI 运行，完成后将写入刚才选择的位置。"
        />
        <a-alert
          v-if="summaries.error"
          style="margin-top:12px"
          type="error"
          show-icon
          :message="summaries.error.message"
        />
      </a-form>
    </a-modal>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useSummariesStore } from '../../stores/summaries.js'
import SummaryGenerateDialog from './SummaryGenerateDialog.vue'
import SummaryHistory from './SummaryHistory.vue'
import SummaryReportView from './SummaryReportView.vue'

const summaries = useSummariesStore()
const dialogOpen = ref(false)
const exportingHtml = ref(false)
const exportMessage = ref('')
const htmlStyleOpen = ref(false)
const htmlExportReportId = ref(null)
const htmlStyle = reactive({ mode: 'light', requirement: '' })
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
function deleteReport(reportId) { return safely(() => summaries.deleteReport(reportId)) }
function chooseHtmlStyle(reportId) {
  if (exportingHtml.value) return
  htmlExportReportId.value = reportId
  htmlStyle.mode = 'light'
  htmlStyle.requirement = ''
  htmlStyleOpen.value = true
}
async function exportHtml() {
  if (exportingHtml.value) return null
  const reportId = htmlExportReportId.value
  if (!reportId || (htmlStyle.mode === 'custom' && !htmlStyle.requirement.trim())) return null
  exportingHtml.value = true
  exportMessage.value = '正在生成 HTML，将调用所选 AI CLI，完成后写入已选择的位置。'
  try {
    summaries.error = null
    const style = htmlStyle.mode === 'custom'
      ? { mode: 'custom', requirement: htmlStyle.requirement.trim() }
      : { mode: htmlStyle.mode }
    const result = await summaries.exportHtml(reportId, style)
    exportMessage.value = result?.canceled ? '' : `HTML 已导出：${result.filePath}`
    htmlStyleOpen.value = false
    return result
  } catch (error) {
    exportMessage.value = ''
    summaries.error = error
    return null
  } finally {
    exportingHtml.value = false
  }
}
</script>
<style scoped>.toolbar{display:flex;justify-content:flex-end;margin-bottom:12px}.report-list{margin-bottom:12px;max-height:360px;overflow:auto}.report-list :deep(.ant-list-item){cursor:pointer}</style>
