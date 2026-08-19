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
      <GatewayHeaderControl />
      <a-space size="small">
        <a-button size="small" @click="showImport = true">📥 导入</a-button>
        <a-button size="small" @click="showNewSession = true">➕ 新建</a-button>
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
          <div class="sidebar-group-actions">
            <span>{{ groupedSessions.length }} 个项目 · {{ filteredSessions.length }} 个会话</span>
            <a-button size="small" type="link" @click="expandAllGroups">展开</a-button>
            <a-button size="small" type="link" @click="collapseAllGroups">收起</a-button>
          </div>
        </div>
        <div class="session-list">
          <section v-for="project in groupedSessions" :key="project.key" class="sidebar-project">
            <button type="button" class="sidebar-project-header" @click="toggleProjectGroup(project.key)">
              <DownOutlined v-if="!collapsedProjects.has(project.key)" />
              <RightOutlined v-else />
              <FolderOpenOutlined class="sidebar-project-icon" />
              <span class="sidebar-project-heading">
                <span class="sidebar-project-name">{{ project.name }}</span>
                <span class="sidebar-project-path" :title="project.path">{{ project.path || '未设置工作目录' }}</span>
              </span>
              <span class="sidebar-count">{{ project.count }}</span>
            </button>

            <div v-show="!collapsedProjects.has(project.key)" class="sidebar-project-content">
              <section v-for="cli in project.cliGroups" :key="cli.key" class="sidebar-cli">
                <button type="button" class="sidebar-cli-header" @click="toggleCliGroup(cli.key)">
                  <DownOutlined v-if="!collapsedClis.has(cli.key)" />
                  <RightOutlined v-else />
                  <span>{{ cli.icon }}</span>
                  <span class="sidebar-cli-name">{{ cli.displayName }}</span>
                  <span class="sidebar-count">{{ cli.count }}</span>
                </button>

                <div v-show="!collapsedClis.has(cli.key)">
                  <div
                    v-for="s in cli.sessions"
                    :key="s.id"
                    :class="['session-item', activePane !== null && panes[activePane]?.sessionId === s.id ? 'assigned' : '']"
                    @click="handleSessionClick(s.id, $event)"
                    @dblclick="openInNewPane(s.id)"
                  >
                    <div class="item-head">
                      <span class="item-name">{{ s.displayName || s.adapterId }}</span>
                      <a-badge :dot="sessionConfigNeedsAttention(s.id)" status="warning">
                        <a-button
                          type="text"
                          size="small"
                          aria-label="配置会话"
                          title="配置会话"
                          @click.stop="openSessionConfig(s.id)"
                        >
                          <SettingOutlined />
                        </a-button>
                      </a-badge>
                      <span :class="['status-dot', s.status]"></span>
                    </div>
                    <span
                      v-if="sessionCapabilityState(s).gateway"
                      :class="['session-relay-state', `tone-${relayView(s).tone}`]"
                      role="status"
                      :aria-label="`飞书转发：${relayView(s).label}`"
                    >
                      <GatewayChannelIcon :channel-type="gateway.configuration?.channelType || 'feishu'" />
                      {{ relayView(s).label }}
                    </span>
                    <div class="item-meta">
                      <span class="item-id">{{ s.id.slice(0,8) }}</span>
                      <span class="item-time">{{ fmtTime(s.createdAt || s.startedAt) }}</span>
                    </div>
                    <div class="item-stats" v-if="sessionCapabilityState(s).ucliStats && s.stats">
                      ↑{{ fmtNum(s.stats.tokens.input) }} ↓{{ fmtNum(s.stats.tokens.output) }}
                      <span v-if="s.stats.turns"> · {{ s.stats.turns }}轮</span>
                    </div>
                    <div class="item-note" v-if="s.taskNote" :title="s.taskNote">📝 {{ s.taskNote.slice(0,30) }}{{ s.taskNote.length > 30 ? '…' : '' }}</div>
                  </div>
                </div>
              </section>
            </div>
          </section>
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
            <a-space size="small">
              <a-button
                v-if="pane.sessionId"
                size="small"
                type="text"
                aria-label="在工作台定位"
                title="在工作台定位"
                @click.stop="locateSession(pane.sessionId)"
              >
                <AimOutlined />
              </a-button>
              <a-badge v-if="pane.sessionId && !isLegacyDshSession(paneSession(i))" :dot="sessionConfigNeedsAttention(pane.sessionId)" status="warning">
                <a-button
                  size="small"
                  type="text"
                  aria-label="配置会话"
                  title="配置会话"
                  @click.stop="openSessionConfig(pane.sessionId)"
                >
                  <SettingOutlined />
                </a-button>
              </a-badge>
              <a-button
                v-if="paneCapabilityState(i).ucliHistory"
                size="small"
                type="text"
                @click.stop="togglePaneHistory(i)"
                :title="pane.viewMode === 'history' ? '返回实时终端' : '查看完整历史记录'"
                :aria-label="pane.viewMode === 'history' ? '返回实时终端' : '查看完整历史记录'"
              >
                {{ pane.viewMode === 'history' ? '终端' : '历史' }}
              </a-button>
              <a-button
                v-if="pane.sessionId && !gridFullscreen"
                size="small"
                type="text"
                @click.stop="togglePaneFullscreen(i)"
                :title="fullscreenPane === i ? '退出全屏' : '全屏显示当前会话'"
                aria-label="切换会话全屏"
              >
                <FullscreenExitOutlined v-if="fullscreenPane === i" />
                <FullscreenOutlined v-else />
              </a-button>
              <SessionMaintenanceActions
                v-if="pane.sessionId && !isLegacyDshSession(paneSession(i))"
                :session-id="pane.sessionId"
                @removed="handleConfiguredSessionRemoved"
              />
              <a-button
                v-if="pane.sessionId"
                size="small"
                type="text"
                aria-label="关闭窗格"
                title="仅关闭窗格，会话继续运行"
                @click.stop="clearPane(i)"
              >关闭</a-button>
            </a-space>
          </div>
          <div
            v-if="isLegacyDshSession(paneSession(i))"
            class="legacy-dsh-migration"
            role="status"
          >
            <strong>旧版 DSH TUI 会话已停用</strong>
            <span>名称：{{ legacyDshSummary(paneSession(i)).name }}</span>
            <span>目录：{{ legacyDshSummary(paneSession(i)).cwd }}</span>
            <span>档案：{{ legacyDshSummary(paneSession(i)).profile }}</span>
            <a-button
              size="small"
              type="primary"
              :disabled="!legacyDshMigrationCwd(paneSession(i))"
              @click.stop="openLegacyDshWeb(paneSession(i))"
            >新建 DSH Web（同工作目录）</a-button>
          </div>
          <!-- Pane info bar -->
          <div v-if="paneCapabilityState(i).ucliStats" class="pane-info">
            <span
              v-if="sessions.byId(pane.sessionId)?.actualModel && sessions.byId(pane.sessionId)?.actualModel !== sessions.byId(pane.sessionId)?.model"
              class="pi-item provider-warning"
            >实际模型：{{ sessions.byId(pane.sessionId)?.actualModel }}</span>
            <span class="pi-item">🔹 {{ sessions.byId(pane.sessionId)?.model || '—' }}</span>
            <span class="pi-item">↑{{ fmtNum(sessions.byId(pane.sessionId)?.stats?.tokens?.input) }}</span>
            <span class="pi-item">↓{{ fmtNum(sessions.byId(pane.sessionId)?.stats?.tokens?.output) }}</span>
            <span class="pi-item" v-if="sessions.byId(pane.sessionId)?.stats?.costUsd">${{ sessions.byId(pane.sessionId).stats.costUsd.toFixed(4) }}</span>
            <span class="pi-item">{{ sessions.byId(pane.sessionId)?.stats?.turns || 0 }} 轮</span>
          </div>
          <!-- Terminal container -->
          <div
            v-if="paneCapabilityState(i).terminal"
            v-show="pane.viewMode !== 'history'"
            :ref="el => setPaneRef(i, el)"
            class="pane-terminal"
          ></div>
          <HostedWebSurface
            v-if="paneCapabilityState(i).web"
            :state="paneSession(i)?.surfaceState || { kind: 'web', status: 'starting', url: null, errorCode: null }"
            class="pane-web-surface"
          />
          <a-empty
            v-if="pane.sessionId && !paneCapabilityState(i).known && !isLegacyDshSession(paneSession(i))"
            description="该会话缺少可验证的界面能力，已安全停用交互"
          />
          <PaneHistory
            v-if="paneCapabilityState(i).ucliHistory"
            v-show="pane.viewMode === 'history'"
            :session-id="pane.sessionId || ''"
            :active="pane.viewMode === 'history'"
          />
        </div>
      </div>
    </div>

    <SessionConfigModal
      v-model:open="sessionConfig.open"
      :session-id="sessionConfig.sessionId"
    />

    <NewSessionDialog v-model:open="showNewSession" />

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
        <a-form-item v-for="adapterId in profileAdapterIds" :key="adapterId" :label="`${profileAdapterName(adapterId)} 配置档案`">
          <a-select v-model:value="importProfileSelections[adapterId]">
            <a-select-option value="history">保持历史连接</a-select-option>
            <a-select-option value="system">跟随当前</a-select-option>
            <a-select-option v-for="profile in profilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!profile.canStart">
              {{ profile.name }}{{ profile.canStart ? '' : '（不可用）' }}
            </a-select-option>
          </a-select>
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
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated
} from 'vue'
import { useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import {
  ArrowLeftOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  AimOutlined,
  DownOutlined,
  RightOutlined,
  FolderOpenOutlined
} from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { useSettingsStore } from '../stores/settings.js'
import { useGatewayStore } from '../stores/gateway.js'
import { useAiCliProfilesStore } from '../stores/aiCliProfiles.js'
import { matchesBinding } from '../keybindings.js'
import { ipc } from '../ipc.js'
import { groupSessionsByProject } from '../sessionGrouping.js'
import { nextSessionPaneIndex, targetPaneForSessionAddition } from '../workbenchKeyboard.js'
import { isClipboardCopyShortcut, isClipboardPasteShortcut, shouldBlockDuplicateClipboardPaste, shouldHandleTerminalPaste, shouldSendClipboardPaste } from '../terminalKeybindings.js'
import { shouldOpenTerminalLink } from '../terminalLinks.js'
import { compactPaneSessionIds } from '../paneCompaction.js'
import PaneHistory from '../components/PaneHistory.vue'
import HostedWebSurface from '../components/HostedWebSurface.vue'
import SessionConfigModal from '../components/SessionConfigModal.vue'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import SessionMaintenanceActions from '../components/SessionMaintenanceActions.vue'
import GatewayHeaderControl from '../components/gateway/GatewayHeaderControl.vue'
import GatewayChannelIcon from '../components/gateway/GatewayChannelIcon.vue'
import { deriveGatewayRelayControl } from '../gatewayRelayPresentation.js'
import { deriveSessionConfigState } from '../sessionConfigPresentation.js'
import { deriveSessionCapabilityState } from '../sessionMaintenancePresentation.js'
import { terminalSizeChanged } from '../terminalResize.js'
import {
  activatePaneSession,
  createPaneAssignmentGuard,
  reconcileSessionPanes,
  releaseChangedPaneTerminalBinding,
  restoreAssignedPaneSessions,
  resolveSessionFocusPane,
  resolveWorkbenchFullscreenTarget,
  toggleElementFullscreen
} from '../workbenchLayout.js'

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

defineOptions({ name: 'SessionDetail' })

const router = useRouter()
const sessions = useSessionsStore()
const settings = useSettingsStore()
const gateway = useGatewayStore()
const aiProfiles = useAiCliProfilesStore()

function sessionCapabilityState(session) {
  return deriveSessionCapabilityState(session || {})
}

function paneSession(i) {
  return sessions.byId(panes.value[i]?.sessionId) || null
}

function paneCapabilityState(i) {
  return sessionCapabilityState(paneSession(i))
}

function isLegacyDshSession(session) {
  return Boolean(
    session?.adapterId === 'deepseek-harness' &&
    session?.adapterConfig?.surfacePreference !== 'web' &&
    session?.capabilities?.surface !== 'web'
  )
}

function boundedLegacyDshText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim()
  return normalized
    ? Array.from(normalized).slice(0, maxLength).join('')
    : fallback
}

