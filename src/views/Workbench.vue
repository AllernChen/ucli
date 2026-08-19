<template>
  <div class="workbench">
    <div class="toolbar">
      <a-button size="small" @click="openNew">
        <PlusOutlined /> 新建
      </a-button>
      <a-button size="small" :type="batchMode ? 'primary' : 'default'" @click="toggleBatchMode">多选</a-button>
      <a-select v-model:value="filterTier" size="small" style="width: 100px" allowClear placeholder="筛选">
        <a-select-option value="always-agree">一直同意</a-select-option>
        <a-select-option value="safety-rules">安全规则</a-select-option>
        <a-select-option value="ask-everything">逐次确认</a-select-option>
      </a-select>
      <span class="spacer"></span>
      <a-button v-if="filtered.length" size="small" type="text" @click="expandAll">全部展开</a-button>
      <a-button v-if="filtered.length" size="small" type="text" @click="collapseAll">全部收起</a-button>
      <span class="count">{{ groupedSessions.length }} 个项目 · {{ filtered.length }} 个会话</span>
      <a-button size="small" class="goto-btn" @click="$router.push('/session')" title="工作台">
        <AppstoreOutlined />
      </a-button>
    </div>

    <div v-if="batchMode" class="batch-bar">
      <a-space>
        <a-button size="small" @click="selectAllSessions">{{ allSelected ? '取消全选' : '全选' }}</a-button>
        <span class="batch-count">已选 {{ batchSelection.selected().size }} 个会话</span>
        <a-button size="small" danger :disabled="!batchSelection.hasSelection()" @click="confirmBatchDelete">批量删除</a-button>
        <a-button size="small" :disabled="!batchSelection.hasSelection()" @click="batchStop">批量停止</a-button>
        <a-button size="small" @click="exitBatchMode">退出多选</a-button>
      </a-space>
    </div>

    <div v-if="filtered.length" class="project-list">
      <section v-for="project in groupedSessions" :key="project.key" class="project-group">
        <button type="button" class="project-header" @click="toggleProject(project.key)">
          <DownOutlined v-if="!collapsedProjects.has(project.key)" />
          <RightOutlined v-else />
          <FolderOpenOutlined class="project-icon" />
          <span class="project-heading">
            <span class="project-name">{{ project.name }}</span>
            <span class="project-path" :title="project.path">{{ project.path || '未设置工作目录' }}</span>
          </span>
          <span class="group-count">{{ project.count }} 个会话</span>
        </button>

        <div v-show="!collapsedProjects.has(project.key)" class="project-content">
          <section v-for="cli in project.cliGroups" :key="cli.key" class="adapter-group">
            <button type="button" class="adapter-header" @click="toggleCli(cli.key)">
              <DownOutlined v-if="!collapsedClis.has(cli.key)" />
              <RightOutlined v-else />
              <span class="adapter-icon">{{ cli.icon }}</span>
              <span class="adapter-name">{{ cli.displayName }}</span>
              <span class="group-count">{{ cli.count }} 个会话</span>
            </button>
            <div v-show="!collapsedClis.has(cli.key)" class="card-grid">
              <SessionCard
                v-for="s in cli.sessions"
                :key="s.id"
                :session="s"
                :selectable="batchMode"
                :selected="batchSelection.selected().has(s.id)"
                @open="openSession"
                @configure="openSessionConfig"
                @action="handleSessionAction"
                @select="batchSelection.toggle"
              />
            </div>
          </section>
        </div>
      </section>
    </div>
    <a-empty v-else description="还没有会话，点击「新建会话」开始" style="margin-top: 60px" />

    <a-modal v-model:open="showNew" title="新建会话" :footer="null" width="640px" :destroyOnClose="true">
      <!-- Step 1: pick directory -->
      <div class="new-section">
        <div class="section-title">工作目录</div>
        <a-input-group compact>
          <a-input v-model:value="form.cwd" style="width: calc(100% - 80px)" placeholder="选择项目目录" @change="onCwdChange" />
          <a-button style="width: 80px" @click="pickDir">浏览</a-button>
        </a-input-group>
      </div>

      <!-- Step 2: discovered sessions, grouped by CLI -->
      <div v-if="hasAnySessions" class="new-section">
        <div class="section-title">发现的历史会话 — 选择导入或新建</div>

        <div v-for="group in cliGroups" :key="group.id" class="cli-group">
          <div class="cli-group-header">
            <span class="cli-icon">{{ group.icon }}</span>
            <span class="cli-name">{{ group.displayName }}</span>
            <span class="cli-count">{{ group.sessions.length }} 个历史会话</span>
          </div>

          <div v-if="group.sessions.length" class="session-list">
            <a-checkbox-group v-model:value="selectedSessions[group.id]" style="width:100%">
              <div v-for="s in group.sessions" :key="group.id + '/' + s.sessionId" class="session-row">
                <a-checkbox :value="s.sessionId" :disabled="s.imported">
                  <div>
                    <span class="sess-item-name">{{ s.name || s.sessionId?.slice(0, 12) }}</span>
                    <a-tag v-if="s.imported" color="default">已添加</a-tag>
                    <span class="sess-item-meta" v-if="s.model">{{ s.model }}</span>
                    <span class="sess-item-meta provider-change" v-if="s.providerChanged">provider: {{ s.sourceProvider }} → {{ s.resumeProvider }}</span>
                    <span class="sess-item-meta" v-else-if="s.sourceProvider">provider: {{ s.sourceProvider }}</span>
                    <span class="sess-item-meta" v-if="s.turns">{{ s.turns }} 轮</span>
                    <span class="sess-item-meta">{{ fmtTime(s.startedAt) }}</span>
                  </div>
                  <div class="sess-item-preview" v-if="s.lastMessage">{{ s.lastMessage }}</div>
                </a-checkbox>
              </div>
            </a-checkbox-group>
          </div>

          <div class="cli-group-actions">
            <a-button size="small" @click="newSession(group)">新建 {{ group.displayName }}</a-button>
          </div>
        </div>
      </div>

      <div v-else-if="form.cwd" class="new-section">
        <div v-if="discovering" class="discover-empty"><a-spin size="small" /> 正在查找历史会话…</div>
        <a-alert v-else-if="discoverError" type="error" show-icon :message="`历史会话读取失败：${discoverError}`" />
        <div v-else class="discover-empty">该目录下没有发现历史会话。</div>
        <div class="cli-quick-new">
          <span>快速新建：</span>
          <a-button v-for="a in discoverableAdapters" :key="a.id" size="small" type="primary" ghost @click="newSession(a)">
            {{ a.icon }} {{ a.displayName }}
          </a-button>
        </div>
      </div>

      <div v-for="adapterId in profileAdapterIds" :key="adapterId" class="new-section">
        <div class="section-title">{{ adapterName(adapterId) }} 配置档案</div>
        <div class="profile-choice-row">
          <span>新建 {{ adapterName(adapterId) }}</span>
          <a-select v-model:value="form.profileSelections[adapterId]" style="width: 280px">
            <a-select-option value="inherit">按项目默认</a-select-option>
            <a-select-option :value="defaultProfile(adapterId, 'app') ? `profile:${defaultProfile(adapterId, 'app').id}` : 'app-unavailable'" :disabled="!defaultProfile(adapterId, 'app')">按应用默认</a-select-option>
            <a-select-option value="system">跟随当前</a-select-option>
            <a-select-opt-group label="具体档案">
              <a-select-option v-for="profile in profilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!profile.canStart">
                {{ profile.name }}{{ profile.canStart ? '' : '（当前不可用）' }}
              </a-select-option>
            </a-select-opt-group>
          </a-select>
        </div>
        <div class="profile-choice-row">
          <span>导入 {{ adapterName(adapterId) }}</span>
          <a-select v-model:value="importProfileSelections[adapterId]" style="width: 280px">
            <a-select-option value="history">保持历史连接</a-select-option>
            <a-select-option value="system">跟随当前</a-select-option>
            <a-select-opt-group label="具体档案">
              <a-select-option v-for="profile in profilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!profile.canStart">
                {{ profile.name }}{{ profile.canStart ? '' : '（当前不可用）' }}
              </a-select-option>
            </a-select-opt-group>
          </a-select>
        </div>
        <div class="profile-choice-help">项目默认：{{ defaultProfile(adapterId, 'project')?.name || '未设置' }}；应用默认：{{ defaultProfile(adapterId, 'app')?.name || '未设置' }}</div>
      </div>

      <div class="new-section dsh-create-options">
        <div class="section-title">DeepSeek Harness 界面</div>
        <div class="profile-choice-help">
          本机 Web（DSH 原生控制）；权限、历史与统计均由 DSH 原生界面管理。
        </div>
        <a-alert v-if="dshLoadError" type="error" show-icon :message="dshLoadError" />
        <a-button
          type="primary"
          :disabled="!dshAdapter || !['managed', 'system'].includes(dshRuntime.selected)"
          :loading="creating || dshProfilesLoading"
          @click="newSession(dshAdapter)"
        >新建 DSH Web</a-button>
      </div>

      <!-- Tier selector (always visible) -->
      <div class="new-section">
        <div class="section-title">权限模式</div>
        <a-radio-group v-model:value="form.tier">
          <a-radio value="always-agree">一直同意</a-radio>
          <a-radio value="safety-rules">安全规则</a-radio>
          <a-radio value="ask-everything">逐次确认</a-radio>
        </a-radio-group>
      </div>
      <a-alert v-if="form.tier === 'always-agree'" type="warning" show-icon message="一直同意模式会自动放行所有操作（硬黑名单仍拦截）。" style="margin-bottom:12px" />

      <div class="modal-footer">
        <a-button @click="showNew = false">取消</a-button>
        <a-button type="primary" @click="importSelected" :loading="creating" :disabled="!totalSelected">
          导入选中会话 ({{ totalSelected }})
        </a-button>
      </div>
    </a-modal>

    <SessionConfigModal
      v-model:open="sessionConfig.open"
      :session-id="sessionConfig.sessionId"
    />

    <a-modal
      v-model:open="renameState.open"
      title="重命名会话"
      ok-text="确定"
      @ok="confirmRename"
    >
      <a-input v-model:value="renameState.name" placeholder="会话名称" @pressEnter="confirmRename" />
    </a-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import {
  PlusOutlined,
  AppstoreOutlined,
  DownOutlined,
  RightOutlined,
  FolderOpenOutlined
} from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { useSettingsStore } from '../stores/settings.js'
import { useGatewayStore } from '../stores/gateway.js'
import { useAiCliProfilesStore } from '../stores/aiCliProfiles.js'
import SessionCard from '../components/SessionCard.vue'
import SessionConfigModal from '../components/SessionConfigModal.vue'
import { groupSessionsByProject } from '../sessionGrouping.js'
import { deriveSessionMaintenanceState } from '../sessionMaintenancePresentation.js'
import { createBatchSelection } from '../sessionBatch.js'
import { ipc } from '../ipc.js'

