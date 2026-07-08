<template>
  <div class="detail">
    <!-- Header -->
    <div class="detail-header">
      <a-button size="small" @click="$router.push('/')"><ArrowLeftOutlined /> 返回</a-button>
      <span class="title">🖥️ 会话工作台</span>
      <span class="spacer"></span>
      <a-space size="small">
        <a-button size="small" @click="showImport = true">📥 导入</a-button>
        <a-button size="small" @click="$router.push('/')">➕ 新建</a-button>
        <a-radio-group v-model:value="splitCount" size="small" button-style="solid">
          <a-radio-button :value="1">1</a-radio-button>
          <a-radio-button :value="2">2</a-radio-button>
          <a-radio-button :value="4">4</a-radio-button>
        </a-radio-group>
      </a-space>
    </div>

    <div class="detail-layout">
      <!-- Left sidebar: session list -->
      <div class="sidebar">
        <div class="sidebar-toolbar">
          <a-input-search
            v-model:value="filter.search"
            placeholder="搜索 ID / 备注…"
            size="small"
            allowClear
          />
          <a-select
            v-model:value="filter.status"
            size="small"
            mode="multiple"
            placeholder="状态"
            style="width: 100%"
            allowClear
          >
            <a-select-option value="idle">空闲</a-select-option>
            <a-select-option value="running">运行中</a-select-option>
            <a-select-option value="waiting">待确认</a-select-option>
            <a-select-option value="offline">已离线</a-select-option>
            <a-select-option value="exited">已退出</a-select-option>
          </a-select>
        </div>
        <div class="session-list">
          <div
            v-for="s in filteredSessions"
            :key="s.id"
            :class="['session-item', activePane !== null && panes[activePane]?.sessionId === s.id ? 'assigned' : '']"
            @click="assignToPane(s.id)"
            @dblclick="openInNewPane(s.id)"
          >
            <div class="item-head">
              <span class="item-icon">{{ s.icon }}</span>
              <span class="item-name">{{ s.displayName?.slice(0,20) || s.adapterId }}</span>
              <span :class="['status-dot', s.status]"></span>
            </div>
            <div class="item-id">{{ s.id.slice(0,8) }}</div>
            <div class="item-stats" v-if="s.stats">
              ↑{{ fmtNum(s.stats.tokens.input) }} ↓{{ fmtNum(s.stats.tokens.output) }}
              <span v-if="s.stats.turns"> {{ s.stats.turns }}轮</span>
            </div>
            <div class="item-note" v-if="s.taskNote" :title="s.taskNote">📝 {{ s.taskNote.slice(0,30) }}{{ s.taskNote.length > 30 ? '…' : '' }}</div>
            <div class="item-activity">{{ s.lastActivity || '—' }}</div>
          </div>
          <a-empty v-if="!filteredSessions.length" description="无匹配会话" :imageStyle="{height:36}" />
        </div>
      </div>

      <!-- Right: split panes -->
      <div :class="['pane-grid', `split-${splitCount}`]">
        <div
          v-for="(pane, i) in panes"
          :key="pane.id"
          :class="['pane', activePane === i ? 'pane-active' : '']"
          @click="activePane = i"
        >
          <!-- Pane header -->
          <div class="pane-header">
            <span v-if="pane.sessionId" class="pane-session">
              {{ (sessions.byId(pane.sessionId)?.icon) || '•' }}
              {{ (sessions.byId(pane.sessionId)?.displayName || pane.sessionId.slice(0,8)) }}
              <span :class="['status-dot', sessions.byId(pane.sessionId)?.status]"></span>
            </span>
            <span v-else class="pane-session empty">点击左侧会话卡片分配到此窗口</span>
            <a-space size="small">
              <a-button v-if="pane.sessionId" size="small" type="text" @click.stop="openNote(i)" title="备注">📝</a-button>
              <a-button v-if="pane.sessionId" size="small" type="text" @click.stop="interruptPane(i)" title="中断">⏹</a-button>
              <a-button v-if="pane.sessionId" size="small" type="text" @click.stop="stopPane(i)" title="停止(离线保存)">⏸</a-button>
              <a-popconfirm v-if="pane.sessionId" title="删除会话？" @confirm="deletePane(i)" @click.stop>
                <a-button size="small" type="text" danger>🗑</a-button>
              </a-popconfirm>
            </a-space>
          </div>
          <!-- Pane info bar -->
          <div v-if="pane.sessionId" class="pane-info">
            <span class="pi-item">🔹 {{ sessions.byId(pane.sessionId)?.model || '—' }}</span>
            <span class="pi-item">↑{{ fmtNum(sessions.byId(pane.sessionId)?.stats?.tokens?.input) }}</span>
            <span class="pi-item">↓{{ fmtNum(sessions.byId(pane.sessionId)?.stats?.tokens?.output) }}</span>
            <span class="pi-item" v-if="sessions.byId(pane.sessionId)?.stats?.costUsd">${{ sessions.byId(pane.sessionId).stats.costUsd.toFixed(4) }}</span>
            <span class="pi-item">{{ sessions.byId(pane.sessionId)?.stats?.turns || 0 }} 轮</span>
            <span class="pi-item sid">{{ sessions.byId(pane.sessionId)?.id?.slice(0,8) }}</span>
          </div>
          <!-- Terminal container -->
          <div :ref="el => setPaneRef(i, el)" class="pane-terminal"></div>
        </div>
      </div>
    </div>

    <!-- Task note modal -->
    <a-modal v-model:open="noteVisible" title="会话备注" @ok="saveNote" okText="保存" cancelText="取消">
      <a-textarea v-model:value="noteDraft" :rows="6" placeholder="标记进度、下一步计划…" />
    </a-modal>

    <!-- Import historical sessions modal -->
    <a-modal v-model:open="showImport" title="导入历史会话" @ok="doImport" okText="导入" cancelText="取消" :confirmLoading="importing">
      <a-form layout="vertical">
        <a-form-item label="项目目录">
          <a-input-group compact>
            <a-input v-model:value="importCwd" style="width: calc(100% - 80px)" placeholder="选择目录" />
            <a-button style="width: 80px" @click="pickImportDir">浏览</a-button>
          </a-input-group>
        </a-form-item>
        <a-form-item v-if="importSessions.length" label="选择会话">
          <a-select v-model:value="importSessionIds2" mode="multiple" allowClear placeholder="选择历史会话（可多选）" style="width:100%">
            <a-select-option v-for="cs in importSessions" :key="cs.sessionId" :value="cs.sessionId">
              {{ cs.name || cs.sessionId?.slice(0,8) }}
              <span style="color:#8c8c8c;font-size:11px">{{ fmtTime(cs.startedAt) }}</span>
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="权限模式">
          <a-radio-group v-model:value="importTier">
            <a-radio value="always-agree">一直同意</a-radio>
            <a-radio value="safety-rules">安全规则</a-radio>
            <a-radio value="ask-everything">逐次确认</a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import { ArrowLeftOutlined } from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { ipc } from '../ipc.js'

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const router = useRouter()
const sessions = useSessionsStore()

