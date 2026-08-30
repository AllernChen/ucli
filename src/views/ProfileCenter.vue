<template>
  <div class="profile-center">
    <div class="profile-page-heading">
      <div>
        <h2>配置档案</h2>
        <p>为不同项目和会话选择独立的 AI CLI 配置。UCLI 不接管全局登录状态。</p>
      </div>
      <a-button :loading="pageLoading" @click="reload">重新读取</a-button>
    </div>

    <div class="profile-cli-grid">
      <button
        v-for="cli in cliEntries"
        :key="cli.id"
        type="button"
        :class="['profile-cli-card', { active: selectedCli === cli.id }]"
        @click="selectCli(cli.id)"
      >
        <span class="profile-cli-name">{{ cli.name }}</span>
        <a-tag :color="cli.installed ? 'green' : 'default'">{{ cli.installed ? '已安装' : '未检测到' }}</a-tag>
        <span class="profile-cli-version">{{ cli.version || '版本未知' }}</span>
        <span>{{ cliProfileSupportLabel(cli.id) }}</span>
      </button>
    </div>

    <template v-if="selectedCli === 'deepseek-harness'">
      <a-card class="profile-runtime-card dsh-profile-management" :bordered="false">
        <div class="profile-runtime-row">
          <div>
            <strong>DeepSeek Harness 运行时</strong>
            <p>{{ dshRuntimeView.label }}</p>
            <span>受支持版本：{{ dshRuntimeView.supportedVersion || '未知' }}</span>
          </div>
          <a-space>
            <a-button
              v-if="dshRuntimeView.action"
              :danger="dshRuntimeView.action.danger"
              :loading="dshAction === dshRuntimeView.action.method"
              :disabled="Boolean(dshAction)"
              @click="confirmDshRuntimeAction(dshRuntimeView.action)"
            >{{ dshRuntimeView.action.label }}</a-button>
            <a-button :loading="dshLoading" @click="loadDshProfiles">刷新状态</a-button>
          </a-space>
        </div>
        <a-descriptions size="small" :column="1" bordered class="dsh-runtime-sources">
          <a-descriptions-item v-for="row in dshRuntimeView.rows" :key="row.source" :label="row.label">
            <a-tag :color="row.selected ? 'green' : 'default'">{{ row.selected ? '当前选用' : '未选用' }}</a-tag>
            {{ runtimeRowLabel(row) }}
          </a-descriptions-item>
        </a-descriptions>
        <a-alert type="info" show-icon message="Web 会话不需要 profile" description="profile 只用于 DSH 原生配置；初始化仅创建官方基础结构。" />
        <div class="dsh-profile-create-row">
          <a-input
            v-model:value="newDshProfileName"
            :maxlength="128"
            placeholder="输入新 profile 名"
            @press-enter="initializeDshProfile"
          />
          <a-button
            type="primary"
            :loading="dshAction === 'initialize'"
            :disabled="!canInitializeDshProfile"
            @click="initializeDshProfile"
          >初始化基础 profile</a-button>
        </div>
      </a-card>

      <a-spin :spinning="dshLoading">
        <div v-if="dshProfiles.length" class="profile-card-grid">
          <a-card v-for="profile in dshProfiles" :key="profile.profileName" class="profile-card">
            <template #title>
              <div class="profile-card-title">
                <span>{{ profile.profileName }}</span>
                <a-tag :color="profile.profileReady ? 'green' : 'red'">
                  {{ profile.profileReady ? '结构有效' : '结构无效' }}
                </a-tag>
              </div>
            </template>
            <div class="profile-card-body">
              <div class="profile-kind">DSH 原生 profile</div>
              <div><span>类型</span><strong>{{ dshProfileSurfaceLabel(profile.surface) }}</strong></div>
              <div><span>旧 bridge</span><strong>{{ dshLegacyBridgeLabel(profile) }}</strong></div>
            </div>
            <div class="profile-card-actions">
              <a-button
                v-if="profile.profileReady && profile.legacyBridgeInstalled"
                danger
                size="small"
                :loading="dshAction === `removeLegacyBridge:${profile.profileName}`"
                :disabled="Boolean(dshAction)"
                @click="confirmRemoveDshLegacyBridge(profile)"
              >移除旧 bridge</a-button>
              <a-tag v-else color="green">无旧 bridge</a-tag>
            </div>
          </a-card>
        </div>
        <a-empty v-else description="还没有 DeepSeek Harness profile">
          <span>输入名称初始化官方基础 profile。</span>
        </a-empty>
      </a-spin>
    </template>

    <a-alert
      v-else-if="!profileCapableCli"
      type="info"
      show-icon
      :message="`${selectedEntry.name} 在 ${appVersion} 沿用系统配置`"
      description="当前版本只展示安装状态、版本和路径，不提供尚未生效的配置按钮。"
    />

    <template v-else>
      <a-card class="profile-runtime-card" :bordered="false">
        <div class="profile-runtime-row">
          <div>
            <strong>{{ selectedEntry.name }} 状态</strong>
            <p>
              {{ selectedEntry.installed ? '已安装' : '未检测到' }}
              <template v-if="selectedCli === 'codex'"> · 当前系统 Provider：{{ profiles.codexRuntime?.currentProvider || 'openai' }}</template>
              <template v-else> · {{ claudeInheritedAuthPresentation(profiles.claudeRuntime?.inheritedAuthMode) }}</template>
            </p>
            <span class="profile-path">{{ runtimePath }}</span>
          </div>
          <a-space>
            <a-button @click="chooseProject">选择项目</a-button>
            <a-button type="primary" @click="openCreate">＋ 新建档案</a-button>
          </a-space>
        </div>
        <div v-if="projectPath" class="profile-project-path">
          项目默认范围：{{ projectPath }}
        </div>
      </a-card>

      <a-alert
        v-if="profiles.error"
        type="error"
        show-icon
        :message="profiles.error.message"
        closable
        @close="profiles.error = null"
      />

      <a-spin :spinning="profiles.loading">
        <div v-if="visibleProfiles.length" class="profile-card-grid">
          <a-card v-for="profile in visibleProfiles" :key="profile.id" class="profile-card">
            <template #title>
              <div class="profile-card-title">
                <span>{{ profile.name }}</span>
                <a-tag :color="statusView(profile).color">{{ statusView(profile).label }}</a-tag>
              </div>
            </template>
            <template #extra v-if="!isReadOnlyProfile(profile)">
              <a-dropdown>
                <a-button type="text">更多</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item @click="openEdit(profile)">编辑</a-menu-item>
                    <a-menu-item @click="openCopy(profile)">复制</a-menu-item>
                    <a-menu-item @click="openRevisions(profile)">版本记录</a-menu-item>
                    <a-menu-divider />
                    <a-menu-item danger @click="confirmDelete(profile)">删除</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </template>

            <div class="profile-card-body">
              <div class="profile-kind">{{ profileKindLabel(profile) }}</div>
              <div v-if="profileOriginLabel(profile)"><span>来源</span><strong>{{ profileOriginLabel(profile) }}</strong></div>
              <div><span>服务</span><strong>{{ profileServiceLabel(profile) }}</strong></div>
              <div><span>模型</span><strong>{{ profile.model || '跟随 Provider' }}</strong></div>
              <div v-if="!isReadOnlyProfile(profile) && profile.connectionMode !== 'subscription' && (profile.kind === 'managed' || profile.adapterId === 'claude')"><span>密钥</span><strong>{{ profileSecretLabel(profile) }}</strong></div>
              <div v-if="profile.adapterId === 'codex'"><span>推理强度</span><strong>{{ profile.reasoningEffort || '默认' }}</strong></div>
            </div>

            <div v-if="profileBadges(profile).length" class="profile-badges">
              <a-tag v-for="badge in profileBadges(profile)" :key="badge" color="blue">{{ badge }}</a-tag>
            </div>

            <a-alert
              v-if="profile.status !== 'ready'"
              :type="profile.status === 'drifted' ? 'warning' : 'error'"
              show-icon
              :message="statusView(profile).label"
            />

            <div class="profile-card-actions">
              <a-button v-if="!isReadOnlyProfile(profile)" size="small" @click="openEdit(profile)">编辑</a-button>
              <a-button size="small" @click="toggleAppDefault(profile)">
                {{ profile.isAppDefault ? '取消应用默认' : '设为应用默认' }}
              </a-button>
              <a-button size="small" :disabled="!projectPath" @click="toggleProjectDefault(profile)">
                {{ profile.isProjectDefault ? '取消项目默认' : '设为项目默认' }}
              </a-button>
              <a-button
                v-if="!isReadOnlyProfile(profile) && profile.adapterId === 'codex' && ['drifted', 'missing_file'].includes(profile.status)"
                size="small"
                danger
                @click="confirmRepair(profile)"
              >{{ profile.status === 'missing_file' ? '重新生成' : '用 UCLI 版本覆盖' }}</a-button>
              <a-button v-if="!isReadOnlyProfile(profile)" size="small" @click="openRevisions(profile)">版本记录</a-button>
            </div>
          </a-card>
        </div>
        <a-empty v-else :description="`还没有 ${selectedEntry.name} 档案`">
          <a-button type="primary" @click="openCreate">新建档案</a-button>
        </a-empty>
      </a-spin>
    </template>

    <CodexProfileDrawer
      v-if="selectedCli === 'codex'"
      v-model:open="editorOpen"
      :profile="editorSeed"
      :mode="editorMode"
      :provider-catalog="profiles.codexRuntime?.providerCatalog || []"
      :saving="profiles.saving"
      @save="saveProfile"
    />
    <ClaudeProfileDrawer
      v-else-if="selectedCli === 'claude'"
      v-model:open="editorOpen"
      :profile="editorSeed"
      :mode="editorMode"
      :saving="profiles.saving"
      @save="saveProfile"
    />
    <ProfileRevisionDrawer
      v-model:open="revisionOpen"
      :revisions="activeProfile ? profiles.revisionsByProfileId[activeProfile.id] || [] : []"
      :rolling-back-id="rollingBackId"
      @rollback="rollback"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { useRoute, useRouter } from 'vue-router'

