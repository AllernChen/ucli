<template>
  <a-modal
    :open="open"
    title="会话配置"
    width="680px"
    :footer="null"
    @cancel="close"
  >
    <a-empty v-if="!session" description="会话不存在或已被移除" />
    <div v-else class="session-config-body">
      <a-alert
        v-if="view.needsAttention"
        type="warning"
        show-icon
        :message="view.attentionText"
        class="attention-alert"
      />

      <section class="config-section" aria-labelledby="session-info-heading">
        <h3 id="session-info-heading">会话信息</h3>
        <a-descriptions size="small" :column="2" bordered>
          <a-descriptions-item label="AI CLI">{{ adapterLabel }}</a-descriptions-item>
          <a-descriptions-item label="状态">{{ statusLabel }}</a-descriptions-item>
          <a-descriptions-item label="工作目录" :span="2">
            <a-typography-text copyable>{{ session.cwd || '未设置工作目录' }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item label="UCLI 会话 ID">
            <a-typography-text copyable>{{ session.id }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item v-if="capabilities.ucliHistory" label="CLI 会话 ID">
            <a-typography-text v-if="session.cliSessionId" copyable>{{ session.cliSessionId }}</a-typography-text>
            <span v-else>—</span>
          </a-descriptions-item>
          <a-descriptions-item v-if="capabilities.ucliPermission" label="权限模式">{{ tierLabel }}</a-descriptions-item>
          <a-descriptions-item v-else-if="capabilities.web" label="控制权">DSH 原生</a-descriptions-item>
          <a-descriptions-item label="模型">{{ session.actualModel || session.model || '—' }}</a-descriptions-item>
        </a-descriptions>

        <a-form layout="vertical" class="basic-form">
          <a-form-item label="会话名称">
            <a-input v-model:value="nameDraft" :maxlength="80" />
          </a-form-item>
          <a-form-item label="备注">
            <a-textarea v-model:value="noteDraft" :rows="4" :maxlength="4000" placeholder="记录进度或下一步计划" />
          </a-form-item>
          <div class="section-actions">
            <a-button type="primary" :loading="savingBasics" @click="saveBasics">保存会话信息</a-button>
          </div>
        </a-form>
      </section>

      <section class="config-section" aria-labelledby="runtime-config-heading">
        <h3 id="runtime-config-heading">运行配置</h3>
        <a-alert
          v-if="capabilities.web"
          type="info"
          show-icon
          message="DSH 原生控制"
          description="权限、历史与审批由 DSH 原生界面管理；token 统计由 UCLI 拉取展示。"
          class="runtime-alert"
        />
        <a-form layout="vertical">
          <a-form-item v-if="view.profileCapable" label="配置档案">
            <a-select
              v-model:value="selectedProfileId"
              :disabled="pendingAction !== ''"
              @change="selectSessionProfile"
            >
              <a-select-option value="system">系统 / 来源策略</a-select-option>
              <a-select-opt-group label="服务档案">
                <a-select-option
                  v-for="profile in serverProfilesForSession"
                  :key="profile.id"
                  :value="profile.id"
                  :disabled="!canSelectProfile(profile)"
                >
                  {{ profileLabel(profile) }}{{ canSelectProfile(profile) ? '' : '（当前不可用）' }}
                </a-select-option>
              </a-select-opt-group>
              <a-select-opt-group label="本地档案">
              <a-select-option
                v-for="profile in localProfilesForSession"
                :key="profile.id"
                :value="profile.id"
                :disabled="!canSelectProfile(profile)"
              >
                {{ profileLabel(profile) }}{{ canSelectProfile(profile) ? '' : '（当前不可用）' }}
              </a-select-option>
              </a-select-opt-group>
              <a-select-option v-if="historicalProfileId" :value="historicalProfileId" disabled>
                历史服务档案（已移除）
              </a-select-option>
            </a-select>
          </a-form-item>

          <a-form-item v-if="selectedServiceProfile" label="模型">
            <a-select
              v-model:value="selectedModelId"
              placeholder="请选择兼容模型"
              :disabled="pendingAction !== ''"
              @change="setSessionProfile"
            >
              <a-select-option v-if="serviceProfileState.historicalModel" :value="serviceProfileState.historicalModel.id" disabled>
                {{ serviceProfileState.historicalModel.displayName }}（保留历史选择／已移除）
              </a-select-option>
              <a-select-option
                v-for="model in compatibleModels"
                :key="model.id"
                :value="model.id"
                :disabled="model.availabilityStatus !== 'ready'"
              >{{ serviceModelLabel(model) }}</a-select-option>
            </a-select>
          </a-form-item>

          <a-alert
            v-if="profileNotice"
            type="warning"
            show-icon
            :message="profileNotice"
            class="runtime-alert"
          />

          <a-form-item v-if="view.providerEditable" label="Codex Provider 策略">
            <a-select
              :value="session.providerPolicy || 'live'"
              :disabled="pendingAction !== ''"
              @change="setCodexProviderPolicy"
            >
              <a-select-option value="source">来源 Provider</a-select-option>
              <a-select-option value="live">跟随当前</a-select-option>
              <a-select-option value="explicit">显式指定</a-select-option>
            </a-select>
          </a-form-item>

          <a-form-item v-if="view.explicitProviderVisible" label="指定 Provider">
            <a-select
              :value="session.explicitProvider || codexRuntime?.currentProvider"
              :disabled="pendingAction !== ''"
              @change="setCodexExplicitProvider"
            >
              <a-select-option
                v-for="provider in codexRuntime?.availableProviders || []"
                :key="provider"
                :value="provider"
              >{{ provider }}</a-select-option>
            </a-select>
          </a-form-item>

          <a-alert
            v-if="providerNotice"
            type="warning"
            show-icon
            :message="providerNotice"
            class="runtime-alert"
          />
        </a-form>
      </section>

      <section class="config-section" aria-labelledby="collaboration-heading">
        <h3 id="collaboration-heading">协作与诊断</h3>
        <div v-if="capabilities.gateway" class="control-row">
          <div>
            <div class="control-title">远程转发</div>
            <div class="control-help">控制该会话是否通过已配置的 Gateway 转发。</div>
          </div>
          <GatewayRelayToggle :session-id="session.id" />
        </div>
        <div v-if="view.profileCapable" class="control-row">
          <div>
            <div class="control-title">会话诊断</div>
            <div class="control-help">检查 UCLI 记录与原生 CLI 会话的绑定关系。</div>
          </div>
          <a-button @click="diagnosticsVisible = true">会话诊断</a-button>
        </div>
      </section>

    </div>

    <SessionDiagnosticsModal
      v-model:open="diagnosticsVisible"
      :session-id="sessionId"
    />

    <a-modal :open="profileSwitch.open" title="切换配置档案" :footer="null" :closable="false">
      <p>该会话正在运行。可以保留当前进程并在下次重启时生效，也可以现在重启。</p>
      <div class="modal-footer">
        <a-button @click="cancelProfileSwitch">取消</a-button>
        <a-button @click="applyProfileSwitch(false)">下次重启生效</a-button>
        <a-button type="primary" @click="applyProfileSwitch(true)">立即重启</a-button>
      </div>
    </a-modal>
  </a-modal>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'

import { ipc } from '../ipc.js'
import { profileRuntimeNotice, serviceModelLabel } from '../profilePresentation.js'
import {
  deriveServiceProfileSessionState,
  deriveSessionConfigState,
  isReadyServiceProfileForAdapter,
  isServiceProfile,
  sessionProfileDraftFor
} from '../sessionConfigPresentation.js'
import { deriveSessionCapabilityState } from '../sessionMaintenancePresentation.js'
import { compatibleModelsForAdapter } from '../serviceProfileSelection.js'
import { useAiCliProfilesStore } from '../stores/aiCliProfiles.js'
import { useSessionsStore } from '../stores/sessions.js'
import GatewayRelayToggle from './gateway/GatewayRelayToggle.vue'
import SessionDiagnosticsModal from './SessionDiagnosticsModal.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  sessionId: { type: String, default: '' }
})
const emit = defineEmits(['update:open'])