// Split mode
const splitCount = ref(1)

// Active pane (click to select)
const activePane = ref(0)

// Each pane: { id, sessionId, term, fitAddon, resizeObserver }
const panes = ref([])
// Refs storage for pane terminal containers
const paneRefs = {}
function setPaneRef(i, el) { if (el) paneRefs[i] = el }

// IPC unsubscribers per pane
const unsubs = {}

// Filters
const filter = ref({ search: '', status: [] })

const filteredSessions = computed(() => {
  let list = sessions.sessions
  const s = filter.value.search?.toLowerCase()
  if (s) {
    list = list.filter(x =>
      x.id.toLowerCase().includes(s) ||
      (x.displayName || '').toLowerCase().includes(s) ||
      (x.taskNote || '').toLowerCase().includes(s)
    )
  }
  if (filter.value.status.length) {
    list = list.filter(x => filter.value.status.includes(x.status))
  }
  return list
})

function fmtNum(n) { return n ? n.toLocaleString() : '0' }

// --- Pane management ---
function createPanes(count) {
  // Dispose old terminals
  for (let i = 0; i < panes.value.length; i++) {
    destroyPaneTerminal(i)
  }
  panes.value = Array.from({ length: count }, (_, i) => ({
    id: `pane-${i}`, sessionId: panes.value[i]?.sessionId || null
  }))
  // Re-initialize terminals for all panes
  nextTick(() => { for (let i = 0; i < count; i++) initPaneTerminal(i) })
}

watch(splitCount, (n) => createPanes(n))