function legacyDshSummary(session) {
  return {
    name: boundedLegacyDshText(
      session?.displayName || session?.name,
      '未命名会话',
      80
    ),
    cwd: boundedLegacyDshText(session?.cwd, '未记录工作目录', 180),
    profile: boundedLegacyDshText(
      session?.adapterConfig?.profileName || session?.profileName,
      '旧版 TUI',
      80
    )
  }
}

function legacyDshMigrationCwd(session) {
  if (typeof session?.cwd !== 'string') return ''
  return Array.from(session.cwd
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim()).slice(0, 4096).join('')
}

function openLegacyDshWeb(session) {
  const cwd = legacyDshMigrationCwd(session)
  if (!isLegacyDshSession(session) || !cwd) return
  router.push({
    path: '/',
    query: { createDshWeb: '1', cwd }
  })
}

function locateSession(sessionId) {
  if (!sessionId) return
  router.push({ path: '/', query: { locate: sessionId } })
}

function relayView(session) {
  return deriveGatewayRelayControl({
    session: gateway.relaySessionFor(session.id),
    gatewayPhase: gateway.runtime.phase,
    pending: gateway.relayPendingFor(session.id)
  })
}

const sessionListHidden = ref(false)
watch(sessionListHidden, (v) => {
  sessions.setSessionListHidden(v)
  nextTick(() => syncAllPaneTerminalSizes())
})
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