const sessions = useSessionsStore()
const aiProfiles = useAiCliProfilesStore()
const session = computed(() => sessions.byId(props.sessionId) || null)
const view = computed(() => deriveSessionConfigState(session.value || {}))
const capabilities = computed(() => deriveSessionCapabilityState(session.value || {}))
const adapter = computed(() => sessions.adapters.find((item) => item.id === session.value?.adapterId) || null)
const profilesForSession = computed(() => aiProfiles.profiles.filter((profile) =>
  profile.adapterId === session.value?.adapterId || isServiceProfile(profile)
))
const localProfilesForSession = computed(() => profilesForSession.value.filter((profile) => !isServiceProfile(profile)))
const serverProfilesForSession = computed(() => profilesForSession.value.filter(isServiceProfile))
const selectedProfileId = ref('system')
const selectedModelId = ref(null)
const selectedProfile = computed(() => aiProfiles.profileById(selectedProfileId.value))
const historicalProfileId = computed(() => (
  session.value?.profileId && !selectedProfile.value && session.value?.profileSourceKind === 'server'
    ? session.value.profileId
    : null
))
const selectedServiceProfile = computed(() => isServiceProfile(selectedProfile.value) || Boolean(historicalProfileId.value))
const compatibleModels = computed(() => compatibleModelsForAdapter(selectedProfile.value, session.value?.adapterId))
const serviceProfileState = computed(() => deriveServiceProfileSessionState({
  profile: selectedProfile.value,
  adapterId: session.value?.adapterId,
  profileId: selectedProfileId.value === 'system' ? null : selectedProfileId.value,
  model: selectedModelId.value,
  historical: Boolean(historicalProfileId.value || (
    selectedModelId.value && !selectedProfile.value?.models?.some(model => model?.id === selectedModelId.value)
  ))
}))

