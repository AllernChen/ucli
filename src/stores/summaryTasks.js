import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

// 工作总结任务仓库。每个任务对应一次「生成总结」运行，即一个已持久化的
// 总结 CLI 会话（name 以 `工作总结（` 开头）。任务↔产物文件名的关联保存在
// 会话的 taskNote（suggestedFileName），因此从 `session:list` 即可完整还原，
// 无需新增数据库表。状态由轮询方（WorkSummaryPanel）驱动：
//   starting → running → completed / failed / interrupted
let unsub = null

// 从会话名 `工作总结（每周）` 解析周期标签。
function parsePeriodLabel(name) {
  const match = typeof name === 'string' ? name.match(/工作总结（(.+?)）/) : null
  return match ? match[1] : (name || '工作总结')
}

function inferStatus(session, hasArtifact) {
  if (hasArtifact) return 'completed'
  if (['starting', 'running', 'ready', 'waiting'].includes(session.status)) return 'running'
  return 'interrupted'
}

export const useSummaryTasksStore = defineStore('summaryTasks', {
  state: () => ({
    tasks: [], // { sessionId, adapterId, periodLabel, periodType, suggestedFileName, workLogsDir, createdAt, status, lastActivity, lastActivityTs, error }
    selectedTaskId: null,
    loading: false
  }),

  getters: {
    selectedTask(state) {
      return state.tasks.find((task) => task.sessionId === state.selectedTaskId) || null
    }
  },

  actions: {
    // 从已持久化的会话记录还原任务列表。产物文件存在 → completed；
    // 会话仍在运行 → running；已退出且无产物 → interrupted。
    async init() {
      if (unsub) return
      const offs = [
        ipc.on('session:event', (event) => this._onEvent(event))
      ]
      unsub = () => offs.forEach((fn) => fn && fn())
      this.loading = true
      try {
        const [sessions, workLogs] = await Promise.all([
          ipc.listSessions(),
          ipc.listSummaryWorkLogs()
        ])
        const reportNames = new Set(workLogs.map((entry) => entry.name))
        for (const session of sessions) {
          if (typeof session.name !== 'string' || !session.name.startsWith('工作总结（')) continue
          const suggestedFileName = session.taskNote || null
          const htmlFileName = suggestedFileName && suggestedFileName.replace(/\.md$/i, '.html')
          const hasArtifact = !!(suggestedFileName && (
            reportNames.has(suggestedFileName) ||
            (htmlFileName && reportNames.has(htmlFileName))
          ))
          this.tasks.push({
            sessionId: session.id,
            adapterId: session.adapterId,
            periodLabel: parsePeriodLabel(session.name),
            periodType: null, // 周期类型未持久化；由新建任务时传入
            suggestedFileName,
            workLogsDir: session.cwd || null,
            createdAt: session.createdAt || Date.now(),
            status: inferStatus(session, hasArtifact),
            lastActivity: session.lastActivity || '',
            lastActivityTs: session.updatedAt || session.createdAt || Date.now(),
            error: null
          })
        }
        this.tasks.sort((a, b) => b.createdAt - a.createdAt)
        if (this.tasks.length > 0 && !this.selectedTaskId) {
          this.selectedTaskId = this.tasks[0].sessionId
        }
      } catch (error) {
        // 还原是尽力而为：清单读取失败不清空任务，仅静默降级。
        ipc.log('warn', 'summaryTasks.init failed:', error?.message || String(error))
      } finally {
        this.loading = false
      }
    },

    addTask(payload) {
      const existing = this.tasks.find((task) => task.sessionId === payload.sessionId)
      if (existing) {
        Object.assign(existing, {
          adapterId: payload.adapterId,
          periodLabel: payload.periodLabel,
          periodType: payload.periodType,
          suggestedFileName: payload.suggestedFileName,
          workLogsDir: payload.workLogsDir,
          status: 'starting',
          lastActivity: '准备中',
          error: null
        })
        return existing
      }
      const task = {
        sessionId: payload.sessionId,
        adapterId: payload.adapterId,
        periodLabel: payload.periodLabel,
        periodType: payload.periodType,
        suggestedFileName: payload.suggestedFileName,
        workLogsDir: payload.workLogsDir,
        createdAt: Date.now(),
        status: 'starting',
        lastActivity: '准备中',
        lastActivityTs: Date.now(),
        error: null
      }
      this.tasks.unshift(task)
      return task
    },

    selectTask(sessionId) {
      this.selectedTaskId = sessionId
    },

    setStatus(sessionId, status) {
      const task = this.tasks.find((t) => t.sessionId === sessionId)
      if (task) task.status = status
    },

    setError(sessionId, error) {
      const task = this.tasks.find((t) => t.sessionId === sessionId)
      if (!task) return
      task.error = error
      task.status = 'failed'
      task.lastActivity = error?.message || '运行失败'
      task.lastActivityTs = Date.now()
    },

    removeTask(sessionId) {
      const index = this.tasks.findIndex((t) => t.sessionId === sessionId)
      if (index >= 0) this.tasks.splice(index, 1)
      if (this.selectedTaskId === sessionId) {
        this.selectedTaskId = this.tasks[0]?.sessionId || null
      }
    },

    dispose() {
      if (unsub) {
        unsub()
        unsub = null
      }
    },

    _onEvent(event) {
      const task = this.tasks.find((t) => t.sessionId === event.sessionId)
      if (!task) return
      task.lastActivityTs = event.ts || Date.now()
      if (event.type === 'ready') {
        task.lastActivity = '已就绪'
      } else if (event.type === 'exit') {
        task.lastActivity = `进程退出 (${event.code})`
      } else if (event.type === 'error') {
        task.error = event.message || null
        task.lastActivity = event.message || '运行错误'
      } else if (event.type === 'stats_update') {
        task.tokens = {
          input: event.usage?.inputTokens || 0,
          output: event.usage?.outputTokens || 0
        }
        if (event.costUsd != null) task.costUsd = event.costUsd
        task.lastActivity = `↑${task.tokens.input.toLocaleString()} ↓${task.tokens.output.toLocaleString()}`
      }
    }
  }
})
