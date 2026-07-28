<template>
  <div class="settings">
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
        <a-form-item label="语言">
          <a-select v-model:value="local.language" style="width: 200px">
            <a-select-option value="zh-CN">简体中文</a-select-option>
            <a-select-option value="en">English</a-select-option>
          </a-select>
        </a-form-item>
        <a-button type="primary" @click="save">保存设置</a-button>
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

    <a-card title="关于" class="settings-card">
      <p>UCLI — 多 CLI 编排工作台</p>
      <p class="muted">集成 Claude Code、Codex 与 OpenCode 的卡片式编排 GUI，提供三档权限管控与使用统计。</p>
    </a-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, h } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { useSettingsStore } from '../stores/settings.js'
import { useSessionsStore } from '../stores/sessions.js'
import { getAllBindings, getBinding, formatKeys, eventToKeys } from '../keybindings.js'
import { ipc } from '../ipc.js'

const settings = useSettingsStore()
const sessions = useSessionsStore()
const adapters = ref([])
const local = ref({ defaultAdapter: 'claude', defaultTier: 'safety-rules', defaultCwd: '', language: 'zh-CN' })
const cliTools = ref([])
const detecting = ref(false)
const runningTool = ref('')
const lastCliResult = ref(null)
const lastCliOutput = computed(() => {
  const result = lastCliResult.value
  if (!result) return ''
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
})

onMounted(async () => {
  await Promise.all([settings.load(), sessions.init(), loadCliTools()])
  adapters.value = sessions.adapters
  local.value = { ...local.value, ...settings.$state }
})

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

async function save() {
  await settings.save(local.value)
  message.success('设置已保存')
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
.muted { color: #8c8c8c; }
.cli-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cli-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cli-path { color: #8c8c8c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cli-error { color: #bfbfbf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