// Each pane: { id, sessionId, viewMode, term, fitAddon, resizeObserver }
const panes = ref([])
const assignedPaneCount = computed(() => panes.value.filter((pane) => pane.sessionId).length)

const profileAdapterIds = ['codex', 'claude']
const profilesForAdapter = (adapterId) => aiProfiles.profiles.filter((profile) => profile.adapterId === adapterId)
const profileAdapterName = (adapterId) => sessions.adapters.find((adapter) => adapter.id === adapterId)?.displayName || adapterId

const sessionConfig = ref({ open: false, sessionId: '' })

function sessionConfigView(sessionId) {
  return deriveSessionConfigState(sessions.byId(sessionId) || {})
}

function sessionConfigNeedsAttention(sessionId) {
  return sessionConfigView(sessionId).needsAttention
}

function openSessionConfig(sessionId) {
  sessionConfig.value = { open: true, sessionId }
}

function handleConfiguredSessionRemoved(sessionId) {
  const paneIndex = panes.value.findIndex((pane) => pane.sessionId === sessionId)
  if (paneIndex >= 0) compactPanes(paneIndex)
}
// Refs storage for pane terminal containers
const paneRefs = {}
const paneRootRefs = {}
const paneAssignmentGuard = createPaneAssignmentGuard()
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
const groupedSessions = computed(() => groupSessionsByProject(filteredSessions.value, sessions.adapters))
const collapsedProjects = ref(new Set())
const collapsedClis = ref(new Set())

