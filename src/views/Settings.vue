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

    <a-card title="键盘快捷键" class="settings-card">
      <div class="muted" style="margin-bottom: 12px">点击快捷键组合可重新设置，点击重置恢复默认</div>
      <div class="shortcut-list">
        <div v-for="b in bindingList" :key="b.id" class="shortcut-item">
          <div class="shortcut-info">
            <span class="shortcut-name">{{ b.name }}</span>
            <span class="shortcut-context">{{ contextLabel(b.contexts) }}</span>
          </div>
          <div class="shortcut-actions">
            <a-button
              v-if="isOverridden(b.id)"
              size="small"
              type="link"
              class="shortcut-reset-btn"
              @mousedown.prevent="resetBinding(b.id)"
            >重置</a-button>
            <div
              :class="['shortcut-keys', { capturing: capturingId === b.id }]"
              tabindex="0"
              :data-bind-id="b.id"
              @mousedown.prevent="startCapture(b.id)"
              @keydown="onCaptureKeydown"
              @blur="cancelCapture"
            >
              {{ capturingId === b.id ? '按下新快捷键...' : formatKeys(b.effectiveKeys) }}
            </div>
          </div>
        </div>
      </div>
    </a-card>

    <a-card title="关于" class="settings-card">
      <p>UCLI — 多 CLI 编排工作台</p>
      <p class="muted">集成 Claude Code 与 Codex 的卡片式编排 GUI，提供三档权限管控与 token 统计。</p>
    </a-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, h, nextTick } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { useSettingsStore } from '../stores/settings.js'
import { useSessionsStore } from '../stores/sessions.js'
import { getAllBindings, formatKeys, getBinding, eventToKeys } from '../keybindings.js'
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

// --- Keybinding configuration ---
const capturingId = ref(null)

const bindingList = computed(() => {
  const overrides = settings.keybindings || {}
  return getAllBindings().map(b => ({
    ...b,
    effectiveKeys: getBinding(b.id, overrides).keys
  }))
})

function isOverridden(id) {
  return !!(settings.keybindings && id in settings.keybindings)
}

function contextLabel(contexts) {
  return (contexts || []).join('、')
}

function startCapture(id) {
  capturingId.value = id
  nextTick(() => {
    const el = document.querySelector(`[data-bind-id="${id}"]`)
    el?.focus()
  })
}

function onCaptureKeydown(event) {
  if (!capturingId.value) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    capturingId.value = null
    return
  }
  const keys = eventToKeys(event)
  if (!keys.key) return
  const keybindings = { ...(settings.keybindings || {}), [capturingId.value]: keys }
  settings.save({ keybindings })
  capturingId.value = null
}

function cancelCapture() {
  capturingId.value = null
}

function resetBinding(id) {
  const keybindings = { ...(settings.keybindings || {}) }
  delete keybindings[id]
  settings.save({ keybindings })
}

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

.shortcut-list { display: flex; flex-direction: column; gap: 2px; }
.shortcut-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 4px; border-radius: 6px; transition: background .12s;
}
.shortcut-item:hover { background: #fafafa; }
.shortcut-item.capturing { background: #e6f4ff; }
.shortcut-info { display: flex; flex-direction: column; gap: 2px; }
.shortcut-name { font-size: 13px; color: #262626; }
.shortcut-context { font-size: 11px; color: #8c8c8c; }
.shortcut-actions { display: flex; align-items: center; gap: 8px; }
.shortcut-reset-btn { font-size: 11px; padding: 0; }
.shortcut-keys {
  display: inline-flex; align-items: center; padding: 2px 10px;
  border: 1px solid #d9d9d9; border-radius: 4px; font-size: 12px;
  font-family: 'Cascadia Code', Consolas, monospace; cursor: pointer;
  min-width: 90px; justify-content: center; user-select: none;
  background: #fff; transition: border-color .12s, background .12s;
}
.shortcut-keys:hover { border-color: #1677ff; color: #1677ff; }
.shortcut-keys.capturing {
  border-color: #1677ff; background: #e6f4ff; color: #1677ff;
  outline: 2px solid #1677ff; outline-offset: 1px;
}
</style>