const nameDraft = ref('')
const noteDraft = ref('')
const savingBasics = ref(false)
const pendingAction = ref('')
const diagnosticsVisible = ref(false)
const codexRuntime = ref(null)
const profileSwitch = ref({ open: false, selection: null })
let stopCodexRuntimeListener = null
let runtimeSubscriptionVersion = 0

const adapterLabel = computed(() => {
  if (!session.value) return '—'
  return `${adapter.value?.icon || '•'} ${adapter.value?.displayName || session.value.adapterId}`
})

const statusLabel = computed(() => ({
  running: '运行中',
  idle: '空闲',
  waiting: '待确认',
  starting: '启动中',
  error: '错误',
  exited: '已退出',
  offline: '已离线'
})[session.value?.status] || session.value?.status || '—')

const tierLabel = computed(() => ({
  'always-agree': '一直同意',
  'safety-rules': '安全规则',
  'ask-everything': '逐次确认'
})[session.value?.tier] || session.value?.tier || '—')

const profileNotice = computed(() => profileRuntimeNotice(session.value || {}))
const providerNotice = computed(() => {
  const current = session.value
  if (!current || current.adapterId !== 'codex' || current.profileId) return ''
  if (current.pendingProviderWarning === 'explicit_provider_unavailable' || current.providerWarning === 'explicit_provider_unavailable') {
    return '显式 Provider 已不可用，请重新选择后再重启。'
  }
  if (current.restartRequired) {
    return `Provider 配置已变更，重启后将使用 ${current.pendingProvider || '当前配置'}。`
  }
  return current.providerWarning ? '来源 Provider 已不可用，将使用当前配置。' : ''
})

function resetDrafts() {
  nameDraft.value = session.value?.displayName || ''
  noteDraft.value = session.value?.taskNote || ''
  const profileDraft = sessionProfileDraftFor(session.value)
  selectedProfileId.value = profileDraft.profileId
  selectedModelId.value = profileDraft.model
  profileSwitch.value = { open: false, selection: null }
  diagnosticsVisible.value = false
}

function stopRuntimeSubscription() {
  runtimeSubscriptionVersion += 1
  stopCodexRuntimeListener?.()
  stopCodexRuntimeListener = null
}

async function syncRuntimeSubscription() {
  stopRuntimeSubscription()
  const subscriptionVersion = runtimeSubscriptionVersion
  codexRuntime.value = null
  if (!props.open || session.value?.adapterId !== 'codex') return
  try {
    const snapshot = await ipc.getCodexRuntime()
    if (
      subscriptionVersion !== runtimeSubscriptionVersion ||
      !props.open ||
      session.value?.adapterId !== 'codex'
    ) return
    codexRuntime.value = snapshot
    stopCodexRuntimeListener = ipc.onCodexRuntime((snapshot) => {
      codexRuntime.value = snapshot
    })
  } catch {
    codexRuntime.value = null
  }
}

watch(
  () => [props.open, props.sessionId, session.value?.adapterId],
  () => {
    resetDrafts()
    if (props.open) aiProfiles.load(session.value?.cwd || '').catch(() => {})
    syncRuntimeSubscription()
  },
  { immediate: true }
)

onBeforeUnmount(stopRuntimeSubscription)

function close() {
  stopRuntimeSubscription()
  emit('update:open', false)
}

