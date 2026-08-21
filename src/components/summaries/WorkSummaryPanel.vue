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
        <a-button @click="refreshCurrent">刷新</a-button>
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
    <a-spin :spinning="summaries.loading || workLogsLoading || summaryTasks.loading">
      <a-row :gutter="14">
        <a-col :span="6">
          <!-- 任务态：左栏是单次总结任务的卡片列表 -->
          <a-list
            v-if="listMode === 'tasks'"
            :data-source="summaryTasks.tasks"
            :loading="summaryTasks.loading"
            :locale="{ emptyText: '还没有总结任务' }"
            class="report-list"
          >
            <template #renderItem="{ item }">
              <SummaryTaskCard
                :task="item"
                :active="item.sessionId === summaryTasks.selectedTaskId"
                @select="summaryTasks.selectTask(item.sessionId)"
                @open-chat="openChat(item)"
                @remove="summaryTasks.removeTask(item.sessionId)"
              />
            </template>
          </a-list>
          <!-- 工作日志态：按文件列出产物 -->
          <a-list
            v-else-if="listMode === 'worklogs'"
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
          <!-- 历史报告态：旧的按周期版本报告 -->
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
        <a-col :span="18">
          <!-- 任务态：选中任务的进度 / 产物预览 -->
          <SummaryTaskDetail
            v-if="listMode === 'tasks'"
            :task="selectedTask"
            @open-chat="openChat(selectedTask)"
          />
          <!-- 工作日志态：Markdown / HTML 产物预览 -->
          <WorkLogReportView
            v-else-if="listMode === 'worklogs'"
            :work-log="selectedWorkLog"
            @open-html="openWorkLogHtml"
          />
          <!-- 历史报告态：旧的按周期报告视图 -->
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
    <SummaryConversationDrawer v-model:open="drawerOpen" :task="chatTask" />
    <SummaryGenerateDialog v-model:open="dialogOpen" @open="onSummaryOpen" />
    <SummaryHtmlStyleDialog
      v-model:open="htmlStyleOpen"
      :confirm-loading="exportingHtml"
      @submit="exportHtml"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useSummariesStore } from '../../stores/summaries.js'
import { useSessionsStore } from '../../stores/sessions.js'
import { useSummaryTasksStore } from '../../stores/summaryTasks.js'
import ipc from '../../ipc.js'
import SummaryGenerateDialog from './SummaryGenerateDialog.vue'
import SummaryHtmlStyleDialog from './SummaryHtmlStyleDialog.vue'
import SummaryHistory from './SummaryHistory.vue'
import SummaryReportView from './SummaryReportView.vue'
import SummaryTaskCard from './SummaryTaskCard.vue'
import SummaryTaskDetail from './SummaryTaskDetail.vue'
import SummaryConversationDrawer from './SummaryConversationDrawer.vue'
import WorkLogReportView from './WorkLogReportView.vue'

const summaries = useSummariesStore()
const sessions = useSessionsStore()
const summaryTasks = useSummaryTasksStore()
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
  { label: '任务', value: 'tasks' },
  { label: '工作日志', value: 'worklogs' },
  { label: '历史报告', value: 'history' }
]
const listMode = ref('tasks')
const workLogs = ref([])
const workLogsLoading = ref(false)
const workLogsError = ref('')
const selectedWorkLog = ref(null)
const drawerOpen = ref(false)
const chatTask = ref(null)
let workLogPollTimer = null

const selectedTask = computed(() =>
  summaryTasks.tasks.find((task) => task.sessionId === summaryTasks.selectedTaskId) || null)

onMounted(async () => {
  await summaryTasks.init()
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
  summaryTasks.dispose()
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

function refreshCurrent() {
  if (listMode.value === 'worklogs') return loadWorkLogs()
  if (listMode.value === 'history') return reload()
  // 任务态：刷新产物清单，帮助按产物文件还原任务状态。
  return loadWorkLogs()
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

function openChat(task) {
  chatTask.value = task
  drawerOpen.value = true
}

function onListModeChange() {
  if (listMode.value === 'worklogs') {
    loadWorkLogs()
  } else if (listMode.value === 'history') {
    reload()
  }
}

// --- 总结任务自动运行 ---
async function onSummaryOpen(p) {
  const {
    sessionId, adapterId, briefPrompt, periodLabel, periodType, suggestedFileName, workLogsDir
  } = p
  summaryTasks.addTask({ sessionId, adapterId, periodLabel, periodType, suggestedFileName, workLogsDir })
  // 持久化任务↔产物文件名关联，供重启后从会话记录还原任务状态。
  if (suggestedFileName) {
    await ipc.updateSessionNote(sessionId, suggestedFileName).catch((error) => {
      ipc.log('warn', 'updateSessionNote failed:', error?.message || String(error))
    })
  }
  summaryTasks.selectTask(sessionId)
  listMode.value = 'tasks'
  runSummaryTask(sessionId, briefPrompt)
}

async function runSummaryTask(sessionId, briefPrompt) {
  try {
    await ipc.startAdapter(sessionId)
    await waitForReady(sessionId)
    // CLI 就绪后 TUI 输入区可能尚未渲染完成，稍等片刻再注入任务。
    await new Promise(resolve => setTimeout(resolve, 500))
    await ipc.sendTurn(sessionId, briefPrompt)
    summaryTasks.setStatus(sessionId, 'running')
    startWorkLogPolling()
  } catch (error) {
    summaryTasks.setError(sessionId, error)
    stopWorkLogPolling()
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

// 任务运行期间每 3 秒刷新一次产物清单：产物文件一出现即标记完成；
// 会话退出且无产物则标记失败/中断。全部任务落定后停止轮询。
function startWorkLogPolling() {
  stopWorkLogPolling()
  workLogPollTimer = setInterval(() => { void pollWorkLogs() }, 3000)
  void pollWorkLogs()
}

function stopWorkLogPolling() {
  if (workLogPollTimer) {
    clearInterval(workLogPollTimer)
    workLogPollTimer = null
  }
}

async function pollWorkLogs() {
  let reportList = []
  try {
    reportList = await ipc.listSummaryWorkLogs()
    if (listMode.value === 'worklogs') workLogs.value = reportList
  } catch (error) {
    workLogsError.value = error?.message || '无法读取工作日志'
    reportList = []
  }
  const reportNames = new Set(reportList.map((entry) => entry.name))
  const activeTasks = summaryTasks.tasks.filter((task) =>
    task.status === 'starting' || task.status === 'running')
  let anyActive = false
  for (const task of activeTasks) {
    if (!task.suggestedFileName) {
      anyActive = true
      continue
    }
    const htmlFileName = task.suggestedFileName.replace(/\.md$/i, '.html')
    if (reportNames.has(task.suggestedFileName) || reportNames.has(htmlFileName)) {
      summaryTasks.setStatus(task.sessionId, 'completed')
      continue
    }
    const session = sessions.byId(task.sessionId)
    if (session && (session.status === 'exited' || session.status === 'offline')) {
      summaryTasks.setStatus(task.sessionId, task.error ? 'failed' : 'interrupted')
      continue
    }
    anyActive = true
  }
  if (!anyActive) stopWorkLogPolling()
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
<style scoped>.toolbar{display:flex;justify-content:flex-end;margin-bottom:12px}.report-list{margin-bottom:12px;max-height:520px;overflow:auto}</style>