function initPaneTerminal(i) {
  const el = paneRefs[i]
  if (!el || panes.value[i]?.term) return
  const term = new Terminal({
    cursorBlink: true,
    disableStdin: false,
    fontSize: 13,
    fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
    allowProposedApi: true,
    scrollback: 5000,
    theme: { background: '#0b1021', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' }
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(el)
  fitAddon.fit()

  // Custom key handler for copy/paste
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.ctrlKey && e.key === 'Insert')) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}) }
      return false
    }
    if ((e.ctrlKey && e.shiftKey && e.key === 'V')) {
      navigator.clipboard.readText().then(t => { if (t) sendToPane(i, t) }).catch(() => {})
      return false
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); return false }
      return true
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then(t => { if (t) sendToPane(i, t) }).catch(() => {})
      return false
    }
    return true
  })

  // Forward input to PTY
  term.onData((data) => {
    const sid = panes.value[i]?.sessionId
    if (sid) window.ucli.sendTerminalInput(sid, data)
  })

  // Resize
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      try { fitAddon.fit() } catch {}
      const sid = panes.value[i]?.sessionId
      if (sid && term) window.ucli.terminalResize(sid, term.cols, term.rows)
    }
  })
  resizeObserver.observe(el)

  panes.value[i].term = term
  panes.value[i].fitAddon = fitAddon
  panes.value[i].resizeObserver = resizeObserver
}

function destroyPaneTerminal(i) {
  const p = panes.value[i]
  p?.resizeObserver?.disconnect()
  if (p?.term) {
    p.term.dispose()
    p.term = null
    p.fitAddon = null
    p.resizeObserver = null
  }
}

function sendToPane(i, data) {
  const sid = panes.value[i]?.sessionId
  if (sid) window.ucli.sendTerminalInput(sid, data)
}

// --- Assign sessions to panes ---
function assignToPane(sessionId) {
  if (activePane.value === null || activePane.value >= panes.value.length) {
    activePane.value = 0
  }
  // If same session already in other pane, clear it
  for (let i = 0; i < panes.value.length; i++) {
    if (i !== activePane.value && panes.value[i].sessionId === sessionId) {
      panes.value[i].sessionId = null
      panes.value[i].term?.clear()
    }
  }
  const oldSid = panes.value[activePane.value].sessionId
  if (oldSid !== sessionId) {
    panes.value[activePane.value].term?.clear()
  }
  panes.value[activePane.value].sessionId = sessionId
  // If session is offline, auto-restart; if running, attach terminal output
  const s = sessions.byId(sessionId)
  if (s?.status === 'offline') {
    sessions.restart(sessionId).catch(e => message.error('重启失败：' + (e?.message || e)))
  }
  // Subscribe terminal output for this pane
  subscribePaneTerminal(activePane.value, sessionId)
}

async function openInNewPane(sessionId) {
  // Open in a different pane if possible, otherwise same as click
  for (let i = 0; i < panes.value.length; i++) {
    if (!panes.value[i].sessionId) {
      activePane.value = i
      assignToPane(sessionId)
      return
    }
  }
  assignToPane(sessionId)
}

function clearPane(i) {
  panes.value[i].sessionId = null
  panes.value[i].term?.clear()
  unsubscribePane(i)
}
async function stopPane(i) {
  const sid = panes.value[i]?.sessionId
  if (!sid) return
  await sessions.stop(sid)
  panes.value[i].term?.clear()
  unsubscribePane(i)
  message.success('会话已离线保存')
}
async function deletePane(i) {
  const sid = panes.value[i]?.sessionId
  if (!sid) return
  await sessions.deleteSession(sid)
  panes.value[i].sessionId = null
  panes.value[i].term?.clear()
  unsubscribePane(i)
  message.success('会话已删除')
}

function interruptPane(i) {
  const sid = panes.value[i]?.sessionId
  if (sid) sessions.interrupt(sid)
}

let noteVisible = ref(false)
let noteSessionId = ref(null)
let noteDraft = ref('')
function openNote(i) {
  const sid = panes.value[i]?.sessionId
  if (!sid) return
  noteSessionId.value = sid
  noteDraft.value = sessions.byId(sid)?.taskNote || ''
  noteVisible.value = true
}
async function saveNote() {
  if (!noteSessionId.value) return
  await sessions.updateNote(noteSessionId.value, noteDraft.value.trim())
  noteVisible.value = false
}

// Import historical sessions
const showImport = ref(false)
const importCwd = ref('')
const importSessions = ref([])
const importSessionIds2 = ref([])
const importTier = ref('safety-rules')
const importing = ref(false)