function toggleProjectGroup(key) {
  const next = new Set(collapsedProjects.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedProjects.value = next
}

function toggleCliGroup(key) {
  const next = new Set(collapsedClis.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedClis.value = next
}

function expandAllGroups() {
  collapsedProjects.value = new Set()
  collapsedClis.value = new Set()
}

function collapseAllGroups() {
  collapsedProjects.value = new Set(groupedSessions.value.map((project) => project.key))
  collapsedClis.value = new Set(
    groupedSessions.value.flatMap((project) => project.cliGroups.map((cli) => cli.key))
  )
}

function fmtNum(n) { return n ? n.toLocaleString() : '0' }

// --- Pane management ---
function createPanes(count) {
  const currentPanes = panes.value
  const previousSessionIds = currentPanes.map((pane) => pane?.sessionId || null)
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
  for (const pane of panes.value) {
    if (!pane.viewMode) pane.viewMode = 'terminal'
  }
  if (activePane.value >= count) activePane.value = count - 1
  // Initialize only new panes. ResizeObserver refits retained terminals after
  // the grid changes size.
  nextTick(async () => {
    const assignedPanes = []
    for (let i = 0; i < count; i++) {
      const sessionId = panes.value[i]?.sessionId
      const capabilities = paneCapabilityState(i)
      if (!capabilities.terminal) {
        destroyPaneTerminal(i)
        unsubscribePane(i)
      }
      const needsInit = capabilities.terminal && !panes.value[i]?.term
      if (needsInit) initPaneTerminal(i)
      const sessionChanged = previousSessionIds[i] !== sessionId
      if ((needsInit || sessionChanged) && sessionId) {
        if (sessionChanged) {
          unsubscribePane(i)
          panes.value[i]?.term?.clear()
        }
        if (capabilities.terminal && !unsubs[i]) subscribePaneTerminal(i, sessionId)
        assignedPanes.push({ paneIndex: i, sessionId })
      } else {
        syncPaneTerminalSize(i)
      }
    }
    await restoreAssignedPaneSessions(assignedPanes, {
      getSession: (sessionId) => sessions.byId(sessionId),
      restartSession: async (sessionId, paneIndex) => {
        await sessions.restart(sessionId)
        if (panes.value[paneIndex]) panes.value[paneIndex].lastPtySize = null
        await nextTick()
        syncPaneTerminalSize(paneIndex)
      },
      startSession: async (sessionId, paneIndex) => {
        await ipc.startAdapter(sessionId)
        if (panes.value[paneIndex]) panes.value[paneIndex].lastPtySize = null
        await nextTick()
        syncPaneTerminalSize(paneIndex)
      },
      attachSession: async (sessionId, paneIndex) => {
        await ipc.attachTerminal(sessionId)
        await nextTick()
        syncPaneTerminalSize(paneIndex)
      },
      onError: (error) => message.error('恢复失败：' + (error?.message || error))
    })
  })
}

watch(splitCount, (n) => createPanes(n))

function initPaneTerminal(i) {
  const capabilities = paneCapabilityState(i)
  if (!capabilities.terminal) {
    destroyPaneTerminal(i)
    return
  }
  const el = paneRefs[i]
  if (!el || panes.value[i]?.term) return
  const term = new Terminal({
    cursorBlink: true,
    disableStdin: false,
    fontSize: 13,
    fontFamily: "Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
    allowProposedApi: true,
    scrollback: 5000,
    theme: { background: '#0b1021', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' }
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(el)

  // Clickable HTTP(S) links open in the default browser after main-process validation.
  const webLinksAddon = new WebLinksAddon((e, uri) => {
    if (shouldOpenTerminalLink(e)) ipc.openExternal(uri)
  })
  term.loadAddon(webLinksAddon)

  // Custom key handler for copy/paste and pane switching
  term.attachCustomKeyEventHandler((e) => {
    if (shouldBlockDuplicateClipboardPaste(e)) return false
    if (e.type !== 'keydown') return true
    const overrides = settings.keybindings || {}

    // Pane switching via configurable bindings
    if (matchesBinding('pane.switchNext', e, overrides) || matchesBinding('pane.switchPrev', e, overrides)) {
      const direction = matchesBinding('pane.switchNext', e, overrides) ? 1 : -1
      const switched = switchSessionPane(direction)
      if (switched) {
        e.preventDefault()
        e.stopPropagation()
      }
      return !switched
    }

    // Copy via configurable bindings
    if (matchesBinding('terminal.copy', e, overrides) || matchesBinding('terminal.copyAlt', e, overrides)) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}) }
      return false
    }

    // Mac Cmd+C copy
    if (isClipboardCopyShortcut(e)) {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
      return false
    }

    // Ctrl+C: copy selection if any, else pass to terminal
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection()
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); return false }
      return true
    }

    // Paste via configurable binding
    if (shouldHandleTerminalPaste(e, matchesBinding('terminal.paste', e, overrides))) {
      // xterm 6.x binds a native `paste` listener (handlePasteEvent) that fires for the
      // browser's default Ctrl/Cmd+V action even after this handler returns false — the
      // key handler only exits early, it does not call preventDefault. Suppress that
      // native paste so the clipboard is forwarded exactly once (below, via sendToPane).
      if (shouldSendClipboardPaste(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
      navigator.clipboard.readText().then(t => { if (t) sendToPane(i, t) }).catch(() => {})
      return false
    }

    return true
  })

  // Forward input to PTY
  term.onData((data) => {
    const sid = panes.value[i]?.sessionId
    if (sid && paneCapabilityState(i).terminal) window.ucli.sendTerminalInput(sid, data)
  })

  panes.value[i].term = term
  panes.value[i].fitAddon = fitAddon
  panes.value[i].lastPtySize = null

  const terminalResizeDisposable = term.onResize((size) => {
    sendPaneTerminalSize(i, size)
  })

  // ResizeObserver refits the local xterm. The xterm resize event above is
  // the single path that forwards changed dimensions to the PTY.
  const resizeObserver = new ResizeObserver(() => {
    if (panes.value[i]?.viewMode === 'history') return
    try { fitAddon.fit() } catch {}
  })
  resizeObserver.observe(el)

  panes.value[i].resizeObserver = resizeObserver
  panes.value[i].terminalResizeDisposable = terminalResizeDisposable
  panes.value[i].webLinksAddon = webLinksAddon
  syncPaneTerminalSize(i)
}

