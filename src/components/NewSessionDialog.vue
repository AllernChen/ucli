<template>
  <a-modal v-model:open="open" title="新建会话" :footer="null" width="640px" :destroyOnClose="true">
    <!-- Step 0: optional name -->
    <div class="new-section">
      <div class="section-title">会话名称</div>
      <a-input v-model:value="form.name" placeholder="会话名称（可选）" allow-clear />
    </div>

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
                  <span class="sess-item-meta" v-if="s.model">{{ s.model }}（历史模型）</span>
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
      <div v-if="discoverableAdapters.length" class="cli-quick-new">
        <span>快速新建：</span>
        <a-button v-for="a in discoverableAdapters" :key="a.id" size="small" type="primary" ghost @click="newSession(a)">
          {{ a.icon }} {{ a.displayName }}
        </a-button>
      </div>
    </div>

    <div v-for="adapterId in visibleProfileAdapterIds" :key="adapterId" class="new-section">
      <div class="section-title">{{ adapterName(adapterId) }} 配置档案</div>
      <div class="profile-choice-row">
        <span>新建 {{ adapterName(adapterId) }}</span>
        <a-select v-model:value="form.profileSelections[adapterId]" style="width: 280px" @change="clearModelSelection(adapterId, false)">
          <a-select-option value="inherit">按项目默认</a-select-option>
          <a-select-option :value="defaultProfile(adapterId, 'app') ? `profile:${defaultProfile(adapterId, 'app').id}` : 'app-unavailable'" :disabled="!defaultProfile(adapterId, 'app')">按应用默认</a-select-option>
          <a-select-option value="system">跟随当前</a-select-option>
          <a-select-opt-group label="服务档案（具体档案）">
            <a-select-option v-for="profile in serverProfilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!canSelectProfile(profile, adapterId)">
              {{ profileLabel(profile) }}{{ profile.canStart === false ? '（当前不可用）' : '' }}
            </a-select-option>
          </a-select-opt-group>
          <a-select-opt-group label="本地档案">
            <a-select-option v-for="profile in localProfilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!canSelectProfile(profile, adapterId)">
              {{ profileLabel(profile) }}{{ profile.canStart === false ? '（当前不可用）' : '' }}
            </a-select-option>
          </a-select-opt-group>
        </a-select>
      </div>
      <div v-if="selectedServiceProfile(adapterId, false)" class="profile-choice-row">
        <span>服务模型</span>
        <a-select v-model:value="form.modelSelections[adapterId]" style="width: 280px" placeholder="请选择兼容模型">
          <a-select-option v-for="model in compatibleModels(adapterId, false)" :key="model.id" :value="model.id" :disabled="model.availabilityStatus !== 'ready'">
            {{ model.displayName || model.id }}
          </a-select-option>
        </a-select>
      </div>
      <div class="profile-choice-row">
        <span>导入 {{ adapterName(adapterId) }}</span>
        <a-select v-model:value="importProfileSelections[adapterId]" style="width: 280px" @change="clearModelSelection(adapterId, true)">
          <a-select-option value="history">保持历史连接（保留历史选择）</a-select-option>
          <a-select-option value="system">跟随当前</a-select-option>
          <a-select-opt-group label="服务档案">
            <a-select-option v-for="profile in serverProfilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!canSelectProfile(profile, adapterId)">
              {{ profileLabel(profile) }}{{ profile.canStart === false ? '（当前不可用）' : '' }}
            </a-select-option>
          </a-select-opt-group>
          <a-select-opt-group label="本地档案">
            <a-select-option v-for="profile in localProfilesForAdapter(adapterId)" :key="profile.id" :value="`profile:${profile.id}`" :disabled="!canSelectProfile(profile, adapterId)">
              {{ profileLabel(profile) }}{{ profile.canStart === false ? '（当前不可用）' : '' }}
            </a-select-option>
          </a-select-opt-group>
        </a-select>
      </div>
      <div v-if="selectedServiceProfile(adapterId, true)" class="profile-choice-row">
        <span>服务模型</span>
        <a-select v-model:value="importModelSelections[adapterId]" style="width: 280px" placeholder="请选择兼容模型">
          <a-select-option v-for="model in compatibleModels(adapterId, true)" :key="model.id" :value="model.id" :disabled="model.availabilityStatus !== 'ready'">
            {{ model.displayName || model.id }}
          </a-select-option>
        </a-select>
      </div>
      <div class="profile-choice-help">项目默认：{{ defaultProfile(adapterId, 'project')?.name || '未设置' }}；应用默认：{{ defaultProfile(adapterId, 'app')?.name || '未设置' }}</div>
    </div>

    <div v-if="!initialAdapterId || initialAdapterId === 'deepseek-harness'" class="new-section dsh-create-options">
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
      <a-button @click="open = false">取消</a-button>
      <a-button type="primary" @click="importSelected" :loading="creating" :disabled="!totalSelected">
        导入选中会话 ({{ totalSelected }})
      </a-button>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { useSettingsStore } from '../stores/settings.js'
