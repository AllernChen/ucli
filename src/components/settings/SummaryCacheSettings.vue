<template>
  <a-card title="总结缓存与工作区" class="settings-card">
    <a-form layout="vertical">
      <a-form-item label="启用结果缓存">
        <a-switch v-model:checked="settings.cacheEnabled" />
      </a-form-item>
      <a-form-item label="缓存上限">
        <a-select v-model:value="settings.cacheMaxBytes">
          <a-select-option v-for="option in quotaOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="并行分析数">
        <a-select v-model:value="settings.mapConcurrency">
          <a-select-option v-for="value in [1, 2, 3]" :key="value" :value="value">{{ value }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="失败工作区保留天数">
        <a-select v-model:value="settings.failedWorkspaceRetentionDays">
          <a-select-option v-for="value in [1, 3, 7, 14, 30]" :key="value" :value="value">
            {{ value }} 天
          </a-select-option>
        </a-select>
      </a-form-item>
      <a-alert v-if="error" type="error" show-icon :message="error" />
      <a-descriptions v-if="stats" size="small" :column="2" bordered>
        <a-descriptions-item label="总占用">{{ formatBytes(stats.totalBytes) }}</a-descriptions-item>
        <a-descriptions-item label="缓存">{{ formatBytes(stats.cacheBytes) }}</a-descriptions-item>
        <a-descriptions-item label="工作区">{{ formatBytes(stats.workspaceBytes) }}</a-descriptions-item>
        <a-descriptions-item label="缓存条目">{{ stats.entries }}</a-descriptions-item>
        <a-descriptions-item label="失败工作区">{{ stats.failedWorkspaces }}</a-descriptions-item>
        <a-descriptions-item label="缓存配额">{{ formatBytes(stats.quotaBytes) }}</a-descriptions-item>
      </a-descriptions>
      <a-space style="margin-top: 12px">
        <a-button :loading="loading" @click="refresh">刷新占用</a-button>
        <a-button danger :loading="clearing" @click="confirmClear">清理缓存</a-button>
      </a-space>
      <a-checkbox v-model:checked="includeFailedWorkspaces" style="margin-left: 12px">
        同时清理失败或中断的工作区
      </a-checkbox>
    </a-form>
  </a-card>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { ipc } from '../../ipc.js'

defineProps({ settings: { type: Object, required: true } })

const quotaOptions = [
  { value: 268435456, label: '256 MiB' },
  { value: 536870912, label: '512 MiB' },
  { value: 1073741824, label: '1 GiB' },
  { value: 2147483648, label: '2 GiB' },
  { value: 5368709120, label: '5 GiB' }
]
const stats = ref(null)
const loading = ref(false)
const clearing = ref(false)
const error = ref('')
const includeFailedWorkspaces = ref(false)
let requestVersion = 0

function formatBytes(value) {
  const bytes = Number.isFinite(value) && value >= 0 ? value : 0
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = bytes
  let unit = -1
  do { amount /= 1024; unit += 1 } while (amount >= 1024 && unit < units.length - 1)
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`
}

async function refresh() {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const result = await ipc.getSummaryCacheStats()
    if (version === requestVersion) stats.value = result
  } catch (cause) {
    if (version === requestVersion) error.value = cause?.message || '读取缓存占用失败'
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function confirmClear() {
  Modal.confirm({
    title: '清理总结缓存？',
    content: '可选择同时清理失败或中断的工作区；已完成总结不会被删除。',
    okText: '仅清理缓存',
    cancelText: '取消',
    onOk: () => clear(includeFailedWorkspaces.value)
  })
}

async function clear(includeFailedWorkspaces) {
  clearing.value = true
  error.value = ''
  try {
    await ipc.clearSummaryCache({ includeFailedWorkspaces })
    message.success('总结存储已清理')
    await refresh()
  } catch (cause) {
    error.value = cause?.message || '清理总结存储失败'
  } finally {
    clearing.value = false
  }
}

onMounted(refresh)
</script>