import CodexProfileDrawer from '../components/profiles/CodexProfileDrawer.vue'
import ClaudeProfileDrawer from '../components/profiles/ClaudeProfileDrawer.vue'
import ProfileRevisionDrawer from '../components/profiles/ProfileRevisionDrawer.vue'
import {
  createDshManagementController,
  presentDshManagement
} from '../dshManagementPresentation.js'
import { ipc } from '../ipc.js'
import {
  claudeConnectionModePresentation,
  claudeInheritedAuthPresentation,
  profileBadges,
  profileEndpointLabel,
  profileOriginLabel,
  profileSecretLabel,
  profileStatusPresentation
} from '../profilePresentation.js'
import { useAiCliProfilesStore } from '../stores/aiCliProfiles.js'

const appVersion = __UCLI_VERSION__
const profiles = useAiCliProfilesStore()
const route = useRoute()
const router = useRouter()
const supportedCliIds = ['codex', 'claude', 'opencode', 'ucode', 'deepseek-harness']
const selectedCli = ref(supportedCliIds.includes(route.query.cli) ? route.query.cli : 'codex')
const projectPath = ref('')
const editorOpen = ref(false)
const editorMode = ref('create')
const editorSeed = ref(null)
const activeProfile = ref(null)
const revisionOpen = ref(false)
const rollingBackId = ref('')
const dshProfileState = ref({ profiles: [] })
const dshRuntimeView = ref(presentDshManagement(null))
const dshLoading = ref(false)
const dshAction = ref('')
const newDshProfileName = ref('')
let dshProfileReadRevision = 0