function destroyPaneTerminal(i) {
  const p = panes.value[i]
  p?.webLinksAddon?.dispose()
  p?.terminalResizeDisposable?.dispose()
  p?.resizeObserver?.disconnect()
  if (p?.term) {
    p.term.dispose()
    p.term = null
    p.fitAddon = null
    p.resizeObserver = null
    p.terminalResizeDisposable = null
    p.webLinksAddon = null
    p.lastPtySize = null
  }
}

function sendPaneTerminalSize(i, nextSize) {
  const pane = panes.value[i]
  const sessionId = pane?.sessionId
  if (!pane || !sessionId || !paneCapabilityState(i).terminal || !terminalSizeChanged(pane.lastPtySize, nextSize)) return false
  pane.lastPtySize = { cols: nextSize.cols, rows: nextSize.rows }
  ipc.terminalResize(sessionId, nextSize.cols, nextSize.rows).catch(() => {})
  return true
}

function syncPaneTerminalSize(i) {
  const pane = panes.value[i]
  if (!pane?.term || !pane.fitAddon || pane.viewMode === 'history') return false
  try { pane.fitAddon.fit() } catch { return false }
  return sendPaneTerminalSize(i, { cols: pane.term.cols, rows: pane.term.rows })
}

function syncAllPaneTerminalSizes() {
  for (let i = 0; i < panes.value.length; i++) syncPaneTerminalSize(i)
}