async function pickImportDir() {
  const dir = await ipc.pickDirectory()
  if (dir) { importCwd.value = dir; await scanImport(dir) }
}
async function scanImport(dir) {
  importSessions.value = await ipc.scanClaudeSessions(dir)
  importSessionIds2.value = []
}
async function doImport() {
  const ids = importSessionIds2.value
  if (!ids.length || !importCwd.value) { message.warning('请选择目录和会话'); return }
  importing.value = true
  try {
    for (const sid of ids) {
      const cs = importSessions.value.find(s => s.sessionId === sid)
      const config = { adapterId: 'claude', cwd: importCwd.value, tier: importTier.value, cliSessionId: sid }
      if (cs?.name) config.name = cs.name
      if (cs?.startedAt) config.startedAt = cs.startedAt
      await sessions.createSession(config)
    }
    showImport.value = false
    importSessions.value = []
    importSessionIds2.value = []
    message.success(`已导入 ${ids.length} 个会话`)
  } catch (e) { message.error('导入失败：' + (e?.message || e)) }
  finally { importing.value = false }
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`
}

// --- Terminal output routing ---
function subscribePaneTerminal(i, sessionId) {
  unsubscribePane(i)
  unsubs[i] = ipc.on('session:terminal-output', (evt) => {
    if (evt.sessionId === sessionId && panes.value[i]?.term) {
      panes.value[i].term.write(evt.data)
    }
  })
}

function unsubscribePane(i) {
  if (unsubs[i]) { unsubs[i](); unsubs[i] = null }
}

// --- Lifecycle ---
onMounted(async () => {
  await sessions.init()
  createPanes(1)
  // Auto-assign session if navigated from workbench card click
  if (sessions.pendingAssign) {
    assignToPane(sessions.pendingAssign)
    sessions.pendingAssign = null
  }
})

onBeforeUnmount(() => {
  for (let i = 0; i < panes.value.length; i++) {
    destroyPaneTerminal(i)
    unsubscribePane(i)
  }
})
</script>

<style scoped>
.detail { display: flex; flex-direction: column; height: 100%; }
.detail-header {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  background: #fff; border: 1px solid #f0f0f0; border-radius: 8px;
  margin-bottom: 8px; flex-shrink: 0;
}
.detail-header .title { font-weight: 600; }
.spacer { flex: 1; }

.detail-layout { flex: 1; display: flex; gap: 8px; min-height: 0; }

/* Sidebar */
.sidebar {
  width: 240px; flex-shrink: 0; display: flex; flex-direction: column;
  background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; overflow: hidden;
}
.sidebar-toolbar { padding: 8px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid #f0f0f0; }
.session-list { flex: 1; overflow-y: auto; padding: 4px; }
.session-item {
  padding: 8px 10px; cursor: pointer; border-radius: 6px; margin-bottom: 2px;
  transition: background .12s; border: 1px solid transparent;
}
.session-item:hover { background: #f5f5f5; }
.session-item.assigned { background: #e6f4ff; border-color: #1677ff; }
.item-head { display: flex; align-items: center; gap: 4px; }
.item-icon { font-size: 14px; }
.item-name { font-size: 12px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-id { font-size: 10px; color: #bfbfbf; font-family: monospace; margin-top: 1px; }
.item-stats { font-size: 10px; color: #8c8c8c; }
.item-activity { font-size: 10px; color: #bfbfbf; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.status-dot.running { background: #1677ff; }
.status-dot.idle { background: #52c41a; }
.status-dot.waiting { background: #faad14; }
.status-dot.offline, .status-dot.exited { background: #bfbfbf; }
.status-dot.error { background: #ff4d4f; }

/* Pane grid */
.pane-grid { flex: 1; display: grid; gap: 6px; min-height: 0; }
.pane-grid.split-1 { grid-template-columns: 1fr; grid-template-rows: 1fr; }
.pane-grid.split-2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
.pane-grid.split-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }

.pane {
  display: flex; flex-direction: column; min-height: 0;
  border-radius: 8px; overflow: hidden;
  border: 2px solid #d9d9d9;
}
.pane-active { border-color: #1677ff; }

.pane-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 3px 8px; background: #fafafa; border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0; min-height: 28px;
}
.pane-session { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px; }
.pane-session.empty { color: #bfbfbf; }

.pane-info {
  display: flex; gap: 10px; padding: 2px 8px; background: #fff; font-size: 11px;
  border-bottom: 1px solid #f0f0f0; flex-shrink: 0; color: #595959; flex-wrap: wrap;
}
.pi-item { white-space: nowrap; }
.pi-item.sid { font-family: monospace; color: #bfbfbf; font-size: 10px; }
.pane-terminal { flex: 1; min-height: 0; padding: 4px; background: #0b1021; }
.pane-terminal :deep(.xterm) { height: 100%; }
</style>