const dshRuntimeController = createDshManagementController({
  getState: () => ipc.getDshState(),
  actions: {
    installRuntime: () => ipc.installDshRuntime(),
    upgradeRuntime: () => ipc.upgradeDshRuntime(),
    repairRuntime: () => ipc.repairDshRuntime(),
    removeRuntime: () => ipc.removeDshRuntime()
  },
  onState: (next) => { dshRuntimeView.value = next }
})

const names = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', ucode: 'U-Code', 'deepseek-harness': 'DeepSeek Harness' }
const cliEntries = computed(() => supportedCliIds.map((id) => ({
  id,
  name: names[id],
  ...profiles.cliById(id)
})))
const selectedEntry = computed(() => cliEntries.value.find((item) => item.id === selectedCli.value) || cliEntries.value[0])
const profileCapableCli = computed(() => ['codex', 'claude'].includes(selectedCli.value))
const visibleProfiles = computed(() => profiles.profiles.filter((profile) => profile.adapterId === selectedCli.value))
const dshProfiles = computed(() => dshProfileState.value.profiles)
const canInitializeDshProfile = computed(() => {
  const name = newDshProfileName.value.trim()
  return ['managed', 'system'].includes(dshRuntimeView.value.selected) &&
    dshRuntimeView.value.status === 'healthy' &&
    !dshLoading.value &&
    !dshAction.value &&
    name.length > 0 &&
    !dshProfiles.value.some(profile => profile.profileName === name)
})
const pageLoading = computed(() => profiles.loading || dshLoading.value)
const runtimePath = computed(() => selectedCli.value === 'claude'
  ? (profiles.claudeRuntime?.configDir || selectedEntry.value.path || '配置路径未知')
  : (profiles.codexRuntime?.configPath || selectedEntry.value.path || '配置路径未知'))