function sendToPane(i, data) {
  const sid = panes.value[i]?.sessionId
  if (sid && paneCapabilityState(i).terminal) window.ucli.sendTerminalInput(sid, data)
}

function activatePane(i) {
  activePane.value = i
  if (paneCapabilityState(i).terminal && panes.value[i]?.viewMode !== 'history') {
    nextTick(() => panes.value[i]?.term?.focus())
  }
}

function togglePaneHistory(i) {
  const pane = panes.value[i]
  if (!pane?.sessionId || !paneCapabilityState(i).ucliHistory) return
  pane.viewMode = pane.viewMode === 'history' ? 'terminal' : 'history'
  activePane.value = i
  if (pane.viewMode === 'terminal') {
    nextTick(() => {
      syncPaneTerminalSize(i)
      pane.term?.focus()
    })
  }
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
    if (target.grid || !document.fullscreenElement) syncAllPaneTerminalSizes()
    else syncPaneTerminalSize(fullscreenPane.value ?? activePane.value)
    const i = fullscreenPane.value ?? activePane.value
    if (panes.value[i]?.viewMode !== 'history') panes.value[i]?.term?.focus()
  })
}

function switchSessionPane(direction = 1) {
  const next = nextSessionPaneIndex(panes.value, activePane.value, direction)
  if (next === null) return false
  activatePane(next)
  return true
}

