<template>
  <div class="work-summary-panel">
    <div class="toolbar">
      <a-space>
        <a-segmented v-model:value="listMode" :options="listModes" @change="onListModeChange" />
        <a-select
          v-if="listMode === 'history'"
          v-model:value="summaries.filters.periodType"
          allow-clear
          placeholder="全部周期"
          :options="periodOptions"
          @change="reload"
        />
        <a-button @click="reload">刷新</a-button>
        <a-button type="primary" @click="dialogOpen = true">生成总结</a-button>
      </a-space>
    </div>
    <a-alert v-if="summaries.error" type="error" show-icon :message="summaries.error.message" />
    <a-alert v-if="workLogsError" type="error" show-icon :message="workLogsError" />
    <a-alert
      v-if="exportMessage"
      style="margin-bottom:12px"
      :type="exportingHtml ? 'info' : 'success'"
      show-icon
      :message="exportMessage"
    />
    <a-spin :spinning="summaries.loading || workLogsLoading">
      <a-row :gutter="14">
        <a-col :span="6">
          <a-list
            v-if="listMode === 'worklogs'"
            bordered
            :data-source="workLogs"
            class="report-list"
          >
            <template #renderItem="{ item }">
              <a-list-item @click="selectWorkLog(item)">
                <a-list-item-meta
                  :title="item.name"
                  :description="`${kindLabel(item.kind)} · ${new Date(item.mtime).toLocaleString()}`"
                />
              </a-list-item>
            </template>
          </a-list>
          <template v-else>
            <a-list bordered :data-source="summaries.reports" class="report-list">
              <template #renderItem="{ item }">
                <a-list-item @click="selectReport(item.id)">
                  <a-list-item-meta :title="`${item.periodType} · v${item.version}`" :description="`${item.status} · ${new Date(item.periodStart).toLocaleDateString()}`" />
                </a-list-item>
              </template>
            </a-list>
            <SummaryHistory :versions="summaries.versions" @select="selectReport" @set-current="setCurrent" @retry="retry" @delete-report="deleteReport" />
          </template>
        </a-col>
        <a-col :span="12">
          <div v-if="activeSummarySessionId" class="summary-cli">
            <div class="summary-cli-header">
              <a-tag color="blue">{{ activeSummaryMeta?.periodLabel }}</a-tag>
              <span class="summary-cli-adapter">{{ activeSummaryMeta?.adapterId }} · 内嵌 CLI</span>
            </div>
            <SessionTerminal
              :key="activeSummarySessionId"
              ref="summaryTerminal"
              :session-id="activeSummarySessionId"
            />
          </div>
          <a-empty v-else description="生成总结后，AI CLI 将在此处打开" />
        </a-col>
        <a-col :span="6">
          <WorkLogReportView
            v-if="listMode === 'worklogs'"
            :work-log="selectedWorkLog"
            @open-html="openWorkLogHtml"
          />
          <SummaryReportView
            v-else
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
    <SummaryGenerateDialog v-model:open="dialogOpen" @open="onSummaryOpen" />
    <SummaryHtmlStyleDialog
      v-model:open="htmlStyleOpen"
      :confirm-loading="exportingHtml"
      @submit="exportHtml"
    />
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useSummariesStore } from '../../stores/summaries.js'
import { useSessionsStore } from '../../stores/sessions.js'
import ipc from '../../ipc.js'
import SessionTerminal from '../SessionTerminal.vue'
import SummaryGenerateDialog from './SummaryGenerateDialog.vue'
import SummaryHtmlStyleDialog from './SummaryHtmlStyleDialog.vue'
import SummaryHistory from './SummaryHistory.vue'
import SummaryReportView from './SummaryReportView.vue'
import WorkLogReportView from './WorkLogReportView.vue'

const summaries = useSummariesStore()
const sessions = useSessionsStore()
const dialogOpen = ref(false)
const exportingHtml = ref(false)
const exportMessage = ref('')
const htmlStyleOpen = ref(false)
const htmlExportReportId = ref(null)
const periodOptions = [
  { label: '日', value: 'day' }, { label: '周', value: 'week' }, { label: '月', value: 'month' },
  { label: '季度', value: 'quarter' }, { label: '年', value: 'year' }
]
const listModes = [
  { label: '工作日志', value: 'worklogs' },
  { label: '历史报告', value: 'history' }
]
const listMode = ref('worklogs')
const workLogs = ref([])
const workLogsLoading = ref(false)
const workLogsError = ref('')
const selectedWorkLog = ref(null)
const activeSummarySessionId = ref(null)
const activeSummaryMeta = ref(null)
const summaryTerminal = ref(null)
let workLogPollTimer = null

