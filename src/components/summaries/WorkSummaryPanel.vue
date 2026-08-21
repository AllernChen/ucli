<template>
  <div class="work-summary-panel">
    <div class="toolbar">
      <a-space>
        <a-segmented v-model:value="listMode" :options="listModes" @change="onListModeChange" />
        <a-button @click="refreshCurrent">刷新</a-button>
        <a-button type="primary" @click="dialogOpen = true">生成总结</a-button>
      </a-space>
    </div>
    <a-alert v-if="summaries.error" type="error" show-icon :message="summaries.error.message" />
    <a-alert v-if="workLogsError" type="error" show-icon :message="workLogsError" />
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
          <!-- 工作报告态：按文件列出生成的报告 -->
          <a-list
            v-else-if="listMode === 'worklogs'"
            bordered
            :data-source="workLogs"
            class="report-list"
          >
            <template #renderItem="{ item }">
              <a-list-item @click="selectWorkLog(item)">
                <a-list-item-meta>
                  <template #title>
                    <a-space size="small">
                      <span>{{ item.name }}</span>
                      <a-tag :color="item.kind === 'html' ? 'purple' : 'blue'">{{ formatBadge(item.kind) }}</a-tag>
                    </a-space>
                  </template>
                  <template #description>{{ new Date(item.mtime).toLocaleString() }}</template>
                </a-list-item-meta>
              </a-list-item>
            </template>
          </a-list>
        </a-col>
        <a-col :span="18">
          <!-- 任务态：选中任务的进度 / 产物预览 -->
          <SummaryTaskDetail
            v-if="listMode === 'tasks'"
            :task="selectedTask"
            @open-chat="openChat(selectedTask)"
          />
          <!-- 工作报告态：报告管理器（操作工具栏 + Markdown / HTML 预览） -->
          <template v-else-if="listMode === 'worklogs'">
            <div v-if="selectedWorkLog" class="report-toolbar">
              <a-tag :color="selectedWorkLog.kind === 'html' ? 'purple' : 'blue'">{{ formatBadge(selectedWorkLog.kind) }}</a-tag>
              <a-space>
                <a-button size="small" @click="openReport(selectedWorkLog)">打开</a-button>
                <a-button size="small" @click="revealReport(selectedWorkLog)">在文件夹中显示</a-button>
              </a-space>
            </div>
            <WorkLogReportView :work-log="selectedWorkLog" @open-html="openWorkLogHtml" />
          </template>
        </a-col>
      </a-row>
    </a-spin>
    <SummaryConversationDrawer v-model:open="drawerOpen" :task="chatTask" />
    <SummaryGenerateDialog v-model:open="dialogOpen" @open="onSummaryOpen" />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useSummariesStore } from '../../stores/summaries.js'
import { useSessionsStore } from '../../stores/sessions.js'
import { useSummaryTasksStore } from '../../stores/summaryTasks.js'
import ipc from '../../ipc.js'
import SummaryGenerateDialog from './SummaryGenerateDialog.vue'
import SummaryTaskCard from './SummaryTaskCard.vue'
import SummaryTaskDetail from './SummaryTaskDetail.vue'
import SummaryConversationDrawer from './SummaryConversationDrawer.vue'
import WorkLogReportView from './WorkLogReportView.vue'

const summaries = useSummariesStore()
const sessions = useSessionsStore()
const summaryTasks = useSummaryTasksStore()
const dialogOpen = ref(false)
const listModes = [
  { label: '任务', value: 'tasks' },
  { label: '工作报告', value: 'worklogs' }
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
  // 初始化 summaries 以填充设置里的默认执行 CLI（供格式转换等使用）。
  try {
    await summaries.init()
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
    workLogsError.value = error?.message || '无法读取工作报告'
  } finally {
    workLogsLoading.value = false
  }
}

function refreshCurrent() {
  return loadWorkLogs()
}

function formatBadge(kind) {
  return kind === 'html' ? 'HTML' : 'MD'
}

function selectWorkLog(item) {
  selectedWorkLog.value = item
}

function openReport(report) {
  return ipc.openPath(report.path)
}

function revealReport(report) {
  return ipc.showItemInFolder(report.path)
}

function openWorkLogHtml(path) {
  return ipc.openPath(path)
}

function openChat(task) {
  chatTask.value = task
  drawerOpen.value = true
}

function onListModeChange() {
  if (listMode.value === 'worklogs') loadWorkLogs()
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
    workLogsError.value = error?.message || '无法读取工作报告'
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
</script>
<style scoped>
.toolbar{display:flex;justify-content:flex-end;margin-bottom:12px}
.report-list{margin-bottom:12px;max-height:520px;overflow:auto}
.report-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:12px}
</style>