const statusView = (profile) => profileStatusPresentation(profile.status)
const isReadOnlyProfile = (profile) => profile.sourceKind === 'server' || profile.readOnly === true
const profileKindLabel = (profile) => profile.sourceKind === 'server'
  ? '组织提供'
  : profile.adapterId === 'claude'
  ? claudeConnectionModePresentation(profile.connectionMode).label
  : (profile.kind === 'managed' ? 'UCLI 托管' : '引用现有 Provider')
const profileServiceLabel = (profile) => {
  if (profile.adapterId === 'claude') {
    return profile.connectionMode === 'subscription'
      ? '使用现有 Claude 登录态'
      : (profile.baseUrl ? profileEndpointLabel(profile.baseUrl) : 'Anthropic 官方地址')
  }
  return profile.kind === 'managed' ? profileEndpointLabel(profile.baseUrl) : profile.providerId
}

const cliProfileSupportLabel = (adapterId) => {
  if (['codex', 'claude'].includes(adapterId)) return '支持 UCLI 配置档案'
  if (adapterId === 'deepseek-harness') return '管理 DSH 原生 profile 与 UCLI bridge'
  return `${appVersion} 沿用系统配置`
}

async function reload() {
  await Promise.all([profiles.load(projectPath.value), loadDshProfiles()])
}

function selectCli(adapterId) {
  selectedCli.value = adapterId
  router.replace({ name: 'profiles', query: { ...route.query, cli: adapterId } })
}

