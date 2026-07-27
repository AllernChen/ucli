<template>
  <div class="detail">
    <!-- Header -->
    <div class="detail-header">
      <a-button size="small" @click="$router.push('/')"><ArrowLeftOutlined /> 返回</a-button>
      <span class="title">🖥️ 会话工作台</span>
      <a-button
        size="small"
        type="text"
        :title="sessionListHidden ? '显示会话列表' : '隐藏会话列表'"
        @click="sessionListHidden = !sessionListHidden"
      >
        <MenuUnfoldOutlined v-if="sessionListHidden" />
        <MenuFoldOutlined v-else />
      </a-button>
      <span class="spacer"></span>
      <div class="header-actions">
        <a-space size="small">
          <a-button size="small" @click="showImport = true">📥 导入</a-button>
          <a-button size="small" @click="$router.push('/')">➕ 新建</a-button>
          <span v-if="assignedPaneCount > 1" class="shortcut-hint"><kbd>Tab</kbd> 切换会话</span>
          <a-radio-group v-model:value="splitCount" size="small" button-style="solid">
            <a-radio-button :value="1">1</a-radio-button>
            <a-radio-button :value="2">2</a-radio-button>
            <a-radio-button :value="4">4</a-radio-button>
          </a-radio-group>
          <a-button
            v-if="splitCount > 1"
            size="small"
            @click="toggleWorkbenchFullscreen"
            title="整个分屏工作台全屏"
          >
            <FullscreenOutlined /> 分屏全屏
          </a-button>
        </a-space>
      </div>
    </div>

    <div class="detail-layout">
      <!-- Left sidebar: session list -->
      <div v-if="!sessionListHidden" class="sidebar">
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
              <span v-if="nameEditId !== s.id" class="item-name-wrap">
                <span class="item-name">{{ s.displayName || s.adapterId }}</span>
                <EditOutlined class="item-name-edit-icon" @click.stop="startNameEdit(s)" title="重命名" />
              </span>
              <a-input
                v-else
                ref="nameEditRef"
                v-model:value="nameEditDraft"
                size="small"
                class="item-name-input"
                @click.stop
                @press-enter="saveNameEdit"
                @blur="saveNameEdit"
                @keydown.escape.prevent="cancelNameEdit"
              />
              <span :class="['status-dot', s.status]"></span>
              <a-popconfirm
                title="从 UCLI 移除会话？源会话和用量统计会保留。"
                @confirm.stop="deleteSessionById(s.id)"
                @click.stop
              >
                <DeleteOutlined class="item-delete-btn" title="移除 UCLI 记录" />
              </a-popconfirm>
            </div>
            <div class="item-path" :title="s.cwd">📁 {{ s.cwd || '—' }}</div>
            <div class="item-meta">
              <span class="item-id">{{ s.id.slice(0,8) }}</span>
              <span class="item-time">{{ fmtTime(s.createdAt || s.startedAt) }}</span>
            </div>
            <div class="item-stats" v-if="s.stats">
              ↑{{ fmtNum(s.stats.tokens.input) }} ↓{{ fmtNum(s.stats.tokens.output) }}
              <span v-if="s.stats.turns"> · {{ s.stats.turns }}轮</span>
            </div>
            <div class="item-note" v-if="s.taskNote" :title="s.taskNote">📝 {{ s.taskNote.slice(0,30) }}{{ s.taskNote.length > 30 ? '…' : '' }}</div>
          </div>
          <a-empty v-if="!filteredSessions.length" description="无匹配会话" :imageStyle="{height:36}" />
        </div>
      </div>

      <!-- Right: split panes -->
      <div ref="paneGridRef" :class="['pane-grid', `split-${splitCount}`]">
        <a-button
          v-if="gridFullscreen"
          class="grid-fullscreen-exit"
          size="small"
          @click.stop="toggleWorkbenchFullscreen"
          title="退出分屏全屏"
        >
          <FullscreenExitOutlined /> 退出全屏
        </a-button>
        <div
          v-for="(pane, i) in panes"
          :key="pane.id"
          :ref="el => setPaneRootRef(i, el)"
          :class="['pane', activePane === i ? 'pane-active' : '']"
          @click="activatePane(i)"
        >
          <!-- Pane header -->
          <div class="pane-header">
            <span v-if="pane.sessionId" class="pane-session">
              {{ (sessions.byId(pane.sessionId)?.icon) || '•' }}
              {{ (sessions.byId(pane.sessionId)?.displayName || pane.sessionId.slice(0,8)) }}
              <span :class="['status-dot', sessions.byId(pane.sessionId)?.status]"></span>
            </span>
            <span v-else class="pane-session empty">点击左侧会话卡片分配到此窗口</span>
            <span class="pane-actions">
              <a-space size="small">
                <a-button
                  v-if="pane.sessionId"
                  size="small"
                  type="text"
                  @click.stop="openFolderForPane(i)"
                  title="打开工作目录"
                >
                  <FolderOpenOutlined />
                </a-button>
                <a-button
                  v-if="pane.sessionId && !gridFullscreen"
                  size="small"
                  type="text"
                  @click.stop="togglePaneFullscreen(i)"
                  :title="fullscreenPane === i ? '退出全屏' : '全屏显示当前会话'"
                >
                  <FullscreenExitOutlined v-if="fullscreenPane === i" />
                  <FullscreenOutlined v-else />
                </a-button>
                <a-button v-if="pane.sessionId" size="small" type="text" @click.stop="openNote(i)" title="备注">📝</a-button>
                <a-button v-if="pane.sessionId" size="small" type="text" @click.stop="clearPane(i)" title="仅关闭窗格，会话继续运行">关闭</a-button>
              </a-space>
            </span>
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
    <a-modal v-model:open="showImport" title="导入历史会话" :footer="null" width="640px">
      <a-form layout="vertical">
        <a-form-item label="项目目录">
          <a-input-group compact>
            <a-input v-model:value="importCwd" style="width: calc(100% - 80px)" placeholder="选择目录" @change="onImportCwdChange" />
            <a-button style="width: 80px" @click="pickImportDir">浏览</a-button>
          </a-input-group>
        </a-form-item>

        <!-- Grouped by CLI -->
        <div v-if="hasImportGroups" style="margin-bottom:12px">
          <div class="section-label">发现的历史会话</div>
          <div v-for="group in importGroups" :key="group.id" class="import-cli-group">
            <div class="import-cli-header">
              <span class="import-cli-icon">{{ group.icon }}</span>
              <span class="import-cli-name">{{ group.displayName }}</span>
              <span class="import-cli-count">{{ group.sessions.length }} 个</span>
            </div>
            <div v-if="group.sessions.length" class="import-session-list">
              <a-checkbox-group v-model:value="importSelection[group.id]" style="width:100%">
                <div v-for="s in group.sessions" :key="s.sessionId" class="import-session-row">
                  <a-checkbox :value="s.sessionId" :disabled="s.imported">
                    <div>
                      <span class="iss-name">{{ s.name || s.sessionId?.slice(0, 12) }}</span>
                      <a-tag v-if="s.imported" color="default">已添加</a-tag>
                      <span class="iss-meta" v-if="s.model">{{ s.model }}</span>
                      <span class="iss-meta provider-change" v-if="s.providerChanged">provider: {{ s.sourceProvider }} → {{ s.resumeProvider }}</span>
                      <span class="iss-meta" v-else-if="s.sourceProvider">provider: {{ s.sourceProvider }}</span>
                      <span class="iss-meta" v-if="s.turns">{{ s.turns }} 轮</span>
                      <span class="iss-meta">{{ fmtTime(s.startedAt) }}</span>
                    </div>
                    <div class="iss-preview" v-if="s.lastMessage">{{ s.lastMessage }}</div>
                  </a-checkbox>
                </div>
              </a-checkbox-group>
            </div>
            <div v-else class="import-none">该目录下无 {{ group.displayName }} 历史会话</div>
          </div>
        </div>
        <div v-else-if="importCwd" class="import-none" style="text-align:center;padding:12px">
          <span v-if="discoveringImport"><a-spin size="small" /> 正在查找历史会话…</span>
          <a-alert v-else-if="importError" type="error" show-icon :message="`历史会话读取失败：${importError}`" />
          <span v-else>该目录下没有发现任何历史会话</span>
        </div>

        <a-form-item label="权限模式">
          <a-radio-group v-model:value="importTier">
            <a-radio value="always-agree">一直同意</a-radio>
            <a-radio value="safety-rules">安全规则</a-radio>
            <a-radio value="ask-everything">逐次确认</a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
      <div class="modal-footer">
        <a-button @click="showImport = false">取消</a-button>
        <a-button type="primary" @click="doImport" :loading="importing" :disabled="!totalImportSelected">
          导入选中会话 ({{ totalImportSelected }})
        </a-button>
      </div>
    </a-modal>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  EditOutlined
} from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { ipc } from '../ipc.js'
import { nextSessionPaneIndex } from '../workbenchKeyboard.js'
import {
  reconcileSessionPanes,
  resolveSessionFocusPane,
  resolveWorkbenchFullscreenTarget,
  toggleElementFullscreen
} from '../workbenchLayout.js'

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const router = useRouter()
const sessions = useSessionsStore()
const sessionListHidden = ref(sessions.workbench.sessionListHidden)
watch(sessionListHidden, (v) => sessions.setSessionListHidden(v))
const fullscreenPane = ref(null)
const gridFullscreen = ref(false)
const paneGridRef = ref(null)