import { useAiCliProfilesStore } from '../stores/aiCliProfiles.js'
import { ipc } from '../ipc.js'
import { compatibleModelsForAdapter, validateServiceProfileSelection } from '../serviceProfileSelection.js'
import { importedSessionModelForSelection, isServiceProfile } from '../sessionConfigPresentation.js'

const props = defineProps({
  initialCwd: { type: String, default: '' },
  initialAdapterId: { type: String, default: '' }
})

const open = defineModel('open', { default: false })

const router = useRouter()
const route = useRoute()
const sessions = useSessionsStore()
const settings = useSettingsStore()
const aiProfiles = useAiCliProfilesStore()

const creating = ref(false)
const discovering = ref(false)
const discoverError = ref('')
const dshRuntime = ref({})
const dshLoadError = ref('')
const dshProfilesLoading = ref(false)
const dshMigrationOpen = ref(false)

const form = ref({
  adapterId: 'claude', cwd: '', name: '', model: undefined, tier: 'safety-rules',
  profileSelections: { codex: 'inherit', claude: 'inherit' },
  modelSelections: { codex: null, claude: null }
})
const discovered = ref({ claude: [], codex: [], opencode: [], ucode: [] })
const selectedSessions = ref({})
const importProfileSelections = ref({ codex: 'history', claude: 'history' })
const importModelSelections = ref({ codex: null, claude: null })