function onWorkbenchKeydown(event) {
  if (event.type !== 'keydown' || event.defaultPrevented) return
  const overrides = settings.keybindings || {}
  let direction = null
  if (matchesBinding('pane.switchNext', event, overrides)) direction = 1
  else if (matchesBinding('pane.switchPrev', event, overrides)) direction = -1
  if (direction === null) return
  const target = event.target
  if (target instanceof Element && !target.closest('.xterm') && target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"], .ant-select')) return
  if (switchSessionPane(direction)) {
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
      paneAssignmentGuard.invalidate(i)
      panes.value[i].sessionId = null
      panes.value[i].viewMode = 'terminal'
      panes.value[i].lastPtySize = null
      panes.value[i].term?.clear()
      destroyPaneTerminal(i)
      sessions.setWorkbenchPane(i, null)
      unsubscribePane(i)
    }
  }
  const oldSid = panes.value[activePane.value].sessionId
  releaseChangedPaneTerminalBinding(oldSid, sessionId, {
    clearTerminal: () => panes.value[activePane.value]?.term?.clear(),
    unsubscribe: () => unsubscribePane(activePane.value)
  })
  panes.value[activePane.value].sessionId = sessionId
  panes.value[activePane.value].viewMode = 'terminal'
  panes.value[activePane.value].lastPtySize = null
  sessions.setWorkbenchPane(activePane.value, sessionId)
  const paneIndex = activePane.value
  const assignment = paneAssignmentGuard.begin(paneIndex, sessionId)
  const s = sessions.byId(sessionId)
  const capabilities = sessionCapabilityState(s)
  if (!capabilities.terminal) {
    destroyPaneTerminal(paneIndex)
    unsubscribePane(paneIndex)
  }
  nextTick(async () => {
    try {
      if (!paneAssignmentGuard.isCurrent(assignment, panes.value)) return
      if (capabilities.terminal) {
        initPaneTerminal(paneIndex)
        if (!unsubs[paneIndex]) subscribePaneTerminal(paneIndex, sessionId)
      }
      if (!paneAssignmentGuard.isCurrent(assignment, panes.value)) return
      await activatePaneSession(s, paneIndex, {
        restartSession: (id) => sessions.restart(id),
        startSession: (id) => ipc.startAdapter(id),
        attachSession: (id) => ipc.attachTerminal(id)
      })
      if (!paneAssignmentGuard.isCurrent(assignment, panes.value)) return
      if (panes.value[paneIndex]) panes.value[paneIndex].lastPtySize = null
      syncPaneTerminalSize(paneIndex)
      if (capabilities.terminal) panes.value[paneIndex]?.term?.focus()
    } catch (error) {
      if (paneAssignmentGuard.isCurrent(assignment, panes.value)) {
        message.error('会话启动失败：' + (error?.message || error))
      }
    }
  })
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

function handleSessionClick(sessionId, event) {
  const overrides = settings.keybindings || {}
  if (matchesBinding('session.addPane', event, overrides)) {
    addPaneForSession(sessionId)
  } else {
    assignToPane(sessionId)
  }
}

async function addPaneForSession(sessionId) {
  let target = targetPaneForSessionAddition(panes.value, splitCount.value)
  // Expand the layout only when no empty pane is available.
  if (target.paneIndex < 0 && target.splitCount !== splitCount.value) {
    splitCount.value = target.splitCount
    await nextTick()
    target = targetPaneForSessionAddition(panes.value, splitCount.value)
  }
  if (target.paneIndex < 0) return
  activePane.value = target.paneIndex
  assignToPane(sessionId)
}

function clearPane(i) {
  if (!panes.value[i]?.sessionId) return
  compactPanes(i)
}
function compactPanes(omitIndex) {
  const next = compactPaneSessionIds(panes.value.map((pane) => pane.sessionId), omitIndex)
  for (let i = 0; i < panes.value.length; i++) {
    paneAssignmentGuard.invalidate(i)
    unsubscribePane(i)
    destroyPaneTerminal(i)
  }
  sessions.workbench.splitCount = next.splitCount
  sessions.workbench.paneSessionIds = [...next.paneSessionIds]
  sessions.workbench.activePane = 0
  sessions.saveWorkbench()
  panes.value = next.paneSessionIds.map((sessionId, index) => ({
    id: `pane-${index}`,
    sessionId,
    viewMode: 'terminal'
  }))
  nextTick(() => createPanes(next.splitCount))
}

// New session dialog (opened in place)
const showNewSession = ref(false)

// Import historical sessions
const showImport = ref(false)
const importCwd = ref('')
const importDiscovered = ref({ claude: [], codex: [], opencode: [], ucode: [] })
const importSelection = ref({})
const importTier = ref('safety-rules')
const importProfileSelections = ref({ codex: 'history', claude: 'history' })
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
  importDiscovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
  importSelection.value = {}
  try {
    const [found] = await Promise.all([ipc.discoverSessions(dir), aiProfiles.load(dir)])
    importDiscovered.value = found
  } catch (e) {
    importDiscovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
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
        if (['codex', 'claude'].includes(group.id)) {
          const profileSelection = importProfileSelections.value[group.id]
          if (profileSelection === 'system') config.profileSelection = 'system'
          else if (profileSelection.startsWith('profile:')) {
            const profileId = profileSelection.slice('profile:'.length)
            if (aiProfiles.profileById(profileId)?.adapterId === group.id) config.profileId = profileId
          }
        }
        if (cs?.name) config.name = cs.name
        if (cs?.startedAt) config.startedAt = cs.startedAt
        if (cs?.model) config.model = cs.model
        await sessions.createSession(config)
        count++
      }
    }
    showImport.value = false
    importDiscovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
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
  const session = sessions.byId(sessionId)
  if (!deriveSessionCapabilityState(session || {}).terminal) return
  unsubs[i] = ipc.on('session:terminal-output', (evt) => {
    if (panes.value[i]?.sessionId === sessionId && evt.sessionId === sessionId && panes.value[i]?.term) {
      panes.value[i].term.write(evt.data)
    }
  })
}

