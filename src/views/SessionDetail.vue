<template>
  <div class="detail">
    <div class="detail-header">
      <a-button size="small" @click="$router.push('/')"><ArrowLeftOutlined /> 返回</a-button>
      <span class="title">{{ session?.icon }} {{ session?.displayName }}</span>
      <span class="cwd" :title="session?.cwd">{{ session?.cwd }}</span>
      <span :class="['status-badge', statusCls]">{{ statusText }}</span>
      <a-tag :color="tierColor">{{ tierLabel }}</a-tag>
      <span class="spacer"></span>
      <a-space size="small">
        <template v-if="isOffline">
          <a-button type="primary" size="small" @click="restartSession">重新启动</a-button>
          <a-popconfirm title="永久删除该会话？" @confirm="deleteSession"><a-button size="small" danger>删除</a-button></a-popconfirm>
        </template>
        <template v-else>
          <a-button size="small" @click="interrupt">中断</a-button>
          <a-popconfirm title="停止并离线保存？" @confirm="stop"><a-button size="small">停止</a-button></a-popconfirm>
        </template>
      </a-space>
    </div>

    <div v-if="session" class="info-bar">
      <a-space size="middle" wrap>
        <span class="info-kv"><b>模型</b> {{ session.model || '—' }}</span>
        <span class="info-kv"><b>↑</b> {{ fmtNum(session.stats.tokens.input) }}</span>
        <span class="info-kv"><b>↓</b> {{ fmtNum(session.stats.tokens.output) }}</span>
        <span v-if="session.stats.costUsd" class="info-kv"><b>$</b> {{ session.stats.costUsd.toFixed(4) }}</span>
        <span class="info-kv"><b>{{ session.stats.turns }}</b> 轮</span>
      </a-space>
    </div>

    <a-alert v-if="!session" type="info" message="会话不存在或已停止" />

    <div v-else class="detail-body">
      <TaskSummary :activities="activities" />
      <div class="task-note">
        <a-collapse :bordered="false" size="small">
          <a-collapse-panel key="note" header="📝 手动备注">
            <a-input v-model:value="noteDraft" placeholder="标记进度、下一步计划…（可选）" size="small" @blur="saveNote" />
          </a-collapse-panel>
        </a-collapse>
      </div>
      <!-- Terminal — full interactive mode, user types directly -->
      <div ref="terminalEl" class="terminal-container" @contextmenu.prevent="onContextMenu"></div>
      <ApprovalPanel :session-id="id" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import { ArrowLeftOutlined } from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import ApprovalPanel from '../components/ApprovalPanel.vue'
import TaskSummary from '../components/TaskSummary.vue'
import { ipc } from '../ipc.js'

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const route = useRoute()
const router = useRouter()
const store = useSessionsStore()
const id = computed(() => route.params.id)
const session = computed(() => store.byId(id.value))
const activities = computed(() => store.activitiesFor(id.value))
const terminalEl = ref(null)
const noteDraft = ref('')

let term = null
let fitAddon = null
let unsubEvents = null
let resizeObserver = null

const isRunning = computed(() => ['running', 'waiting'].includes(session.value?.status))
const isOffline = computed(() => session.value?.status === 'offline')

const statusCls = computed(() => {
  const m = { running: 'status-running', idle: 'status-idle', waiting: 'status-waiting', starting: 'status-running', error: 'status-error', exited: 'status-exited', offline: 'status-exited' }
  return m[session.value?.status] || 'status-idle'
})
const statusText = computed(() => {
  const m = { running: '运行中', idle: '空闲', waiting: '待确认', starting: '启动中', error: '错误', exited: '已退出', offline: '已离线' }
  return m[session.value?.status] || session.value?.status
})
const tierMap = {
  'always-agree': { label: '一直同意', color: 'red' },
  'safety-rules': { label: '安全规则', color: 'blue' },
  'ask-everything': { label: '逐次确认', color: 'orange' }
}
const tierLabel = computed(() => tierMap[session.value?.tier]?.label || session.value?.tier)
const tierColor = computed(() => tierMap[session.value?.tier]?.color || 'default')

function fmtNum(n) { return n ? n.toLocaleString() : '0' }