async function saveBasics() {
  const current = session.value
  if (!current) return
  const name = nameDraft.value.trim()
  if (!name) {
    message.warning('会话名称不能为空')
    return
  }
  savingBasics.value = true
  try {
    if (name !== current.displayName) await sessions.updateName(current.id, name)
    if (noteDraft.value !== (current.taskNote || '')) await sessions.updateNote(current.id, noteDraft.value)
    message.success('会话信息已保存')
  } catch (error) {
    message.error('保存会话信息失败：' + (error?.message || error))
  } finally {
    savingBasics.value = false
  }
}

function sessionIsActive(current) {
  return current && !['offline', 'exited', 'error'].includes(current.status)
}

function profileLabel(profile) {
  return isServiceProfile(profile) ? (profile.organization?.name || profile.id) : profile.name
}

function canSelectProfile(profile) {
  return isServiceProfile(profile)
    ? isReadyServiceProfileForAdapter(profile, session.value?.adapterId)
    : profile.canStart
}

function selectSessionProfile(value) {
  if (value === 'system' || !isServiceProfile(selectedProfile.value)) {
    selectedModelId.value = null
    setSessionProfile()
  } else {
    selectedModelId.value = null
  }
}

async function setSessionProfile() {
  const current = session.value
  if (!current) return
  const profileId = selectedProfileId.value === 'system' ? null : selectedProfileId.value
  const selection = { profileId, model: selectedServiceProfile.value ? selectedModelId.value : null }
  if (selectedServiceProfile.value && !serviceProfileState.value.canStart) {
    message.warning(serviceProfileState.value.reason === 'model-required' ? '请选择兼容模型' : '所选模型当前不可用')
    return
  }
  if (current.profileId === selection.profileId && current.model === selection.model) return
  if (sessionIsActive(current)) {
    profileSwitch.value = { open: true, selection }
    return
  }
  try {
    await sessions.setProfile(current.id, selection)
  } catch (error) {
    message.error('切换档案失败：' + (error?.message || error))
  }
}

function cancelProfileSwitch() {
  const profileDraft = sessionProfileDraftFor(session.value)
  selectedProfileId.value = profileDraft.profileId
  selectedModelId.value = profileDraft.model
  profileSwitch.value = { open: false, selection: null }
}

async function applyProfileSwitch(restartNow) {
  const current = session.value
  const selection = profileSwitch.value.selection
  if (!current || !selection) return
  profileSwitch.value = { open: false, selection: null }
  pendingAction.value = restartNow ? 'restart' : 'profile'
  try {
    await sessions.setProfile(current.id, selection)
    if (restartNow) {
      if (sessionIsActive(current)) await sessions.stop(current.id)
      await sessions.restart(current.id)
    } else {
      message.info('档案已保存，将在下次重启生效')
    }
    resetDrafts()
  } catch (error) {
    message.error('切换档案失败：' + (error?.message || error))
  } finally {
    pendingAction.value = ''
  }
}

async function setCodexProviderPolicy(policy) {
  const current = session.value
  if (!current) return
  const explicitProvider = policy === 'explicit'
    ? (current.explicitProvider || codexRuntime.value?.currentProvider || null)
    : undefined
  try {
    await sessions.updateCodexProviderPolicy(current.id, { policy, explicitProvider })
    message.success('Codex Provider 策略已保存；正在运行的会话不会自动重启。')
  } catch (error) {
    message.error('保存 Provider 策略失败：' + (error?.message || error))
  }
}

async function setCodexExplicitProvider(explicitProvider) {
  if (!session.value) return
  try {
    await sessions.updateCodexProviderPolicy(session.value.id, { policy: 'explicit', explicitProvider })
  } catch (error) {
    message.error('保存 Codex Provider 失败：' + (error?.message || error))
  }
}

</script>

<style scoped>
.session-config-body {
  max-height: calc(100vh - 180px);
  overflow-y: auto;
  padding-right: 4px;
}
.attention-alert { margin-bottom: 14px; }
.config-section { padding: 2px 0 16px; }
.config-section + .config-section { border-top: 1px solid #f0f0f0; padding-top: 16px; }
.config-section h3 { margin: 0 0 12px; font-size: 14px; color: #262626; }
.basic-form { margin-top: 14px; }
.section-actions { display: flex; justify-content: flex-end; }
.runtime-alert { margin-bottom: 14px; }
.control-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
.control-title { font-weight: 500; color: #262626; }
.control-help { margin: 2px 0 0; color: #8c8c8c; font-size: 12px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

@media (max-width: 720px) {
  .control-row { align-items: flex-start; flex-direction: column; }
}
</style>