onMounted(async () => {
  loadWorkLogs()
  try {
    await summaries.init()
    const current = summaries.reports.find(report => report.isCurrent) || summaries.reports[0]
    if (current) await summaries.selectReport(current.id)
  } catch (error) { summaries.error = error }
})
onUnmounted(() => {
  stopWorkLogPolling()
  summaries.dispose()
})

async function loadWorkLogs() {
  workLogsLoading.value = true
  workLogsError.value = ''
  try {
    workLogs.value = await ipc.listSummaryWorkLogs()
  } catch (error) {
    workLogsError.value = error?.message || '无法读取工作日志'
  } finally {
    workLogsLoading.value = false
  }
}

function kindLabel(kind) {
  return kind === 'html' ? 'HTML 报告' : 'Markdown 报告'
}

function selectWorkLog(item) {
  selectedWorkLog.value = item
}

function openWorkLogHtml(path) {
  return ipc.openPath(path)
}

function onListModeChange() {
  if (listMode.value === 'worklogs') {
    loadWorkLogs()
  } else {
    reload()
  }
}

// --- Embedded summary CLI ---
async function onSummaryOpen(payload) {
  const { sessionId, adapterId, briefPrompt, periodLabel } = payload
  activeSummarySessionId.value = sessionId
  activeSummaryMeta.value = { adapterId, periodLabel }
  // Ensure SessionTerminal has mounted and subscribed to terminal output
  // before the adapter boots, so early output is not lost.
  await nextTick()
  startSummarySession(sessionId, briefPrompt)
}

async function startSummarySession(sessionId, briefPrompt) {
  try {
    await ipc.startAdapter(sessionId)
    await waitForReady(sessionId)
    await ipc.sendTurn(sessionId, briefPrompt)
    startWorkLogPolling()
  } catch (error) {
    summaries.error = error
  }
}

function waitForReady(sessionId, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    if (sessions.byId(sessionId)?.lastActivity === '已就绪') { resolve(); return }
    let timer = null
    const off = ipc.on('session:event', (evt) => {
      if (evt.sessionId === sessionId && evt.type === 'ready') {
        off()
        if (timer) clearTimeout(timer)
        resolve()
      }
    })
    timer = setTimeout(() => { off(); resolve() }, timeoutMs)
  })
}

// While the summary CLI is alive, refresh the work log list so reports the CLI
// writes land in the left column without a manual refresh.
function startWorkLogPolling() {
  stopWorkLogPolling()
  workLogPollTimer = setInterval(() => {
    const sessionId = activeSummarySessionId.value
    if (!sessionId) { stopWorkLogPolling(); return }
    const status = sessions.byId(sessionId)?.status
    if (status === 'exited' || status === 'offline') { stopWorkLogPolling(); return }
    loadWorkLogs()
  }, 3000)
}

function stopWorkLogPolling() {
  if (workLogPollTimer) {
    clearInterval(workLogPollTimer)
    workLogPollTimer = null
  }
}

async function safely(operation) {
  try { summaries.error = null; return await operation() }
  catch (error) { summaries.error = error; return null }
}
function reload() {
  if (listMode.value === 'worklogs') return loadWorkLogs()
  return safely(() => summaries.loadReports())
}
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
  htmlStyleOpen.value = true
}
async function exportHtml(style) {
  if (exportingHtml.value) return null
  const reportId = htmlExportReportId.value
  if (!reportId || !style) return null
  exportingHtml.value = true
  exportMessage.value = style.mode === 'theme'
    ? '正在生成 HTML，本地主题将即时完成。'
    : '正在生成 HTML，将调用所选 AI CLI，完成后写入已选择的位置。'
  try {
    summaries.error = null
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
<style scoped>.toolbar{display:flex;justify-content:flex-end;margin-bottom:12px}.report-list{margin-bottom:12px;max-height:360px;overflow:auto}.report-list :deep(.ant-list-item){cursor:pointer}.summary-cli{display:flex;flex-direction:column;height:100%;min-height:420px}.summary-cli-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}.summary-cli-adapter{color:#8c8c8c;font-size:12px}.summary-cli .session-terminal{flex:1}</style>
