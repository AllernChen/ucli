import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'
import { useSessionsStore } from './sessions.js'
import {
  parseTaskNote,
  dropGeneration,
  buildCardName,
  reportProducedByRun
} from '../components/summaries/summaryTaskNote.js'

// 工作总结任务仓库。一次「生成总结」运行 = 一张卡片，键为 genId
// （`${sessionId}:${生成时间戳}`）；同一周期的多次生成共用一个会话
// （name 以 `工作总结（` 开头），生成记录以 JSON 数组持久化在会话的 taskNote，
// 因此从 `session:list` 即可完整还原全部卡片（含历史生成），无需新增数据库表。
// 状态由轮询方（WorkSummaryPanel）驱动：
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
    // { genId, sessionId, adapterId, periodLabel, periodType, suggestedFileName,
    //   workLogsDir, createdAt, displayName, status, lastActivity, lastActivityTs, error }
    tasks: [],
    selectedTaskId: null, // genId
    loading: false
  }),

  getters: {
    selectedTask(state) {
      return state.tasks.find((task) => task.genId === state.selectedTaskId) || null
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
        // 重建前清空：面板在 tab 切换时反复挂载/卸载（dispose → init），
        // 不清空会在每次挂载时把全部卡片再追加一遍，导致任务卡片翻倍。
        this.tasks = []
        for (const session of sessions) {
          if (typeof session.name !== 'string' || !session.name.startsWith('工作总结（')) continue
          const gens = parseTaskNote(session.taskNote)
          if (gens.length === 0) continue
          const periodLabel = parsePeriodLabel(session.name)
          for (const gen of gens) {
            const suggestedFileName = gen.f
            const createdAt = gen.t || session.createdAt || Date.now()
            // 同周期重新生成的同名旧报告不能算本次成果：须文件 mtime 晚于本次生成
            // 时间才还原为 completed，否则按会话状态还原为 running/interrupted。
            const hasArtifact = reportProducedByRun(workLogs, { suggestedFileName, createdAt })
            this.tasks.push({
              genId: `${session.id}:${gen.t}`,
              sessionId: session.id,
              adapterId: gen.a || session.adapterId,
              periodLabel,
              periodType: gen.pt || null,
              suggestedFileName,
              workLogsDir: session.cwd || null,
              createdAt,
              displayName: buildCardName(periodLabel, createdAt),
              status: inferStatus(session, hasArtifact),
              lastActivity: session.lastActivity || '',
              lastActivityTs: session.updatedAt || session.createdAt || createdAt,
              error: null
            })
          }
        }
        this.tasks.sort((a, b) => b.createdAt - a.createdAt)
        if (this.tasks.length > 0) {
          // 选中项可能指向已被移除的生成，重建后回落到最新任务。
          if (!this.selectedTaskId || !this.tasks.some((t) => t.genId === this.selectedTaskId)) {
            this.selectedTaskId = this.tasks[0].genId
          }
        } else {
          this.selectedTaskId = null
        }
      } catch (error) {
        // 还原是尽力而为：清单读取失败不清空任务，仅静默降级。
        ipc.log('warn', 'summaryTasks.init failed:', error?.message || String(error))
      } finally {
        this.loading = false
      }
    },

    addTask(payload) {
      const createdAt = payload.createdAt || Date.now()
      const displayName = payload.displayName || buildCardName(payload.periodLabel, createdAt)
      const existing = this.tasks.find((task) => task.genId === payload.genId)
      if (existing) {
        Object.assign(existing, {
          adapterId: payload.adapterId,
          periodLabel: payload.periodLabel,
          periodType: payload.periodType,
          suggestedFileName: payload.suggestedFileName,
          workLogsDir: payload.workLogsDir,
          createdAt,
          displayName,
          status: 'starting',
          lastActivity: '准备中',
          lastActivityTs: Date.now(),
          error: null
        })
        return existing
      }
      const task = {
        genId: payload.genId,
        sessionId: payload.sessionId,
        adapterId: payload.adapterId,
        periodLabel: payload.periodLabel,
        periodType: payload.periodType,
        suggestedFileName: payload.suggestedFileName,
        workLogsDir: payload.workLogsDir,
        createdAt,
        displayName,
        status: 'starting',
        lastActivity: '准备中',
        lastActivityTs: Date.now(),
        error: null
      }
      this.tasks.unshift(task)
      return task
    },

    selectTask(genId) {
      this.selectedTaskId = genId
    },

    setStatus(genId, status) {
      const task = this.tasks.find((t) => t.genId === genId)
      if (task) task.status = status
    },

    setError(genId, error) {
      const task = this.tasks.find((t) => t.genId === genId)
      if (!task) return
      task.error = error
      task.status = 'failed'
      task.lastActivity = error?.message || '运行失败'
      task.lastActivityTs = Date.now()
    },

    async removeTask(genId) {
      const task = this.tasks.find((t) => t.genId === genId)
      const index = this.tasks.findIndex((t) => t.genId === genId)
      if (index >= 0) this.tasks.splice(index, 1)
      if (this.selectedTaskId === genId) {
        this.selectedTaskId = this.tasks[0]?.genId || null
      }
      if (!task) return
      // 从会话 taskNote 中摘除该次生成，避免下次挂载时卡片复活；共享会话本身保留。
      try {
        const sessionsStore = useSessionsStore()
        const session = sessionsStore.byId(task.sessionId)
        if (session?.taskNote) {
          await sessionsStore.updateNote(task.sessionId, dropGeneration(session.taskNote, genId))
        }
      } catch (error) {
        ipc.log('warn', 'summaryTasks.removeTask failed to persist:', error?.message || String(error))
      }
    },

    dispose() {
      if (unsub) {
        unsub()
        unsub = null
      }
    },

    _onEvent(event) {
      const candidates = this.tasks.filter((t) => t.sessionId === event.sessionId)
      if (!candidates.length) return
      // 多次生成共用一个会话：事件路由到当前活动（starting/running）的卡片；
      // 没有活动卡时回落到该会话最近一张（顺序按 init 排序，最新在前）。
      const task = candidates.find((t) => t.status === 'starting' || t.status === 'running') || candidates[0]
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