function initTerminal() {
  if (!terminalEl.value || term) return
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
    allowProposedApi: true,
    scrollback: 10000,
    theme: { background: '#0b1021', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(terminalEl.value)
  fitAddon.fit()
  syncSize()

  // Forward ALL terminal input directly to PTY (typing, Enter, Ctrl+C, slash commands, arrows)
  term.onData((data) => {
    window.ucli.sendTerminalInput(id.value, data)
  })

  // Custom keyboard handler for copy/paste
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+Shift+C / Ctrl+Insert → copy
    if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.ctrlKey && e.key === 'Insert')) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}) }
      return false
    }
    // Ctrl+Shift+V / Ctrl+Insert → paste
    if ((e.ctrlKey && e.shiftKey && e.key === 'V') || (e.ctrlKey && e.key === 'Insert' && e.shiftKey)) {
      navigator.clipboard.readText().then(t => { if (t) window.ucli.sendTerminalInput(id.value, t) }).catch(() => {})
      return false
    }
    // Ctrl+C with selection → copy; without selection → forward to PTY
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection()
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {})
        term.clearSelection()
        return false
      }
      // No selection: forward Ctrl+C to PTY as interrupt signal
      return true
    }
    // Ctrl+V without selection → paste
    if (e.ctrlKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then(t => { if (t) window.ucli.sendTerminalInput(id.value, t) }).catch(() => {})
      return false
    }
    return true
  })

  // Resize sync
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon) { fitAddon.fit(); syncSize() }
  })
  resizeObserver.observe(terminalEl.value)
}

function syncSize() {
  if (term && id.value) {
    window.ucli.terminalResize(id.value, term.cols, term.rows)
  }
}

onMounted(async () => {
  await store.init()
  noteDraft.value = session.value?.taskNote || ''
  await nextTick()
  initTerminal()

  // Subscribe to terminal output from PTY
  unsubEvents = ipc.on('session:terminal-output', (evt) => {
    if (evt.sessionId === id.value && term) {
      term.write(evt.data)
    }
  })

  // Now that the terminal-output listener is registered, start the adapter.
  // This ensures replayed history events are caught.
  if (session.value?.status === 'starting' || session.value?.status === 'idle') {
    ipc.startAdapter(id.value)
  }

  // Auto-restart offline sessions
  if (session.value?.status === 'offline') {
    restartSession()
  }
})

onBeforeUnmount(() => {
  if (unsubEvents) { unsubEvents(); unsubEvents = null }
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
  if (term) { term.dispose(); term = null }
})

watch(() => route.params.id, () => {
  noteDraft.value = session.value?.taskNote || ''
  if (term) term.clear()
  if (session.value?.status === 'offline') restartSession()
})

function onContextMenu(e) {
  // Right-click: paste from clipboard into terminal
  navigator.clipboard.readText().then(text => {
    if (text && term) {
      window.ucli.sendTerminalInput(id.value, text)
    }
  }).catch(() => {})
}

async function interrupt() {
  try { await store.interrupt(id.value); message.info('已发送中断') } catch (e) { message.error(String(e)) }
}
async function stop() {
  await store.stop(id.value)
  message.success('会话已离线保存')
}
async function restartSession() {
  try { await store.restart(id.value) } catch (e) { message.error('重启失败：' + (e?.message || e)) }
}
async function deleteSession() {
  await store.deleteSession(id.value)
  message.success('会话已删除')
  router.push('/')
}
async function saveNote() {
  await store.updateNote(id.value, noteDraft.value.trim())
}
</script>

<style scoped>
.detail { display: flex; flex-direction: column; height: 100%; }
.detail-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; margin-bottom: 8px; flex-shrink: 0; }
.detail-header .title { font-weight: 600; }
.detail-header .cwd { font-size: 12px; color: #8c8c8c; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spacer { flex: 1; }
.info-bar { background: #fff; border: 1px solid #f0f0f0; border-radius: 6px; padding: 6px 12px; margin-bottom: 8px; font-size: 12px; flex-shrink: 0; }
.info-kv { color: #595959; white-space: nowrap; }
.info-kv b { color: #262626; }
.task-note { margin-bottom: 8px; flex-shrink: 0; }
.task-note :deep(.ant-input) { font-size: 12px; }
.detail-body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.terminal-container { flex: 1; min-height: 0; background: #0b1021; border-radius: 8px; padding: 4px; overflow: hidden; }
.terminal-container :deep(.xterm) { height: 100%; }
</style>