const router = useRouter()
const route = useRoute()
const sessions = useSessionsStore()
const settings = useSettingsStore()
const gateway = useGatewayStore()
const aiProfiles = useAiCliProfilesStore()

const showNew = ref(false)
const creating = ref(false)
const discovering = ref(false)
const discoverError = ref('')
const filterTier = ref(undefined)
const sessionConfig = ref({ open: false, sessionId: '' })
const renameState = ref({ open: false, id: '', name: '' })
const dshRuntime = ref({})
const dshLoadError = ref('')
const dshProfilesLoading = ref(false)
const batchSelection = createBatchSelection()
const batchMode = ref(false)

const form = ref({
  adapterId: 'claude', cwd: '', model: undefined, tier: 'safety-rules',
  profileSelections: { codex: 'inherit', claude: 'inherit' }
})
const discovered = ref({ claude: [], codex: [], opencode: [], ucode: [] })
const selectedSessions = ref({})
const importProfileSelections = ref({ codex: 'history', claude: 'history' })

const filtered = computed(() =>
  filterTier.value ? sessions.sessions.filter((s) => s.tier === filterTier.value) : sessions.sessions
)
const groupedSessions = computed(() => groupSessionsByProject(filtered.value, sessions.adapters))
const collapsedProjects = ref(new Set())
const collapsedClis = ref(new Set())