const hasAnySessions = computed(() =>
  discoverableAdapters.value.some((a) => (discovered.value[a.id] || []).length > 0)
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
const discoverableAdapters = computed(() => {
  const base = sessions.adapters.filter((a) => a.id !== 'deepseek-harness')
  return props.initialAdapterId
    ? base.filter((a) => a.id === props.initialAdapterId)
    : base
})
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
const profilesForAdapter = (adapterId) => aiProfiles.profiles.filter((profile) =>
  profile.adapterId === adapterId || isServiceProfile(profile)
)
const localProfilesForAdapter = (adapterId) => profilesForAdapter(adapterId)
  .filter((profile) => !isServiceProfile(profile))
const serverProfilesForAdapter = (adapterId) => profilesForAdapter(adapterId).filter(isServiceProfile)
const profileCapableAdapter = (adapterId) => ['codex', 'claude'].includes(adapterId)
const profileAdapterIds = ['codex', 'claude']
const visibleProfileAdapterIds = computed(() =>
  props.initialAdapterId
    ? profileAdapterIds.filter((id) => id === props.initialAdapterId)
    : profileAdapterIds
)
const adapterName = (adapterId) => sessions.adapters.find((adapter) => adapter.id === adapterId)?.displayName || adapterId
const dshAdapter = computed(() => sessions.adapters.find(
  adapter => adapter.id === 'deepseek-harness'
) || null)
const defaultProfile = (adapterId, scope) => localProfilesForAdapter(adapterId)
  .find((profile) => scope === 'project' ? profile.isProjectDefault : profile.isAppDefault) || null

onMounted(async () => {
  await Promise.all([sessions.init(), settings.load(), loadDshRuntime()])
  form.value.adapterId = settings.defaultAdapter || 'claude'
  form.value.tier = settings.defaultTier || 'safety-rules'
  form.value.cwd = settings.defaultCwd || ''
  selectedSessions.value = {}
  if (route.query.createDshWeb === '1') {
    form.value.adapterId = 'deepseek-harness'
    form.value.cwd = dshMigrationCwd(route.query.cwd)
    await aiProfiles.load(form.value.cwd)
    await router.replace({ path: '/' })
    dshMigrationOpen.value = true
    open.value = true
    return
  }
  await aiProfiles.load(form.value.cwd)
  if (form.value.cwd) discover(form.value.cwd)
})

watch(open, (val) => {
  if (!val) return
  selectedSessions.value = {}
  form.value.profileSelections = { codex: 'inherit', claude: 'inherit' }
  form.value.modelSelections = { codex: null, claude: null }
  importProfileSelections.value = { codex: 'history', claude: 'history' }
  importModelSelections.value = { codex: null, claude: null }
  form.value.name = ''
  discovered.value = { claude: [], codex: [], opencode: [], ucode: [] }
  if (dshMigrationOpen.value) {
    dshMigrationOpen.value = false
  } else {
    form.value.cwd = props.initialCwd || settings.defaultCwd || ''
  }
  loadDshRuntime().catch(() => {})
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

function profileLabel(profile) {
  return isServiceProfile(profile) ? (profile.organization?.name || profile.id) : profile.name
}

function selectionValue(imported, adapterId) {
  const selection = imported
    ? importProfileSelections.value[adapterId]
    : form.value.profileSelections[adapterId]
  return typeof selection === 'string' ? selection : 'inherit'
}

function selectedServiceProfile(adapterId, imported) {
  const selection = selectionValue(imported, adapterId)
  if (!selection.startsWith('profile:')) return null
  const profile = aiProfiles.profileById(selection.slice('profile:'.length))
  return isServiceProfile(profile) ? profile : null
}

function compatibleModels(adapterId, imported) {
  return compatibleModelsForAdapter(selectedServiceProfile(adapterId, imported), adapterId)
}

function canSelectProfile(profile, adapterId) {
  return isServiceProfile(profile)
    ? profile.availabilityStatus === 'ready' && compatibleModelsForAdapter(profile, adapterId).length > 0
    : profile.canStart !== false
}

function clearModelSelection(adapterId, imported) {
  if (imported) importModelSelections.value[adapterId] = null
  else form.value.modelSelections[adapterId] = null
}

function selectedModelId(imported, adapterId) {
  return imported ? importModelSelections.value[adapterId] : form.value.modelSelections[adapterId]
}

function profileConfigForSelection(imported, adapterId) {
  const selection = selectionValue(imported, adapterId)
  if (selection === 'system') return { profileSelection: 'system' }
  if (typeof selection === 'string' && selection.startsWith('profile:')) {
    const profileId = selection.slice('profile:'.length)
    const profile = aiProfiles.profileById(profileId)
    if (isServiceProfile(profile)) {
      const modelId = selectedModelId(imported, adapterId)
      const validation = validateServiceProfileSelection({ profile, adapterId, modelId })
      return validation.valid ? { profileId, model: modelId } : { error: validation.reason }
    }
    return profile?.adapterId === adapterId ? { profileId, model: null } : {}
  }
  return {}
}

function profileSelectionError(config) {
  return ({
    'model-required': '请选择兼容模型',
    'model-unavailable': '所选模型当前不可用',
    'protocol-unavailable': '所选模型与当前 CLI 不兼容'
  })[config?.error] || null
}

function validateRequestedServiceModels(imported) {
  for (const adapterId of profileAdapterIds) {
    const error = profileSelectionError(profileConfigForSelection(imported, adapterId))
    if (error) return error
  }
  return null
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function importSelected() {
  if (!totalSelected.value || !form.value.cwd) { message.warning('请选择工作目录和会话'); return }
  const selectionError = validateRequestedServiceModels(true)
  if (selectionError) { message.warning(selectionError); return }
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
          const importedModel = importedSessionModelForSelection({
            selection: selectionValue(true, group.id),
            discoveredModel: cs?.model,
            explicitModel: profileConfig.model
          })
          if (importedModel !== undefined) config.model = importedModel
        }
        if (cs?.name) config.name = cs.name
        if (cs?.startedAt) config.startedAt = cs.startedAt
        lastId = await sessions.createSession(config)
        count++
      }
    }
    message.success(`已导入 ${count} 个会话`)
    if (count === 1 && lastId) openSession(lastId)
    open.value = false
  } catch (e) {
    message.error('导入失败：' + (e?.message || e))
  } finally {
    creating.value = false
  }
}

async function newSession(adapter) {
  if (!form.value.cwd) { message.warning('请先选择工作目录'); return }
  const selectionError = profileCapableAdapter(adapter.id)
    ? profileSelectionError(profileConfigForSelection(false, adapter.id))
    : null
  if (selectionError) { message.warning(selectionError); return }
  creating.value = true
  try {
    const config = {
      adapterId: adapter.id,
      cwd: form.value.cwd,
      tier: form.value.tier
    }
    const name = (form.value.name || '').trim()
    if (name) config.name = name
    if (profileCapableAdapter(adapter.id)) {
      form.value.adapterId = adapter.id
      const profileConfig = profileConfigForSelection(false, adapter.id)
      if (profileConfig.profileId) config.profileId = profileConfig.profileId
      if (profileConfig.profileSelection) config.profileSelection = profileConfig.profileSelection
      if (profileConfig.model !== undefined) config.model = profileConfig.model
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
    open.value = false
    openSession(sessionId)
  } catch (e) {
    message.error('创建失败：' + (e?.message || e))
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
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