async function loadDshProfiles() {
  const readRevision = ++dshProfileReadRevision
  dshLoading.value = true
  try {
    const [, state] = await Promise.all([
      dshRuntimeController.refresh(),
      ipc.listDshProfiles()
    ])
    if (readRevision === dshProfileReadRevision) {
      dshProfileState.value = {
        profiles: Array.isArray(state?.profiles) ? state.profiles : []
      }
    }
    return state
  } catch {
    if (readRevision === dshProfileReadRevision) dshProfileState.value = { profiles: [] }
    message.error('读取 DeepSeek Harness 状态失败')
    return null
  } finally {
    if (readRevision === dshProfileReadRevision) dshLoading.value = false
  }
}

async function refreshDshProfilesOnly() {
  const readRevision = ++dshProfileReadRevision
  const state = await ipc.listDshProfiles()
  if (readRevision === dshProfileReadRevision) {
    dshProfileState.value = {
      profiles: Array.isArray(state?.profiles) ? state.profiles : []
    }
  }
}

function confirmDshRuntimeAction(action) {
  if (!action?.method || dshAction.value) return
  Modal.confirm({
    title: action.label,
    content: action.confirmText,
    okText: action.label,
    okType: action.danger ? 'danger' : 'primary',
    cancelText: '取消',
    async onOk() {
      dshAction.value = action.method
      try {
        await dshRuntimeController.mutate(action.method)
        await refreshDshProfilesOnly()
        message.success('DSH 运行时状态已更新')
      } catch {
        message.error('DSH 运行时操作失败')
      } finally {
        dshAction.value = ''
      }
    }
  })
}

async function initializeDshProfile() {
  newDshProfileName.value = newDshProfileName.value.trim()
  if (!canInitializeDshProfile.value) return
  dshAction.value = 'initialize'
  try {
    const result = await ipc.initializeDshProfile(newDshProfileName.value)
    if (!result?.ok) throw Object.assign(new Error(result?.errorCode), { code: result?.errorCode })
    message.success('基础 profile 已初始化')
    newDshProfileName.value = ''
    await refreshDshProfilesOnly()
  } catch (error) {
    message.error(dshErrorLabel(error?.code, '初始化 DeepSeek Harness profile 失败'))
  } finally {
    dshAction.value = ''
  }
}

function confirmRemoveDshLegacyBridge(profile) {
  if (!profile?.profileName || dshAction.value) return
  Modal.confirm({
    title: `移除“${profile.profileName}”中的旧 bridge？`,
    content: '仅移除旧版 UCLI bridge 元数据；DSH profile 的其他配置保持不变。',
    okText: '移除旧 bridge',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      dshAction.value = `removeLegacyBridge:${profile.profileName}`
      try {
        const result = await ipc.removeDshLegacyBridge(profile.profileName)
        if (!result?.ok) throw Object.assign(new Error(result?.errorCode), { code: result?.errorCode })
        message.success('旧 bridge 已移除')
        await refreshDshProfilesOnly()
      } catch (error) {
        message.error(dshErrorLabel(error?.code, '移除旧 bridge 失败'))
      } finally {
        dshAction.value = ''
      }
    }
  })
}

function dshLegacyBridgeLabel(profile) {
  if (!profile?.profileReady) return 'profile 结构无效'
  if (!profile.legacyBridgeInstalled) return '无'
  return `待移除${profile.legacyBridgeVersion ? `（${profile.legacyBridgeVersion}）` : ''}`
}

function dshProfileSurfaceLabel(surface) {
  return ({ web: 'Web', headless: 'Headless', custom: '自定义' })[surface] || '未知'
}

function runtimeRowLabel(row) {
  if (!row.installed) return '未安装'
  if (!row.compatible) return `${row.version || '未知版本'} · 不兼容`
  return `${row.version || '未知版本'} · ${row.health === 'healthy' ? '正常' : '需要修复'}`
}