const allSelected = computed(() =>
  batchSelection.isAllSelected(filtered.value.map((s) => s.id))
)

const hasAnySessions = computed(() =>
  Object.values(discovered.value).some((items) => items.length > 0)
)

const totalSelected = computed(() => {
  let n = 0
  for (const arr of Object.values(selectedSessions.value)) n += (arr || []).length
  return n
})

// DeepSeek Harness is not a discover/import adapter: its sessions live in the
// native DSH UI and it has a dedicated Web-only creation entry below. Exclude
// it from the generic quick-new and discover blocks so it is not presented as
// a second create button alongside that dedicated entry.
const discoverableAdapters = computed(() =>
  sessions.adapters.filter((a) => a.id !== 'deepseek-harness')
)
const cliGroups = computed(() => {
  const groups = []
  for (const a of discoverableAdapters.value) {
    groups.push({
      id: a.id,
      icon: a.icon,
      displayName: a.displayName,
      sessions: discovered.value[a.id] || []
    })
  }
  return groups
})
const profilesForAdapter = (adapterId) => aiProfiles.profiles.filter((profile) => profile.adapterId === adapterId)
const profileCapableAdapter = (adapterId) => ['codex', 'claude'].includes(adapterId)
const profileAdapterIds = ['codex', 'claude']
const adapterName = (adapterId) => sessions.adapters.find((adapter) => adapter.id === adapterId)?.displayName || adapterId
const dshAdapter = computed(() => sessions.adapters.find(
  adapter => adapter.id === 'deepseek-harness'
) || null)
const defaultProfile = (adapterId, scope) => profilesForAdapter(adapterId)
  .find((profile) => scope === 'project' ? profile.isProjectDefault : profile.isAppDefault) || null