// Split mode — backed by store so it survives route changes
const splitCount = computed({
  get: () => sessions.workbench.splitCount,
  set: (v) => sessions.setWorkbenchSplit(v)
})

// Active pane — backed by store
const activePane = computed({
  get: () => sessions.workbench.activePane,
  set: (v) => sessions.setWorkbenchActivePane(v)
})

// Each pane: { id, sessionId, term, fitAddon, resizeObserver }
const panes = ref([])
const assignedPaneCount = computed(() => panes.value.filter((pane) => pane.sessionId).length)

function openFolderForPane(i) {
  const sid = panes.value[i]?.sessionId
  if (!sid) return
  const s = sessions.byId(sid)
  if (s?.cwd) ipc.openFolder(s.cwd)
}
// Refs storage for pane terminal containers
const paneRefs = {}
const paneRootRefs = {}
function setPaneRef(i, el) {
  if (el) paneRefs[i] = el
  else delete paneRefs[i]
}
function setPaneRootRef(i, el) {
  if (el) paneRootRefs[i] = el
  else delete paneRootRefs[i]
}

// IPC unsubscribers per pane
const unsubs = {}

// Inline name editing
const nameEditId = ref(null)
const nameEditDraft = ref('')
const nameEditRef = ref(null)
function startNameEdit(s) {
  nameEditId.value = s.id
  nameEditDraft.value = s.displayName || ''
  nextTick(() => nameEditRef.value?.focus())
}
async function saveNameEdit() {
  const id = nameEditId.value
  if (!id) return
  const name = nameEditDraft.value.trim()
  if (name && name !== sessions.byId(id)?.displayName) {
    await sessions.updateName(id, name)
  }
  nameEditId.value = null
}
function cancelNameEdit() {
  nameEditId.value = null
  nameEditDraft.value = ''
}

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
  const currentPanes = panes.value
  // Only dispose panes that are actually removed. Existing pane instances keep
  // their xterm scrollback when switching between 1/2/4 pane layouts.
  for (let i = count; i < currentPanes.length; i++) {
    destroyPaneTerminal(i)
    unsubscribePane(i)
  }
  panes.value = reconcileSessionPanes(currentPanes, count, (i) => {
    const savedId = sessions.workbench.paneSessionIds[i]
    return sessions.byId(savedId) ? savedId : null
  }).panes
  if (activePane.value >= count) activePane.value = count - 1
  // Initialize only new panes. ResizeObserver refits retained terminals after
  // the grid changes size.
  nextTick(() => {
    for (let i = 0; i < count; i++) {
      const needsInit = !panes.value[i]?.term
      if (needsInit) initPaneTerminal(i)
      const sessionId = panes.value[i]?.sessionId
      if (needsInit && sessionId) {
        if (!unsubs[i]) subscribePaneTerminal(i, sessionId)
        const s = sessions.byId(sessionId)
        if (s?.status === 'offline') {
          sessions.restart(sessionId).catch(e => message.error('重启失败：' + (e?.message || e)))
        } else {
          ipc.attachTerminal(sessionId)
        }
      } else {
        try { panes.value[i]?.fitAddon?.fit() } catch {}
      }
    }
  })
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

  // Capture paste at root to suppress xterm's native handler + Electron menu
  // double-fire. We read clipboard and send to PTY manually — see key handler above.
  term.element.addEventListener('paste', (e) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    navigator.clipboard.readText().then(t => { if (t) sendToPane(i, t) }).catch(() => {})
  }, { capture: true })

  // Clickable links via official addon — handles coordinate mapping correctly
  const webLinksAddon = new WebLinksAddon((e, uri) => {
    if (e.ctrlKey || e.metaKey) ipc.openExternal(uri)
  })
  term.loadAddon(webLinksAddon)

  // Custom key handler for copy/paste
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const switched = switchSessionPane(e.shiftKey ? -1 : 1)
      if (switched) {
        e.preventDefault()
        e.stopPropagation()
      }
      return !switched
    }
    if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.ctrlKey && e.key === 'Insert')) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}) }
      return false
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); return false }
      return true
    }
    // Ctrl+V / Ctrl+Shift+V: let the capture-phase paste handler below
    // handle it so we avoid triple-sending (xterm native paste + electron menu + this handler)
    if ((e.ctrlKey && (e.key === 'v' || e.key === 'V'))) {
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
  panes.value[i].webLinksAddon = webLinksAddon
}