function dshErrorLabel(code, fallback) {
  return ({
    DSH_NOT_INSTALLED: '未检测到 DeepSeek Harness',
    DSH_VERSION_UNREADABLE: '无法读取 DeepSeek Harness 版本',
    DSH_VERSION_UNSUPPORTED: 'DeepSeek Harness 版本不兼容',
    DSH_PROFILE_INVALID: 'profile 名称或结构无效',
    DSH_PROFILE_ALREADY_EXISTS: '同名 profile 已存在',
    DSH_PROFILE_INITIALIZE_FAILED: '基础 profile 初始化失败',
    DSH_PROFILE_NOT_READY: 'profile 结构无效',
    DSH_BRIDGE_VERSION_UNSUPPORTED: 'UCLI bridge 版本不兼容',
    DSH_BRIDGE_INSTALL_FAILED: 'UCLI bridge 操作失败',
    DSH_BRIDGE_ROLLBACK_FAILED: 'UCLI bridge 回滚失败'
  })[code] || fallback
}

async function chooseProject() {
  const path = await ipc.pickDirectory()
  if (!path) return
  projectPath.value = path
  await reload()
}

function openCreate() {
  editorMode.value = 'create'
  editorSeed.value = null
  editorOpen.value = true
}

function openEdit(profile) {
  if (isReadOnlyProfile(profile)) return
  editorMode.value = 'edit'
  editorSeed.value = profile
  editorOpen.value = true
}

function openCopy(profile) {
  if (isReadOnlyProfile(profile)) return
  editorMode.value = 'copy'
  editorSeed.value = { ...profile, name: `${profile.name} 副本`, hasSecret: false }
  editorOpen.value = true
}

async function saveProfile(draft) {
  try {
    if (editorMode.value === 'edit') {
      const { secret, adapterId, ...patch } = draft
      await profiles.update(editorSeed.value.id, {
        ...patch,
        ...(secret ? { secret } : {})
      })
    } else {
      await profiles.create(draft)
    }
    editorOpen.value = false
    message.success('档案已保存')
  } catch (error) {
    message.error(error?.message || '保存档案失败')
  }
}

async function toggleAppDefault(profile) {
  await profiles.setBinding({
    scopeType: 'app', scopeKey: '*', adapterId: profile.adapterId,
    profileId: profile.isAppDefault ? null : profile.id
  })
}

async function toggleProjectDefault(profile) {
  if (!projectPath.value) return
  await profiles.setBinding({
    scopeType: 'project', scopeKey: projectPath.value, adapterId: profile.adapterId,
    profileId: profile.isProjectDefault ? null : profile.id
  })
}

function confirmRepair(profile) {
  if (isReadOnlyProfile(profile)) return
  Modal.confirm({
    title: profile.status === 'missing_file' ? '重新生成档案文件？' : '用 UCLI 版本覆盖外部修改？',
    content: `目标：${profiles.codexRuntime?.configPath || 'Codex 配置目录'} 下的 UCLI 管理文件。继续后将更新文件指纹；不会改写 config.toml。`,
    okText: profile.status === 'missing_file' ? '重新生成' : '确认覆盖',
    cancelText: '取消',
    async onOk() {
      await profiles.repair(profile.id)
      message.success('档案文件已修复')
    }
  })
}

function confirmDelete(profile) {
  if (isReadOnlyProfile(profile)) return
  Modal.confirm({
    title: `删除“${profile.name}”？`,
    content: '已被默认设置或会话使用的档案不能删除。API Key 将从系统加密存储中一并移除。',
    okText: '删除', okType: 'danger', cancelText: '取消',
    async onOk() { await profiles.remove(profile.id) }
  })
}

async function openRevisions(profile) {
  if (isReadOnlyProfile(profile)) return
  activeProfile.value = profile
  await profiles.loadRevisions(profile.id)
  revisionOpen.value = true
}

async function rollback(revisionId) {
  if (!activeProfile.value) return
  rollingBackId.value = revisionId
  try {
    await profiles.rollback(activeProfile.value.id, revisionId)
    message.success('已回滚档案配置，密钥保持不变')
  } finally {
    rollingBackId.value = ''
  }
}

onMounted(() => reload())
</script>