onMounted(async () => {
  await Promise.all([sessions.init(), settings.load(), gateway.init(), loadDshRuntime()])
  form.value.adapterId = settings.defaultAdapter || 'claude'
  form.value.tier = settings.defaultTier || 'safety-rules'
  form.value.cwd = settings.defaultCwd || ''
  selectedSessions.value = {}
  if (route.query.createDshWeb === '1') {
    form.value.adapterId = 'deepseek-harness'
    form.value.cwd = dshMigrationCwd(route.query.cwd)
    await aiProfiles.load(form.value.cwd)
    await router.replace({ path: '/' })
    if (form.value.cwd) discover(form.value.cwd)
    showNew.value = true
    return
  }
  await aiProfiles.load(form.value.cwd)
  if (form.value.cwd) discover(form.value.cwd)
})

function dshMigrationCwd(value) {
  const candidate = Array.isArray(value) ? value[0] : value
  if (typeof candidate !== 'string') return ''
  return Array.from(candidate
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim()).slice(0, 4096).join('')
}

function openNew() {
  selectedSessions.value = {}
  form.value.profileSelections = { codex: 'inherit', claude: 'inherit' }
  importProfileSelections.value = { codex: 'history', claude: 'history' }
  discovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
  loadDshRuntime().catch(() => {})
  if (form.value.cwd) discover(form.value.cwd)
  showNew.value = true
}

