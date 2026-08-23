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
      <!-- 任务态：左栏任务卡片 + 右栏进度/产物预览 -->
      <a-row v-if="listMode === 'tasks'" :gutter="14">
        <a-col :span="6">
          <a-list
            :data-source="summaryTasks.tasks"
            :loading="summaryTasks.loading"
            :locale="{ emptyText: '还没有总结任务' }"
            class="report-list"
          >
            <template #renderItem="{ item }">
              <SummaryTaskCard
                :task="item"
                :active="item.genId === summaryTasks.selectedTaskId"
                @select="summaryTasks.selectTask(item.genId)"
                @open-chat="openChat(item)"
                @remove="summaryTasks.removeTask(item.genId)"
              />
            </template>
          </a-list>
        </a-col>
        <a-col :span="18">
          <SummaryTaskDetail
            :task="selectedTask"
            @open-chat="openChat(selectedTask)"
          />
        </a-col>
      </a-row>
      <!-- 工作报告态：列表管理页面（每行 = 报告 + 格式徽章 + 操作） -->
      <template v-else>
        <a-alert
          v-if="conversionError"
          type="error"
          show-icon
          class="report-convert-alert"
          :message="conversionError"
        />
        <a-table
          :data-source="workLogs"
          :columns="reportColumns"
          :loading="workLogsLoading"
          row-key="name"
          :pagination="false"
          class="report-table"
          :locale="{ emptyText: '还没有生成的工作总结' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.dataIndex === 'name'">
              <a class="report-name" @click="previewReport(record)">{{ record.name }}</a>
              <a-tag :color="record.kind === 'html' ? 'purple' : 'blue'">{{ formatBadge(record.kind) }}</a-tag>
            </template>
            <template v-else-if="column.dataIndex === 'mtime'">
              {{ new Date(record.mtime).toLocaleString() }}
            </template>
            <template v-else-if="column.dataIndex === 'actions'">
              <a-space>
                <a-button size="small" type="link" @click="previewReport(record)">预览</a-button>
                <a-button size="small" type="link" @click="openReport(record)">打开</a-button>
                <a-button size="small" type="link" @click="revealReport(record)">在文件夹中显示</a-button>
                <a-button size="small" type="link" :loading="isConverting(record.name)" @click="convertFormat(record)">
                  {{ isConverting(record.name) ? '转换中…' : '转换格式' }}
                </a-button>
              </a-space>
            </template>
          </template>
        </a-table>
        <a-drawer
          v-model:open="previewOpen"
          :title="previewWorkLog?.name || '报告预览'"
          width="70%"
          destroy-on-close
        >
          <WorkLogReportView v-if="previewWorkLog" :work-log="previewWorkLog" @open-html="openWorkLogHtml" />
        </a-drawer>
      </template>
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
import { convertTargetFileName, dirnameOf, buildConversionPrompt } from './formatConversion.js'
import { appendGeneration, reportProducedByRun } from './summaryTaskNote.js'
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
// 工作报告：列表管理页的预览抽屉状态。
const previewOpen = ref(false)
const previewWorkLog = ref(null)
const reportColumns = [
  { title: '报告名称', dataIndex: 'name', key: 'name' },
  { title: '修改时间', dataIndex: 'mtime', key: 'mtime', width: 180 },
  { title: '操作', dataIndex: 'actions', key: 'actions', width: 330 }
]
const drawerOpen = ref(false)
const chatTask = ref(null)
let workLogPollTimer = null
const conversions = ref({})   // key: sourceName -> { targetFileName, sessionId, status:'running'|'done'|'error', error }
const conversionError = ref('')
let conversionPollTimer = null

const selectedTask = computed(() =>
  summaryTasks.tasks.find((task) => task.genId === summaryTasks.selectedTaskId) || null)

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
  stopConversionPolling()
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

function previewReport(report) {
  previewWorkLog.value = report
  previewOpen.value = true
}

function openReport(report) {
  return ipc.openPath(report.path)
}

function revealReport(report) {
  return ipc.showItemInFolder(report.path)
}

// --- 格式转换（调用 CLI，自动输入转换要求） ---
const isConverting = (name) => conversions.value[name]?.status === 'running'

async function convertFormat(report) {
  const sourceName = report.name
  const targetName = convertTargetFileName(sourceName)
  if (!targetName || conversions.value[sourceName]?.status === 'running') return
  conversionError.value = ''
  conversions.value[sourceName] = { targetFileName: targetName, sessionId: null, status: 'running', error: null }
  const executorId = summaries.settings?.defaultExecutorId || 'claude'
  try {
    const sessionId = await sessions.createSession({
      adapterId: executorId,
      cwd: dirnameOf(report.path),
      name: `格式转换（${sourceName} → ${targetName}）`
    })
    conversions.value[sourceName].sessionId = sessionId
    await ipc.startAdapter(sessionId)
    await waitForReady(sessionId)
    await new Promise(resolve => setTimeout(resolve, 500))
    await ipc.sendTurn(sessionId, buildConversionPrompt(sourceName, targetName))
    startConversionPolling()
  } catch (error) {
    conversions.value[sourceName].status = 'error'
    conversions.value[sourceName].error = error
    conversionError.value = error?.message || '格式转换失败'
  }
}