function destroyPaneTerminal(i) {
  const p = panes.value[i]
  p?.resizeObserver?.disconnect()
  p?.webLinksAddon?.dispose()
  if (p?.term) {
    p.term.dispose()
    p.term = null
    p.fitAddon = null
    p.resizeObserver = null
    p.webLinksAddon = null
  }
}

function sendToPane(i, data) {
  const sid = panes.value[i]?.sessionId
  if (sid) window.ucli.sendTerminalInput(sid, data)
}

function activatePane(i) {
  activePane.value = i
  nextTick(() => panes.value[i]?.term?.focus())
}

async function togglePaneFullscreen(i) {
  try {
    await toggleElementFullscreen(document, paneRootRefs[i])
  } catch (e) {
    message.error('切换全屏失败：' + (e?.message || e))
  }
}

async function toggleWorkbenchFullscreen() {
  try {
    await toggleElementFullscreen(document, paneGridRef.value)
  } catch (e) {
    message.error('切换分屏全屏失败：' + (e?.message || e))
  }
}

function onFullscreenChange() {
  const target = resolveWorkbenchFullscreenTarget(
    document.fullscreenElement,
    paneGridRef.value,
    paneRootRefs
  )
  gridFullscreen.value = target.grid
  fullscreenPane.value = target.paneIndex
  nextTick(() => {
    const targets = target.grid || !document.fullscreenElement
      ? panes.value
      : [panes.value[fullscreenPane.value ?? activePane.value]]
    for (const pane of targets) {
      try { pane?.fitAddon?.fit() } catch {}
    }
    const i = fullscreenPane.value ?? activePane.value
    panes.value[i]?.term?.focus()
  })
}