function unsubscribePane(i) {
  if (unsubs[i]) { unsubs[i](); unsubs[i] = null }
}

// --- Lifecycle ---
function activateWorkbench() {
  window.addEventListener('keydown', onWorkbenchKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  nextTick(() => {
    syncAllPaneTerminalSizes()
    if (panes.value[activePane.value]?.viewMode !== 'history') {
      panes.value[activePane.value]?.term?.focus()
    }
  })
}

function deactivateWorkbench() {
  window.removeEventListener('keydown', onWorkbenchKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
}

onActivated(activateWorkbench)
onDeactivated(deactivateWorkbench)

onMounted(async () => {
  await Promise.all([sessions.init(), settings.load(), gateway.init(), aiProfiles.load()])
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
  deactivateWorkbench()
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
  width: 268px; flex-shrink: 0; display: flex; flex-direction: column;
  background: #fff; border: 1px solid #f0f0f0; border-radius: 8px; overflow: hidden;
}
.sidebar-toolbar { padding: 8px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid #f0f0f0; }
.session-list { flex: 1; overflow-y: auto; padding: 4px; }
.sidebar-group-actions { min-height: 22px; display: flex; align-items: center; color: #8c8c8c; font-size: 10px; }
.sidebar-group-actions :deep(.ant-btn) { height: 22px; padding: 0 3px; font-size: 11px; }
.sidebar-group-actions :deep(.ant-btn:first-of-type) { margin-left: auto; }
.sidebar-project + .sidebar-project { border-top: 1px solid #f0f0f0; }
.sidebar-project-header, .sidebar-cli-header {
  width: 100%; border: 0; cursor: pointer; display: flex; align-items: center; text-align: left; font: inherit;
}
.sidebar-project-header { gap: 5px; padding: 8px 6px; background: #fff; }
.sidebar-project-header:hover { background: #fafafa; }
.sidebar-project-icon { color: #d48806; flex-shrink: 0; }
.sidebar-project-heading { min-width: 0; display: flex; flex: 1; flex-direction: column; }
.sidebar-project-name { overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-project-path { overflow: hidden; color: #8c8c8c; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-project-content { padding-left: 8px; }
.sidebar-cli { border-left: 1px solid #f0f0f0; }
.sidebar-cli-header { gap: 5px; padding: 5px 7px; background: #fafafa; color: #595959; }
.sidebar-cli-header:hover .sidebar-cli-name { color: #1677ff; }
.sidebar-cli-name { overflow: hidden; flex: 1; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-count { margin-left: auto; color: #bfbfbf; font-size: 10px; }
.session-item {
  padding: 7px 8px 7px 19px; cursor: pointer; border-radius: 6px; margin-bottom: 2px;
  transition: background .12s; border: 1px solid transparent;
}
.session-item:hover { background: #f5f5f5; }
.session-item.assigned { background: #e6f4ff; border-color: #1677ff; }
.item-head { display: flex; align-items: center; gap: 4px; }
.item-name { flex: 1; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-relay-state { display: inline-flex; align-items: center; gap: 3px; margin-top: 2px; font-size: 10px; color: #8c8c8c; }
.session-relay-state.tone-blue { color: #1677ff; }
.session-relay-state.tone-green { color: #389e0d; }
.session-relay-state.tone-orange { color: #d46b08; }
.session-relay-state.tone-red { color: #cf1322; }
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
.legacy-dsh-migration {
  display: flex; flex-direction: column; align-items: flex-start; gap: 7px;
  margin: auto; max-width: min(520px, calc(100% - 32px)); padding: 18px;
  border: 1px solid #ffe58f; border-radius: 8px; background: #fffbe6;
  color: #595959; overflow-wrap: anywhere;
}
.legacy-dsh-migration strong { color: #ad6800; }

.pane-info {
  display: flex; gap: 10px; padding: 2px 8px; background: #fff; font-size: 11px;
  border-bottom: 1px solid #f0f0f0; flex-shrink: 0; color: #595959; flex-wrap: wrap;
}
.pi-item { white-space: nowrap; }
.pi-item.sid { font-family: monospace; color: #bfbfbf; font-size: 10px; }
.pane-terminal { flex: 1; min-height: 0; padding: 4px; background: #0b1021; }
.pane-terminal :deep(.xterm) { height: 100%; }
.pane-web-surface { flex: 1; min-height: 0; }

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