// 转换进行期间每 3 秒刷新一次报告清单：目标文件一出现即标记完成；
// 会话退出且无产物则标记失败。全部转换落定后停止轮询。
function startConversionPolling() {
  stopConversionPolling()
  conversionPollTimer = setInterval(() => { void pollConversions() }, 3000)
  void pollConversions()
}

function stopConversionPolling() {
  if (conversionPollTimer) {
    clearInterval(conversionPollTimer)
    conversionPollTimer = null
  }
}

async function pollConversions() {
  let reportList = []
  try {
    reportList = await ipc.listSummaryWorkLogs()
  } catch {
    return
  }
  const names = new Set(reportList.map((entry) => entry.name))
  for (const [sourceName, conv] of Object.entries(conversions.value)) {
    if (conv.status !== 'running') continue
    if (names.has(conv.targetFileName)) {
      conv.status = 'done'
      conversionError.value = ''
      await loadWorkLogs()          // 刷新列表，显示新文件
    } else {
      const session = sessions.byId(conv.sessionId)
      if (session && (session.status === 'exited' || session.status === 'offline')) {
        conv.status = 'error'
        conv.error = new Error('CLI 已退出，未生成目标文件')
        conversionError.value = conv.error.message
      }
    }
  }
  if (!Object.values(conversions.value).some((c) => c.status === 'running')) stopConversionPolling()
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
    sessionId, adapterId, briefPrompt, periodLabel, periodType, suggestedFileName, workLogsDir, genTime
  } = p
  const createdAt = genTime || Date.now()
  const genId = `${sessionId}:${createdAt}`
  // 共享会话一次只跑一轮：上一轮未结束前不注入新任务，避免往运行中的 CLI 塞第二条指令。
  if (summaryTasks.tasks.some((t) =>
    t.sessionId === sessionId && (t.status === 'starting' || t.status === 'running'))) {
    summaries.error = new Error('上一轮总结仍在运行，请等待完成后再生成')
    return
  }
  // 持久化本次生成记录到会话 taskNote（JSON 数组），供重启后从会话记录还原卡片。
  await sessions.updateNote(sessionId, appendGeneration(sessions.byId(sessionId)?.taskNote || '', {
    t: createdAt, f: suggestedFileName, pt: periodType, a: adapterId
  })).catch((error) => {
    ipc.log('warn', 'updateSessionNote failed:', error?.message || String(error))
  })
  const task = summaryTasks.addTask({ genId, sessionId, adapterId, periodLabel, periodType, suggestedFileName, workLogsDir, createdAt })
  summaryTasks.selectTask(genId)
  listMode.value = 'tasks'
  runSummaryTask(task, briefPrompt)
}

async function runSummaryTask(task, briefPrompt) {
  const sessionId = task.sessionId
  try {
    await ensureSessionRunable(sessionId)
    await waitForReady(sessionId)
    // CLI 就绪后 TUI 输入区可能尚未渲染完成，稍等片刻再注入任务。
    await new Promise(resolve => setTimeout(resolve, 500))
    await ipc.sendTurn(sessionId, briefPrompt)
    summaryTasks.setStatus(task.genId, 'running')
    startWorkLogPolling()
  } catch (error) {
    summaryTasks.setError(task.genId, error)
    stopWorkLogPolling()
  }
}

// 共享会话的二次运行：进程已退出/离线时，先清掉原生 CLI 会话 id（避免 codex 等
// resume 旧线程），再重启成全新一轮；首次新建的会话直接启动；已在线则等待就绪。
async function ensureSessionRunable(sessionId) {
  const session = sessions.byId(sessionId)
  const status = session?.status
  if (status === 'starting') {
    await ipc.startAdapter(sessionId)
    return
  }
  if (['running', 'ready', 'waiting'].includes(status)) {
    return
  }
  // 复用路径：清掉上一轮残留的「已就绪」标记，避免 waitForReady 的快捷判断
  // 误命中旧状态而跳过对新一轮就绪的等待。
  if (session) session.lastActivity = '启动中…'
  await ipc.resetNativeSession(sessionId).catch(() => {})
  await sessions.restart(sessionId)
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
  const activeTasks = summaryTasks.tasks.filter((task) =>
    task.status === 'starting' || task.status === 'running')
  let anyActive = false
  for (const task of activeTasks) {
    if (!task.suggestedFileName) {
      anyActive = true
      continue
    }
    // 只认「本次运行实际写出的」文件：同周期重新生成时磁盘上可能已有同名旧报告，
    // 其 mtime 早于本次生成时间，须等 CLI 真正覆盖后才算完成，避免误标 completed。
    if (reportProducedByRun(reportList, task)) {
      summaryTasks.setStatus(task.genId, 'completed')
      continue
    }
    const session = sessions.byId(task.sessionId)
    if (session && (session.status === 'exited' || session.status === 'offline')) {
      summaryTasks.setStatus(task.genId, task.error ? 'failed' : 'interrupted')
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
.report-table{margin-top:4px}
.report-convert-alert{margin-bottom:12px}
.report-name{color:#1677ff;cursor:pointer;margin-right:8px}
.report-name:hover{color:#4096ff}
</style>