function switchSessionPane(direction = 1) {
  const next = nextSessionPaneIndex(panes.value, activePane.value, direction)
  if (next === null) return false
  activatePane(next)
  return true
}

function onWorkbenchKeydown(event) {
  if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
  const target = event.target
  if (target instanceof Element && !target.closest('.xterm') && target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"], .ant-select')) return
  if (switchSessionPane(event.shiftKey ? -1 : 1)) {
    event.preventDefault()
    event.stopPropagation()
  }
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
      sessions.setWorkbenchPane(i, null)
      unsubscribePane(i)
    }
  }
  const oldSid = panes.value[activePane.value].sessionId
  if (oldSid !== sessionId) {
    panes.value[activePane.value].term?.clear()
  }
  panes.value[activePane.value].sessionId = sessionId
  sessions.setWorkbenchPane(activePane.value, sessionId)
  nextTick(() => panes.value[activePane.value]?.term?.focus())
  // If session is offline, auto-restart; if running, attach terminal output
  const s = sessions.byId(sessionId)
  // Subscribe terminal output first so we don't miss startup output
  subscribePaneTerminal(activePane.value, sessionId)
  if (s?.status === 'offline') {
    // Offline persisted session — restart (which calls start → replays history)
    sessions.restart(sessionId).catch(e => message.error('重启失败：' + (e?.message || e)))
  } else if (s?.status === 'starting') {
    // Brand new session — start the adapter (terminal is already subscribed)
    ipc.startAdapter(sessionId)
  } else {
    // Already running/idle — replay history to this pane
    ipc.attachTerminal(sessionId)
  }
}