async function loadDshRuntime() {
  dshProfilesLoading.value = true
  try {
    const state = await ipc.getDshState()
    dshRuntime.value = state || {}
    dshLoadError.value = ''
    return state
  } catch (error) {
    dshRuntime.value = {}
    dshLoadError.value = dshWorkbenchErrorLabel(error?.code)
    return null
  } finally {
    dshProfilesLoading.value = false
  }
}

function dshWorkbenchErrorLabel(code) {
  return ({
    DSH_NOT_INSTALLED: '未检测到 DeepSeek Harness，请前往档案管理检查',
    DSH_VERSION_UNREADABLE: '无法读取 DeepSeek Harness 版本，请前往档案管理检查',
    DSH_VERSION_UNSUPPORTED: 'DeepSeek Harness 版本不兼容，请前往档案管理检查'
  })[code] || 'DeepSeek Harness 状态不可用，请前往档案管理检查'
}

function openSession(id) {
  sessions.pendingAssign = id
  router.push('/session')
}

function toggleProject(key) {
  const next = new Set(collapsedProjects.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedProjects.value = next
}

function toggleCli(key) {
  const next = new Set(collapsedClis.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedClis.value = next
}

function expandAll() {
  collapsedProjects.value = new Set()
  collapsedClis.value = new Set()
}

function collapseAll() {
  collapsedProjects.value = new Set(groupedSessions.value.map((project) => project.key))
  collapsedClis.value = new Set(
    groupedSessions.value.flatMap((project) => project.cliGroups.map((cli) => cli.key))
  )
}

async function pickDir() {
  const dir = await ipc.pickDirectory()
  if (dir) { form.value.cwd = dir; await discover(dir) }
}

let _debounce = null
function onCwdChange() {
  if (_debounce) clearTimeout(_debounce)
  _debounce = setTimeout(() => {
    if (form.value.cwd) discover(form.value.cwd)
  }, 400)
}

async function discover(cwd) {
  if (!cwd) return
  discovering.value = true
  discoverError.value = ''
  discovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
  selectedSessions.value = {}
  try {
    const [sessionsFound] = await Promise.all([
      ipc.discoverSessions(cwd),
      aiProfiles.load(cwd)
    ])
    discovered.value = sessionsFound
  } catch (e) {
    discovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
    discoverError.value = e?.message || String(e)
  } finally {
    discovering.value = false
  }
}

function openSessionConfig(sessionId) {
  sessionConfig.value = { open: true, sessionId }
}

function handleSessionAction(id, key) {
  if (key === 'stop') stopSession(id)
  else if (key === 'restart') restartSession(id)
  else if (key === 'rename') renameSession(id)
  else if (key === 'delete') confirmDeleteSession(id)
}

function toggleBatchMode() {
  if (batchMode.value) batchSelection.clear()
  batchMode.value = !batchMode.value
}

function exitBatchMode() {
  batchSelection.clear()
  batchMode.value = false
}

function selectAllSessions() {
  if (allSelected.value) batchSelection.clear()
  else batchSelection.setAll(filtered.value.map((s) => s.id))
}

function confirmBatchDelete() {
  const ids = [...batchSelection.selected()]
  if (!ids.length) return
  Modal.confirm({
    title: `批量移除 ${ids.length} 个会话？`,
    content: '仅移除 UCLI 中的会话记录，原生 CLI 历史与用量统计会保留。',
    okText: '移除',
    okType: 'danger',
    onOk: async () => {
      let ok = 0
      for (const id of ids) {
        try {
          await sessions.deleteSession(id)
          ok++
        } catch (e) {
          message.error('移除失败：' + (e?.message || e))
        }
      }
      if (ok > 0) {
        message.success(ok < ids.length ? `已移除 ${ok} 个会话，${ids.length - ok} 个失败` : `已移除 ${ok} 个会话`)
      }
      exitBatchMode()
    }
  })
}

async function batchStop() {
  const ids = [...batchSelection.selected()]
  let ok = 0
  for (const id of ids) {
    const state = deriveSessionMaintenanceState(sessions.byId(id))
    if (!state.canStop) continue
    try {
      await sessions.stop(id)
      ok++
    } catch (e) {
      message.error('停止失败：' + (e?.message || e))
    }
  }
  if (ok > 0) message.success(`已停止 ${ok} 个会话`)
  exitBatchMode()
}

async function stopSession(id) {
  try {
    await sessions.stop(id)
    message.success('已停止会话')
  } catch (e) {
    message.error('停止失败：' + (e?.message || e))
  }
}

async function restartSession(id) {
  const state = deriveSessionMaintenanceState(sessions.byId(id))
  try {
    if (state.stopBeforeRestart) await sessions.stop(id)
    await sessions.restart(id)
    message.success('已重启会话')
  } catch (e) {
    message.error('重启失败：' + (e?.message || e))
  }
}

function renameSession(id) {
  const s = sessions.byId(id)
  renameState.value = { open: true, id, name: s?.displayName || '' }
}

async function confirmRename() {
  const { id, name } = renameState.value
  const trimmed = (name || '').trim()
  if (!trimmed) { message.warning('名称不能为空'); return }
  try {
    await sessions.updateName(id, trimmed)
    message.success('已重命名')
    renameState.value.open = false
  } catch (e) {
    message.error('重命名失败：' + (e?.message || e))
  }
}

function confirmDeleteSession(id) {
  Modal.confirm({
    title: '从 UCLI 移除该会话？',
    content: '仅移除 UCLI 中的会话记录，原生 CLI 历史与用量统计会保留。',
    okText: '移除',
    okType: 'danger',
    onOk: async () => {
      try {
        await sessions.deleteSession(id)
        message.success('会话已从 UCLI 移除')
      } catch (e) {
        message.error('移除失败：' + (e?.message || e))
      }
    }
  })
}

function profileConfigForSelection(imported, adapterId) {
  const selection = imported
    ? importProfileSelections.value[adapterId]
    : form.value.profileSelections[adapterId]
  if (selection === 'system') return { profileSelection: 'system' }
  if (typeof selection === 'string' && selection.startsWith('profile:')) {
    const profileId = selection.slice('profile:'.length)
    const profile = aiProfiles.profileById(profileId)
    return profile?.adapterId === adapterId ? { profileId } : {}
  }
  return {}
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function importSelected() {
  if (!totalSelected.value || !form.value.cwd) { message.warning('请选择工作目录和会话'); return }
  creating.value = true
  let lastId = null, count = 0
  try {
    for (const group of cliGroups.value) {
      const ids = selectedSessions.value[group.id] || []
      for (const sid of ids) {
        const cs = group.sessions.find(s => s.sessionId === sid)
        const config = {
          adapterId: group.id,
          cwd: form.value.cwd,
          tier: form.value.tier,
          cliSessionId: sid,
          model: cs?.model || undefined,
          provider: cs?.resumeProvider || undefined,
          sourceProvider: cs?.sourceProvider || undefined
        }
        if (profileCapableAdapter(group.id)) {
          const profileConfig = profileConfigForSelection(true, group.id)
          if (profileConfig.profileId) config.profileId = profileConfig.profileId
          if (profileConfig.profileSelection) config.profileSelection = profileConfig.profileSelection
        }
        if (cs?.name) config.name = cs.name
        if (cs?.startedAt) config.startedAt = cs.startedAt
        lastId = await sessions.createSession(config)
        count++
      }
    }
    message.success(`已导入 ${count} 个会话`)
    if (count === 1 && lastId) openSession(lastId)
    showNew.value = false
  } catch (e) {
    message.error('导入失败：' + (e?.message || e))
  } finally {
    creating.value = false
  }
}

async function newSession(adapter) {
  if (!form.value.cwd) { message.warning('请先选择工作目录'); return }
  creating.value = true
  try {
    const config = {
      adapterId: adapter.id,
      cwd: form.value.cwd,
      tier: form.value.tier
    }
    if (profileCapableAdapter(adapter.id)) {
      form.value.adapterId = adapter.id
      const profileConfig = profileConfigForSelection(false, adapter.id)
      if (profileConfig.profileId) config.profileId = profileConfig.profileId
      if (profileConfig.profileSelection) config.profileSelection = profileConfig.profileSelection
    }
    if (adapter.id === 'deepseek-harness') {
      form.value.adapterId = adapter.id
      const fresh = await loadDshRuntime()
      if (!['managed', 'system'].includes(fresh?.selected)) {
        message.warning('请先在档案管理中检查兼容的 DeepSeek Harness 运行时')
        return
      }
      config.adapterConfig = { surfacePreference: 'web' }
    }
    const sessionId = await sessions.createSession(config)
    message.success(`已创建 ${adapter.displayName} 会话`)
    showNew.value = false
    openSession(sessionId)
  } catch (e) {
    message.error('创建失败：' + (e?.message || e))
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.spacer { flex: 1; }
.count { color: #bfbfbf; font-size: 12px; }
.batch-bar { margin-bottom: 12px; padding: 8px 12px; background: #e6f4ff; border: 1px solid #91caff; border-radius: 8px; }
.batch-count { color: #0958d9; font-size: 12px; }
.goto-btn { color: #8c8c8c; }

.project-list { display: flex; flex-direction: column; gap: 12px; }
.project-group { overflow: hidden; background: #fff; border: 1px solid #e8e8e8; border-radius: 8px; }
.project-header, .adapter-header {
  width: 100%;
  border: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  text-align: left;
  color: #262626;
  font: inherit;
}
.project-header { gap: 8px; padding: 12px 14px; background: #fff; }
.project-header:hover { background: #fafafa; }
.project-icon { color: #d48806; font-size: 17px; }
.project-heading { min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.project-name { flex-shrink: 0; font-size: 14px; font-weight: 600; }
.project-path { overflow: hidden; color: #8c8c8c; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.group-count { margin-left: auto; color: #8c8c8c; font-size: 11px; white-space: nowrap; }
.project-content { padding: 0 12px 12px; }
.adapter-group { padding-top: 8px; border-top: 1px solid #f0f0f0; }
.adapter-group + .adapter-group { margin-top: 10px; }
.adapter-header { gap: 6px; padding: 0 2px 8px; background: transparent; }
.adapter-header:hover .adapter-name { color: #1677ff; }
.adapter-icon { font-size: 15px; }
.adapter-name { font-size: 12px; font-weight: 600; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }

.new-section { margin-bottom: 16px; }
.section-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; color: #262626; }

.cli-group { border: 1px solid #f0f0f0; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.cli-group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cli-icon { font-size: 18px; }
.cli-name { font-weight: 600; }
.cli-count { font-size: 12px; color: #8c8c8c; }

.session-list { margin-bottom: 8px; max-height: 200px; overflow-y: auto; }
.session-row { padding: 4px 0; border-bottom: 1px solid #fafafa; }
.session-row :deep(.ant-checkbox-wrapper) { width: 100%; }
.sess-item-name { font-weight: 500; margin-right: 8px; }
.sess-item-meta { font-size: 11px; color: #8c8c8c; margin-right: 8px; }
.provider-change { color: #d46b08; }
.profile-choice-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.profile-choice-help { color: #8c8c8c; font-size: 12px; }
.sess-item-preview { font-size: 11px; color: #595959; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; }

.cli-group-actions { display: flex; gap: 8px; }

.discover-empty { text-align: center; color: #bfbfbf; padding: 12px; font-size: 13px; }
.cli-quick-new { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.cli-quick-new span { font-size: 13px; color: #595959; }

.modal-footer { display: flex; justify-content: flex-end; margin-top: 8px; }
</style>
