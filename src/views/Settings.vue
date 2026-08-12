<template>
  <div class="settings">
    <a-card title="通信 Gateway" class="settings-card">
      <div class="gateway-summary">
        <a-descriptions size="small" :column="1">
          <a-descriptions-item label="通信端">飞书</a-descriptions-item>
          <a-descriptions-item label="目标">{{ gatewayTargetLabel(gateway.configuration) }}</a-descriptions-item>
          <a-descriptions-item label="状态">
            {{ gateway.runtime.desiredEnabled ? '期望开启' : '期望关闭' }}
            · {{ gatewayPhaseLabel(gateway.runtime.phase) }}
          </a-descriptions-item>
          <a-descriptions-item label="会话">
            已选择 {{ gateway.runtime.selectedSessionCount }} · 可转发 {{ gateway.runtime.readySessionCount }}
          </a-descriptions-item>
          <a-descriptions-item label="最近连接">
            {{ gateway.runtime.errorMessage || gatewayTimeLabel(gateway.runtime.lastConnectedAt) }}
          </a-descriptions-item>
        </a-descriptions>
        <a-button ref="gatewayTrigger" type="primary" @click="openGatewayDrawer">配置</a-button>
      </div>
    </a-card>

    <a-card title="CLI 管理" class="settings-card">
      <div class="cli-toolbar">
        <span class="muted">检测本机 PATH 中的 AI CLI。安装或升级前会显示并确认完整命令。</span>
        <a-button size="small" :loading="detecting" @click="loadCliTools">重新检测</a-button>
      </div>
      <a-list :data-source="cliTools" :loading="detecting" item-layout="horizontal">
        <template #renderItem="{ item }">
          <a-list-item>
            <template #actions>
              <a-button
                v-if="!item.installed"
                size="small"
                type="primary"
                :loading="runningTool === `${item.id}:install`"
                @click="confirmCliAction(item, 'install')"
              >安装</a-button>
              <a-button
                v-else
                size="small"
                :loading="runningTool === `${item.id}:upgrade`"
                @click="confirmCliAction(item, 'upgrade')"
              >升级</a-button>
            </template>
            <a-list-item-meta :title="item.displayName">
              <template #description>
                <div class="cli-meta">
                  <a-tag :color="item.installed ? 'green' : 'default'">{{ item.installed ? '已安装' : '未检测到' }}</a-tag>
                  <span v-if="item.version">{{ item.version }}</span>
                  <span v-if="item.path" class="cli-path" :title="item.path">{{ item.path }}</span>
                  <span v-else-if="item.error" class="cli-error">{{ item.error }}</span>
                </div>
              </template>
            </a-list-item-meta>
          </a-list-item>
        </template>
      </a-list>
      <a-alert
        v-if="lastCliResult"
        style="margin-top: 12px"
        :type="lastCliResult.ok ? 'success' : 'error'"
        show-icon
        :message="lastCliResult.ok ? 'CLI 操作完成' : `CLI 操作失败（退出码 ${lastCliResult.code}）`"
      >
        <template #description>
          <div class="result-command">{{ lastCliResult.command }}</div>
          <pre v-if="lastCliOutput" class="result-output">{{ lastCliOutput }}</pre>
        </template>
      </a-alert>
    </a-card>

    <a-card title="默认设置" class="settings-card">
      <a-form layout="vertical">
        <a-form-item label="默认 CLI">
          <a-select v-model:value="local.defaultAdapter">
            <a-select-option v-for="a in adapters" :key="a.id" :value="a.id">{{ a.icon }} {{ a.displayName }}</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="默认权限模式">
          <a-radio-group v-model:value="local.defaultTier">
            <a-radio value="always-agree">一直同意</a-radio>
            <a-radio value="safety-rules">安全规则</a-radio>
            <a-radio value="ask-everything">逐次确认</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="默认工作目录">
          <a-input-group compact>
            <a-input v-model:value="local.defaultCwd" style="width: calc(100% - 80px)" />
            <a-button style="width: 80px" @click="pickDir">浏览</a-button>
          </a-input-group>
        </a-form-item>
        <a-form-item label="Codex 配置目录">
          <a-input-group compact>
            <a-input v-model:value="local.codexConfigDir" placeholder="留空时使用 CODEX_HOME 或 ~/.codex" style="width: calc(100% - 80px)" />
            <a-button style="width: 80px" @click="pickCodexConfigDir">浏览</a-button>
          </a-input-group>
          <div class="muted">切换后仅影响后续启动或重新启动的 Codex 会话。</div>
        </a-form-item>
        <a-form-item label="Codex 当前 Provider">
          <a-space v-if="codexRuntime">
            <a-tag color="blue">{{ codexRuntime.currentProvider }}</a-tag>
            <span class="muted">可用：{{ codexRuntime.availableProviders.join('、') }}</span>
          </a-space>
          <span v-else class="muted">正在读取配置状态…</span>
        </a-form-item>
        <a-form-item label="语言">
          <a-select v-model:value="local.language" style="width: 200px">
            <a-select-option value="zh-CN">简体中文</a-select-option>
            <a-select-option value="en">English</a-select-option>
          </a-select>
        </a-form-item>
        <a-button type="primary" @click="save">保存设置</a-button>
      </a-form>
    </a-card>

    <a-card title="自动工作总结" class="settings-card">
      <a-form layout="vertical">
        <a-form-item label="启用自动总结">
          <a-switch :checked="local.autoEnabled" @change="onSummaryAutoChange" />
          <div class="muted summary-help">仅在 UCLI 运行时检查，每 15 分钟补齐最新一个已完成周期。</div>
        </a-form-item>
        <a-form-item label="总结周期">
          <a-space wrap>
            <a-checkbox v-model:checked="local.autoPeriods.day" value="day">每日</a-checkbox>
            <a-checkbox v-model:checked="local.autoPeriods.week" value="week">每周</a-checkbox>
            <a-checkbox v-model:checked="local.autoPeriods.month" value="month">每月</a-checkbox>
            <a-checkbox v-model:checked="local.autoPeriods.quarter" value="quarter">每季度</a-checkbox>
            <a-checkbox v-model:checked="local.autoPeriods.year" value="year">每年</a-checkbox>
          </a-space>
        </a-form-item>
        <a-form-item label="默认 AI CLI">
          <a-select
            v-model:value="local.defaultExecutorId"
            allow-clear
            placeholder="选择已安装的 AI CLI"
            @change="onSummaryExecutorChange"
          >
            <a-select-option v-for="tool in summaryExecutorOptions" :key="tool.id" :value="tool.id">
              {{ tool.displayName }} {{ tool.version ? `· ${tool.version}` : '' }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="默认配置档案">
          <a-select
            v-model:value="local.defaultProfileId"
            allow-clear
            placeholder="可选：使用系统登录状态"
          >
            <a-select-option v-for="profile in summaryProfileOptions" :key="profile.id" :value="profile.id">
              {{ profile.name }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="默认模型">
          <a-select
            v-model:value="local.defaultModel"
            allow-clear
            show-search
            placeholder="可选：使用 CLI 或配置档案默认模型"
          >
            <a-select-option v-for="model in summaryModelOptions" :key="model" :value="model">
              {{ model }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-alert
          type="info"
          show-icon
          message="数据与费用说明"
          description="自动总结会把所选会话材料通过配置的 CLI/Provider 发送给对应 AI 服务，并可能产生费用。手动生成时仍可逐次选择 CLI、配置档案和模型。"
        />
        <a-button type="primary" style="margin-top: 12px" @click="save">保存自动总结设置</a-button>
      </a-form>
    </a-card>

    <a-card title="快捷键" class="settings-card">
      <a-list :data-source="bindingsList" item-layout="horizontal">
        <template #renderItem="{ item }">
          <a-list-item>
            <template #actions>
              <a-button size="small" @click="startCapture(item)">修改</a-button>
              <a-button v-if="item.overridden" size="small" danger @click="resetBinding(item.id)">重置</a-button>
            </template>
            <a-list-item-meta :title="item.name">
              <template #description>
                <a-tag>{{ item.display }}</a-tag>
                <span v-if="item.contexts" class="muted" style="margin-left:6px;font-size:11px;">{{ item.contexts.join(', ') }}</span>
              </template>
            </a-list-item-meta>
          </a-list-item>
        </template>
      </a-list>

      <a-modal v-model:open="captureVisible" title="修改快捷键" @ok="saveCapture" @cancel="cancelCapture" okText="保存" cancelText="取消">
        <p>在下方框中按下新的快捷键组合：</p>
        <div ref="captureRef" class="capture-box" tabindex="0" @keydown="onCaptureKey" @keyup.prevent>{{ capturedDisplay || '等待按键...' }}</div>
        <a-button v-if="capturedKeys" size="small" @click="clearCapture" style="margin-top:8px;">清除快捷键</a-button>
      </a-modal>
    </a-card>

    <a-card title="软件更新" class="settings-card">
      <div class="update-toolbar">
        <span class="muted">当前版本：v{{ updateState?.currentVersion || '—' }}</span>
        <a-tag :color="updateState?.status === 'error' ? 'red' : updateState?.status === 'downloaded' ? 'green' : 'blue'">
          {{ updateStatusLabel(updateState?.status) }}
        </a-tag>
      </div>
      <p v-if="updateState?.availableVersion">可更新至：v{{ updateState.availableVersion }}</p>
      <a-alert
        v-if="updateState?.status === 'unsupported'"
        type="info"
        show-icon
        message="当前版本不支持应用内更新，请从 GitHub Release 下载新版本。"
      />
      <pre v-if="updateState?.releaseNotes" class="release-notes">{{ visibleReleaseNotes(updateState.releaseNotes) }}</pre>
      <div v-if="updateState?.status === 'downloading'" class="update-progress">
        <a-progress :percent="updateState.progressPercent ?? 0" status="active" />
        <span class="muted">{{ updateProgressText(updateState) }}</span>
      </div>
      <a-alert
        v-if="updateState?.status === 'installing'"
        type="info"
        show-icon
        message="即将重启并启动安装程序，安装进度将在系统安装窗口中显示。"
      />
      <a-space>
        <a-button
          :loading="updateState?.status === 'checking'"
          :disabled="updateState?.status === 'downloading' || updateState?.status === 'installing'"
          @click="checkForUpdates"
        >检查更新</a-button>
        <a-button
          v-if="['available', 'downloading'].includes(updateState?.status)"
          type="primary"
          :loading="updateState?.status === 'downloading'"
          :disabled="updateState?.status === 'downloading'"
          @click="downloadUpdate"
        >{{ updateState?.status === 'downloading' ? '正在下载更新' : '下载更新' }}</a-button>
        <a-button
          v-if="['downloaded', 'installing'].includes(updateState?.status)"
          type="primary"
          :loading="updateState?.status === 'installing'"
          :disabled="updateState?.status === 'installing'"
          @click="installUpdate"
        >{{ updateState?.status === 'installing' ? '正在启动安装程序' : '重启并安装' }}</a-button>
      </a-space>
    </a-card>

    <a-card title="支持诊断" class="settings-card">
      <div class="diagnostics-toolbar">
        <span class="muted">仅包含版本、CLI 可用性与本地数据状态，不包含对话内容或路径。</span>
        <a-space>
          <a-button size="small" :loading="diagnosticsLoading" @click="loadDiagnostics">刷新</a-button>
          <a-button size="small" :loading="profileRechecking" @click="recheckProfiles">一键重新检查配置档案</a-button>
          <a-button size="small" type="link" @click="router.push('/profiles')">前往配置档案</a-button>
          <a-button size="small" type="primary" :loading="diagnosticsExporting" @click="exportDiagnostics">导出 JSON</a-button>
        </a-space>
      </div>
      <a-descriptions v-if="diagnostics" size="small" :column="1" bordered>
        <a-descriptions-item label="UCLI">{{ diagnostics.application.version }}</a-descriptions-item>
        <a-descriptions-item label="本地数据">{{ persistenceStatusLabel(diagnostics.persistence.status) }}</a-descriptions-item>
        <a-descriptions-item label="CLI">{{ diagnosticCliSummary }}</a-descriptions-item>
        <a-descriptions-item v-if="diagnostics.aiCliProfiles" label="配置档案">{{ diagnosticProfileSummary }}</a-descriptions-item>
      </a-descriptions>
    </a-card>

    <a-card title="关于" class="settings-card">
      <p>UCLI — 多 CLI 编排工作台</p>
      <p class="muted">集成 Claude Code、Codex、OpenCode 与 U-Code 的卡片式编排 GUI，提供三档权限管控与使用统计。</p>
    </a-card>
    <GatewayConfigDrawer
      v-model:open="gatewayDrawerOpen"
      @closed="onGatewayDrawerClosed"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, h, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import { useSettingsStore } from '../stores/settings.js'
import { useSessionsStore } from '../stores/sessions.js'
import { useGatewayStore } from '../stores/gateway.js'
import GatewayConfigDrawer from '../components/gateway/GatewayConfigDrawer.vue'
import { getAllBindings, getBinding, formatKeys, eventToKeys } from '../keybindings.js'
import { ipc } from '../ipc.js'
import { formatCliDiagnosticSummary, persistenceStatusLabel, profileDiagnosticSummary } from '../diagnosticsPresentation.js'
import { updateProgressText, updateStatusLabel, visibleReleaseNotes } from '../updatePresentation.js'
import {
  gatewayPhaseLabel,
  gatewayTargetLabel,
  gatewayTimeLabel
} from '../gatewayPresentation.js'

const settings = useSettingsStore()
const sessions = useSessionsStore()
const gateway = useGatewayStore()
const route = useRoute()
const router = useRouter()
const gatewayDrawerOpen = ref(false)
const gatewayTrigger = ref(null)
const adapters = ref([])
const local = ref({
  defaultAdapter: 'claude', defaultTier: 'safety-rules', defaultCwd: '', codexConfigDir: '', language: 'zh-CN',
  autoEnabled: false,
  autoPeriods: { day: true, week: true, month: false, quarter: false, year: false },
  defaultExecutorId: null,
  defaultProfileId: null,
  defaultModel: null,
  firstEnableDisclosureAcceptedAt: null,
  automaticCallLimit: 20
})
const cliTools = ref([])
const summaryProfiles = ref([])
const detecting = ref(false)
const runningTool = ref('')
const lastCliResult = ref(null)
const diagnostics = ref(null)
const diagnosticsLoading = ref(false)
const diagnosticsExporting = ref(false)
const profileRechecking = ref(false)
const updateState = ref(null)
let stopUpdateListener = null
const codexRuntime = ref(null)
let stopCodexRuntimeListener = null
const lastCliOutput = computed(() => {
  const result = lastCliResult.value
  if (!result) return ''
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
})
const diagnosticCliSummary = computed(() => formatCliDiagnosticSummary(diagnostics.value?.cliTools || []))
const diagnosticProfileSummary = computed(() => profileDiagnosticSummary(diagnostics.value?.aiCliProfiles || {}))
const managedSummaryProfile = (profile, executorId) =>
  executorId === 'claude' &&
  profile?.adapterId === executorId &&
  profile?.kind === 'managed' &&
  profile?.status === 'ready' &&
  ['api_key', 'bearer'].includes(profile?.connectionMode || profile?.config?.connectionMode)
const summaryProfileUsable = (profile, tool) =>
  managedSummaryProfile(profile, tool?.id) || (
    tool?.summaryExecutorAvailable === true &&
    tool?.id === 'claude' &&
    profile?.adapterId === tool.id &&
    profile?.kind === 'reference' &&
    profile?.status === 'ready' &&
    (profile?.connectionMode || profile?.config?.connectionMode) === 'subscription'
  )
const summaryExecutorUsable = (tool, profileId = null, allowAnyManaged = false) => {
  if (!tool?.installed || tool.safeForSummary !== true) return false
  if (tool.summaryExecutorAvailable === true) return !profileId || summaryProfiles.value.some(profile =>
    profile.id === profileId && summaryProfileUsable(profile, tool))
  return summaryProfiles.value.some(profile =>
    managedSummaryProfile(profile, tool.id) &&
    (allowAnyManaged || profile.id === profileId))
}
const summaryExecutorOptions = computed(() => cliTools.value.filter(tool =>
  summaryExecutorUsable(tool, null, true)
))
const summaryProfileOptions = computed(() => summaryProfiles.value.filter(profile =>
  summaryProfileUsable(
    profile,
    cliTools.value.find(tool => tool.id === local.value.defaultExecutorId)
  )
))
const summaryModelOptions = computed(() => {
  const adapter = adapters.value.find(item => item.id === local.value.defaultExecutorId)
  return Array.isArray(adapter?.models) ? adapter.models.map(item => typeof item === 'string' ? item : item.id).filter(Boolean) : []
})

onMounted(async () => {
  stopUpdateListener = ipc.on('update:state', (state) => { updateState.value = state })
  stopCodexRuntimeListener = ipc.onCodexRuntime((snapshot) => { codexRuntime.value = snapshot })
  await Promise.all([settings.load(), sessions.init(), gateway.init(), loadCliTools(), loadSummaryProfiles(), loadDiagnostics(), loadUpdateState(), loadCodexRuntime()])
  adapters.value = sessions.adapters
  local.value = { ...local.value, ...settings.$state }
})

onUnmounted(() => {
  stopUpdateListener?.()
  stopCodexRuntimeListener?.()
})

watch(
  () => route.query.panel,
  (panel) => { gatewayDrawerOpen.value = panel === 'gateway' },
  { immediate: true }
)

function openGatewayDrawer() {
  router.push({ name: 'settings', query: { ...route.query, panel: 'gateway' } })
}

function onGatewayDrawerClosed() {
  const query = { ...route.query }
  delete query.panel
  router.replace({ name: 'settings', query })
  nextTick(() => gatewayTrigger.value?.$el?.focus?.())
}

async function loadCliTools() {
  detecting.value = true
  try {
    cliTools.value = await ipc.listCliTools()
  } catch (e) {
    message.error('CLI 检测失败：' + (e?.message || e))
  } finally {
    detecting.value = false
  }
}

async function loadSummaryProfiles() {
  try {
    const state = await ipc.getAiCliProfileState()
    summaryProfiles.value = state?.profiles || []
  } catch {
    summaryProfiles.value = []
  }
}

async function loadDiagnostics() {
  diagnosticsLoading.value = true
  try {
    diagnostics.value = await ipc.getDiagnostics()
  } catch (e) {
    message.error('读取诊断信息失败：' + (e?.message || e))
  } finally {
    diagnosticsLoading.value = false
  }
}

async function loadUpdateState() {
  try {
    updateState.value = await ipc.getUpdateState()
  } catch {
    message.error('读取更新状态失败')
  }
}

async function runUpdateAction(action, fallbackMessage) {
  try {
    updateState.value = await action()
  } catch {
    message.error(fallbackMessage)
  }
}

function checkForUpdates() {
  return runUpdateAction(() => ipc.checkForUpdates(), '检查更新失败')
}

function downloadUpdate() {
  return runUpdateAction(() => ipc.downloadUpdate(), '下载更新失败')
}

async function installUpdate() {
  try {
    const started = await ipc.installUpdate()
    if (!started) message.error('更新尚未准备就绪')
  } catch {
    message.error('启动安装失败')
  }
}

async function exportDiagnostics() {
  diagnosticsExporting.value = true
  try {
    const result = await ipc.exportDiagnostics()
    if (!result.canceled) message.success('诊断报告已导出')
  } catch (e) {
    message.error('导出诊断报告失败：' + (e?.message || e))
  } finally {
    diagnosticsExporting.value = false
  }
}

function confirmCliAction(item, action) {
  const command = action === 'install' ? item.installCommand : item.upgradeCommand
  const label = action === 'install' ? '安装' : '升级'
  Modal.confirm({
    title: `${label} ${item.displayName}？`,
    content: h('div', [
      h('p', 'UCLI 将在本机执行以下官方命令：'),
      h('code', { class: 'confirm-command' }, command)
    ]),
    okText: `确认${label}`,
    cancelText: '取消',
    async onOk() {
      runningTool.value = `${item.id}:${action}`
      lastCliResult.value = null
      try {
        const result = await ipc.runCliToolAction(item.id, action)
        lastCliResult.value = result
        const index = cliTools.value.findIndex((tool) => tool.id === item.id)
        if (index >= 0) cliTools.value[index] = result.status
        if (result.ok) message.success(`${item.displayName} ${label}完成`)
        else message.error(`${item.displayName} ${label}失败`)
      } catch (e) {
        message.error(`${label}失败：` + (e?.message || e))
      } finally {
        runningTool.value = ''
      }
    }
  })
}

async function pickDir() {
  const dir = await ipc.pickDirectory()
  if (dir) local.value.defaultCwd = dir
}

async function recheckProfiles() {
  profileRechecking.value = true
  try {
    const result = await ipc.reconcileAiCliProfiles()
    await loadDiagnostics()
    message.success(result.recovered?.length ? `已恢复 ${result.recovered.length} 个配置档案` : '配置档案检查完成')
  } catch (e) {
    message.error('重新检查配置档案失败：' + (e?.message || e))
  } finally {
    profileRechecking.value = false
  }
}

async function loadCodexRuntime() {
  try {
    codexRuntime.value = await ipc.getCodexRuntime()
  } catch {
    codexRuntime.value = null
  }
}

async function pickCodexConfigDir() {
  const dir = await ipc.pickDirectory()
  if (dir) local.value.codexConfigDir = dir
}

async function save() {
  try {
    await settings.save(local.value)
    message.success('设置已保存')
  } catch (error) {
    message.error(error?.message || '设置保存失败')
  }
}

function onSummaryAutoChange(enabled) {
  if (!enabled) {
    local.value.autoEnabled = false
    return
  }
  const executor = cliTools.value.find(tool => tool.id === local.value.defaultExecutorId)
  if (!summaryExecutorUsable(executor, local.value.defaultProfileId)) {
    local.value.autoEnabled = false
    message.warning('请先选择一个已安装的默认 AI CLI')
    return
  }
  if (local.value.firstEnableDisclosureAcceptedAt) {
    local.value.autoEnabled = true
    return
  }
  Modal.confirm({
    title: '开启自动工作总结？',
    content: '自动总结会把所选会话材料通过配置的 CLI/Provider 发送给对应 AI 服务，并可能产生费用。',
    okText: '接受并开启',
    cancelText: '取消',
    onOk() {
      local.value.firstEnableDisclosureAcceptedAt = Date.now()
      local.value.autoEnabled = true
    },
    onCancel() {
      local.value.autoEnabled = false
    }
  })
}

function onSummaryExecutorChange() {
  local.value.defaultProfileId = null
  local.value.defaultModel = null
  const executor = cliTools.value.find(tool => tool.id === local.value.defaultExecutorId)
  if (local.value.autoEnabled && !summaryExecutorUsable(executor, local.value.defaultProfileId)) {
    local.value.autoEnabled = false
  }
}

// --- Keybinding config ---
const bindingsList = computed(() => {
  const all = getAllBindings()
  const overrides = settings.keybindings || {}
  return all.map(b => {
    const binding = getBinding(b.id, overrides)
    return {
      ...b,
      display: binding ? formatKeys(binding.keys) : '(已禁用)',
      overridden: Object.prototype.hasOwnProperty.call(overrides, b.id)
    }
  })
})

const captureVisible = ref(false)
const captureTarget = ref(null)
const capturedKeys = ref(null)
const capturedDisplay = ref('')
const captureRef = ref(null)

function startCapture(binding) {
  captureTarget.value = binding
  capturedKeys.value = null
  capturedDisplay.value = ''
  captureVisible.value = true
  nextTick(() => captureRef.value?.focus())
}

function onCaptureKey(event) {
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') { cancelCapture(); return }
  if (event.key === 'Enter' && !capturedKeys.value) return
  capturedKeys.value = eventToKeys(event)
  if (captureTarget.value?.id === 'session.addPane') capturedKeys.value.key = null
  capturedDisplay.value = formatKeys(capturedKeys.value)
}

function clearCapture() {
  capturedKeys.value = { disabled: true }
  capturedDisplay.value = '(已禁用)'
  nextTick(() => captureRef.value?.focus())
}

async function saveCapture() {
  if (!captureTarget.value) return
  const id = captureTarget.value.id
  const keybindings = { ...(settings.keybindings || {}) }
  if (capturedKeys.value) {
    keybindings[id] = capturedKeys.value
  }
  await settings.save({ keybindings })
  message.success('快捷键已保存')
  captureVisible.value = false
}

function cancelCapture() {
  captureVisible.value = false
  captureTarget.value = null
  capturedKeys.value = null
}

async function resetBinding(id) {
  const keybindings = { ...(settings.keybindings || {}) }
  delete keybindings[id]
  await settings.save({ keybindings })
  message.success('快捷键已重置')
}
</script>

<style scoped>
.settings { max-width: 820px; }
.settings-card { margin-bottom: 14px; }
.gateway-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.muted { color: #8c8c8c; }
.cli-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cli-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cli-path { color: #8c8c8c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cli-error { color: #bfbfbf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diagnostics-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.update-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.update-progress { margin: 12px 0; }
.update-progress .muted { display: block; margin-top: 6px; font-size: 12px; }
.release-notes { margin: 12px 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 12px; }
.result-command, :global(.confirm-command) { font-family: 'Cascadia Code', Consolas, monospace; }
.result-command { margin-bottom: 6px; color: #262626; }
.result-output { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 12px; }
.capture-box {
  border: 2px dashed #d9d9d9; border-radius: 8px; padding: 20px; text-align: center;
  font-size: 18px; font-family: 'Cascadia Code', Consolas, monospace; cursor: text;
  outline: none; user-select: none; background: #fafafa; min-height: 60px;
  display: flex; align-items: center; justify-content: center; color: #595959;
}
.capture-box:focus { border-color: #1677ff; background: #fff; }
</style>