function focusSessionFromNotification(sessionId) {
  if (!sessionId || !panes.value.length) return false
  const target = resolveSessionFocusPane(panes.value, sessionId, activePane.value)
  activePane.value = target
  if (panes.value[target]?.sessionId === sessionId) {
    activatePane(target)
  } else {
    assignToPane(sessionId)
  }
  sessions.pendingAssign = null
  return true
}

watch(() => sessions.pendingAssign, (sessionId) => {
  if (sessionId) focusSessionFromNotification(sessionId)
})

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
  const oldSid = panes.value[i]?.sessionId
  if (!oldSid) return

  // Collect remaining sessions in pane order
  const remaining = []
  for (let j = 0; j < panes.value.length; j++) {
    if (j !== i && panes.value[j].sessionId) remaining.push(panes.value[j].sessionId)
  }
  const filled = remaining.length
  if (filled === 0) return

  const newCount = filled >= 3 ? 4 : filled >= 2 ? 2 : 1
  const splitChanged = newCount !== panes.value.length
  const oldCount = panes.value.length

  // FLIP: capture old pane positions
  const oldRects = []
  for (let j = 0; j < oldCount; j++) {
    const el = paneRootRefs[j]
    oldRects[j] = el?.getBoundingClientRect() || null
  }

  // Unsubscribe all current subscriptions
  for (let j = 0; j < oldCount; j++) {
    if (panes.value[j]?.sessionId) unsubscribePane(j)
  }

  // Clear all session IDs and terminals
  for (let j = 0; j < oldCount; j++) {
    panes.value[j].sessionId = null
    panes.value[j].term?.clear()
    sessions.setWorkbenchPane(j, null)
  }

  // Update workbench pane IDs for the compacted layout
  for (let j = 0; j < newCount; j++) {
    sessions.workbench.paneSessionIds[j] = j < filled ? remaining[j] : null
  }
  sessions.workbench.splitCount = newCount
  sessions.saveWorkbench()

  // Assign sessions in compacted order to existing pane objects
  for (let j = 0; j < filled; j++) {
    panes.value[j].sessionId = remaining[j]
  }

  // splitCount computed already reacted via watch → createPanes above
  // For same-split, trim trailing panes manually.
  if (!splitChanged && panes.value.length > newCount) {
    for (let j = newCount; j < panes.value.length; j++) {
      destroyPaneTerminal(j)
      unsubscribePane(j)
    }
    panes.value.length = newCount
  }

  if (activePane.value >= newCount) activePane.value = 0

  // After DOM flush, subscribe terminals + FLIP animate
  nextTick(() => {
    for (let j = 0; j < filled; j++) {
      subscribePaneTerminal(j, remaining[j])
      const s = sessions.byId(remaining[j])
      if (s?.status === 'offline') {
        sessions.restart(remaining[j]).catch(() => {})
      } else if (s?.status === 'starting') {
        ipc.startAdapter(remaining[j])
      } else {
        ipc.attachTerminal(remaining[j])
      }
    }

    // FLIP animation: panes slide from old position to new position
    for (let j = 0; j < newCount; j++) {
      const el = paneRootRefs[j]
      if (el && oldRects[j]) {
        const nr = el.getBoundingClientRect()
        const dx = oldRects[j].left - nr.left
        const dy = oldRects[j].top - nr.top
        if (dx !== 0 || dy !== 0) {
          el.style.setProperty('transition', 'none', 'important')
          el.style.transform = `translate(${dx}px, ${dy}px)`
          el.style.willChange = 'transform'
          el.dataset.animating = '1'
        }
      }
    }
    // Force reflow then animate to identity
    void document.body.offsetHeight
    for (let j = 0; j < newCount; j++) {
      const el = paneRootRefs[j]
      if (el?.dataset.animating) {
        el.style.transition = 'transform 0.4s cubic-bezier(0.2, 0, 0, 1)'
        el.style.transform = 'translate(0, 0)'
        delete el.dataset.animating
      }
    }
    // Clean up transition style
    setTimeout(() => {
      for (let j = 0; j < newCount; j++) {
        const el = paneRootRefs[j]
        if (el) {
          el.style.transition = ''
          el.style.transform = ''
          el.style.willChange = ''
        }
      }
    }, 450)
  })
}
async function deleteSessionById(id) {
  if (!id) return
  for (let i = 0; i < panes.value.length; i++) {
    if (panes.value[i]?.sessionId === id) {
      panes.value[i].sessionId = null
      panes.value[i].term?.clear()
      sessions.setWorkbenchPane(i, null)
      unsubscribePane(i)
      break
    }
  }
  await sessions.deleteSession(id)
  message.success('会话已从 UCLI 移除，源会话和用量统计已保留')
}
async function deletePane(i) {
  const sid = panes.value[i]?.sessionId
  if (!sid) return
  await sessions.deleteSession(sid)
  panes.value[i].sessionId = null
  panes.value[i].term?.clear()
  sessions.setWorkbenchPane(i, null)
  unsubscribePane(i)
  message.success('会话已从 UCLI 移除，源会话和用量统计已保留')
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
const importDiscovered = ref({ claude: [], codex: [], opencode: [] })
const importSelection = ref({})
const importTier = ref('safety-rules')
const importing = ref(false)
const discoveringImport = ref(false)
const importError = ref('')

const importGroups = computed(() => {
  const groups = []
  for (const a of sessions.adapters) {
    groups.push({
      id: a.id, icon: a.icon, displayName: a.displayName,
      sessions: importDiscovered.value[a.id] || []
    })
  }
  return groups
})
const hasImportGroups = computed(() =>
  importGroups.value.some(g => g.sessions.length > 0)
)
const totalImportSelected = computed(() => {
  let n = 0
  for (const arr of Object.values(importSelection.value)) n += (arr || []).length
  return n
})

let _importDebounce = null
function onImportCwdChange() {
  if (_importDebounce) clearTimeout(_importDebounce)
  _importDebounce = setTimeout(() => {
    if (importCwd.value) discoverImport(importCwd.value)
  }, 400)
}
async function pickImportDir() {
  const dir = await ipc.pickDirectory()
  if (dir) { importCwd.value = dir; await discoverImport(dir) }
}
async function discoverImport(dir) {
  discoveringImport.value = true
  importError.value = ''
  importDiscovered.value = { claude: [], codex: [], opencode: [] }
  importSelection.value = {}
  try {
    importDiscovered.value = await ipc.discoverSessions(dir)
  } catch (e) {
    importDiscovered.value = { claude: [], codex: [], opencode: [] }
    importError.value = e?.message || String(e)
  } finally {
    discoveringImport.value = false
  }
}
async function doImport() {
  if (!totalImportSelected.value || !importCwd.value) {
    message.warning('请选择目录和会话'); return
  }
  importing.value = true
  try {
    let count = 0
    for (const group of importGroups.value) {
      const ids = importSelection.value[group.id] || []
      for (const sid of ids) {
        const cs = group.sessions.find(s => s.sessionId === sid)
        const config = {
          adapterId: group.id,
          cwd: importCwd.value,
          tier: importTier.value,
          cliSessionId: sid,
          provider: cs?.resumeProvider || undefined,
          sourceProvider: cs?.sourceProvider || undefined
        }
        if (cs?.name) config.name = cs.name
        if (cs?.startedAt) config.startedAt = cs.startedAt
        if (cs?.model) config.model = cs.model
        await sessions.createSession(config)
        count++
      }
    }
    showImport.value = false
    importDiscovered.value = { claude: [], codex: [], opencode: [] }
    importSelection.value = {}
    message.success(`已导入 ${count} 个会话`)
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
  window.addEventListener('keydown', onWorkbenchKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  await sessions.init()
  await sessions.loadWorkbench()
  sessionListHidden.value = sessions.workbench.sessionListHidden // sync after load
  const savedIds = sessions.workbench.paneSessionIds
  const count = sessions.workbench.splitCount || 1
  createPanes(count)
  await nextTick()

  // If navigated from card click, put pending session in first empty pane
  if (sessions.pendingAssign) {
    focusSessionFromNotification(sessions.pendingAssign)
  }

  // Restore remaining saved pane assignments (skip deleted sessions)
  // Clear stale pane IDs that reference deleted sessions
  for (let i = 0; i < Math.min(count, savedIds.length); i++) {
    if (savedIds[i] && !sessions.byId(savedIds[i])) sessions.setWorkbenchPane(i, null)
  }
  for (let i = 0; i < Math.min(count, sessions.workbench.paneSessionIds.length); i++) {
    if (!panes.value[i].sessionId && savedIds[i] && sessions.byId(savedIds[i])) {
      activePane.value = i
      assignToPane(savedIds[i])
    } else if (savedIds[i] && !sessions.byId(savedIds[i])) {
      sessions.setWorkbenchPane(i, null)
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWorkbenchKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
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
.item-name-wrap { display: inline-flex; align-items: center; gap: 2px; flex: 1; overflow: hidden; }
.item-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-name-edit-icon { font-size: 11px; color: #bfbfbf; cursor: pointer; flex-shrink: 0; opacity: 0; transition: opacity .12s; }
.item-name-wrap:hover .item-name-edit-icon { opacity: 1; }
.item-name-edit-icon:hover { color: #1677ff; }
.item-delete-btn { font-size: 11px; color: #bfbfbf; cursor: pointer; flex-shrink: 0; opacity: 0; transition: opacity .12s; margin-left: auto; }
.session-item:hover .item-delete-btn { opacity: 1; }
.item-delete-btn:hover { color: #ff4d4f; }
.item-name-input { width: auto; min-width: 80px; max-width: 160px; font-size: 12px; font-weight: 600; }
.item-path { font-size: 10px; color: #8c8c8c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.item-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 1px; }
.item-id { font-size: 10px; color: #bfbfbf; font-family: monospace; }
.item-time { font-size: 10px; color: #bfbfbf; }
.item-stats { font-size: 10px; color: #8c8c8c; }
.item-note { font-size: 10px; color: #faad14; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
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
.pane-grid { flex: 1; display: grid; gap: 6px; min-height: 0; position: relative; }
.pane-grid.split-1 { grid-template-columns: 1fr; grid-template-rows: 1fr; }
.pane-grid.split-2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
.pane-grid.split-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.pane-grid:fullscreen {
  width: 100vw; height: 100vh; padding: 6px; box-sizing: border-box;
  background: #0b1021;
}
.grid-fullscreen-exit {
  position: absolute; top: 8px; right: 12px; z-index: 10;
}

.pane {
  display: flex; flex-direction: column; min-height: 0;
  border-radius: 8px; overflow: hidden;
  border: 2px solid #d9d9d9;
}
.pane:fullscreen {
  width: 100vw; height: 100vh; border: 0; border-radius: 0;
  background: #0b1021;
}
.pane-active { border-color: #1677ff; }
.shortcut-hint { color: #8c8c8c; font-size: 12px; white-space: nowrap; }
.shortcut-hint kbd { padding: 1px 5px; border: 1px solid #d9d9d9; border-bottom-width: 2px; border-radius: 4px; background: #fff; color: #595959; font-family: inherit; }

.pane-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 3px 8px; background: #fafafa; border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0; min-height: 28px;
}
.pane-session { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px; }
.pane-session.empty { color: #bfbfbf; }
.pane-actions { opacity: 0; transition: opacity .15s; }
.pane-header:hover .pane-actions { opacity: 1; }

.pane-info {
  display: flex; gap: 10px; padding: 2px 8px; background: #fff; font-size: 11px;
  border-bottom: 1px solid #f0f0f0; flex-shrink: 0; color: #595959; flex-wrap: wrap;
}
.pi-item { white-space: nowrap; }
.pi-item.sid { font-family: monospace; color: #bfbfbf; font-size: 10px; }
.pane-terminal { flex: 1; min-height: 0; padding: 4px; background: #0b1021; }
.pane-terminal :deep(.xterm) { height: 100%; }

/* Import modal */
.section-label { font-weight: 600; font-size: 13px; margin-bottom: 8px; color: #262626; }
.import-cli-group { border: 1px solid #f0f0f0; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
.import-cli-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.import-cli-icon { font-size: 16px; }
.import-cli-name { font-weight: 600; font-size: 13px; }
.import-cli-count { font-size: 11px; color: #8c8c8c; }
.import-session-list { max-height: 180px; overflow-y: auto; margin-bottom: 4px; }
.import-session-row { padding: 3px 0; border-bottom: 1px solid #fafafa; }
.import-session-row :deep(.ant-checkbox-wrapper) { width: 100%; }
.iss-name { font-weight: 500; margin-right: 6px; font-size: 12px; }
.iss-meta { font-size: 10px; color: #8c8c8c; margin-right: 6px; }
.provider-change { color: #d46b08; }
.iss-preview { font-size: 11px; color: #595959; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; }
.import-none { color: #bfbfbf; font-size: 12px; padding: 4px 0; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
