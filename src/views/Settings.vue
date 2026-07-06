<template>
  <div class="settings">
    <a-card title="默认设置" style="max-width: 640px">
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

    <a-card title="关于" style="max-width: 640px; margin-top: 14px">
      <p>UCLI — 多 CLI 编排工作台</p>
      <p class="muted">集成 Claude Code 与 Codex 的卡片式编排 GUI，提供三档权限管控与 token 统计。</p>
    </a-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import { useSettingsStore } from '../stores/settings.js'
import { useSessionsStore } from '../stores/sessions.js'
import { ipc } from '../ipc.js'

const settings = useSettingsStore()
const sessions = useSessionsStore()
const adapters = ref([])
const local = ref({ defaultAdapter: 'claude', defaultTier: 'safety-rules', defaultCwd: '', language: 'zh-CN' })

onMounted(async () => {
  await Promise.all([settings.load(), sessions.init()])
  adapters.value = sessions.adapters
  local.value = { ...local.value, ...settings.$state }
})

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
.muted { color: #8c8c8c; }
</style>
