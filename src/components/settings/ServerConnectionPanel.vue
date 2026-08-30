<template>
  <a-card title="服务端连接" class="settings-card server-connection-panel">
    <a-alert
      v-if="connection.error"
      type="error"
      show-icon
      closable
      :message="connection.error.message"
      @close="connection.error = null"
    />

    <a-descriptions size="small" :column="1" bordered>
      <a-descriptions-item label="连接状态">
        <a-tag :color="status.color">{{ status.label }}</a-tag>
        <span v-if="status.reason" class="muted">{{ status.reason }}</span>
      </a-descriptions-item>
      <a-descriptions-item v-if="connection.serverOrigin" label="服务端">{{ connection.serverOrigin }}</a-descriptions-item>
      <a-descriptions-item v-if="connection.organization" label="组织">{{ connection.organization.name }}</a-descriptions-item>
      <a-descriptions-item v-if="connection.account" label="账号">{{ connection.account.displayName }}</a-descriptions-item>
      <a-descriptions-item label="授权到期">{{ dateLabel(connection.authorizationExpiresAt) }}</a-descriptions-item>
      <a-descriptions-item label="最近同步">{{ dateLabel(connection.lastSyncedAt) }}</a-descriptions-item>
    </a-descriptions>

    <a-form layout="vertical" class="server-connection-form" @submit.prevent="submit">
      <a-form-item label="粘贴连接链接">
        <a-input
          v-model:value="linkInput"
          :disabled="connection.busy"
          placeholder="粘贴完整 /connect#link=… 链接"
          autocomplete="off"
        />
      </a-form-item>
      <div class="muted">便携版请使用粘贴入口：这是标准入口，始终可用。</div>
      <a-space>
        <a-button type="primary" html-type="submit" :loading="connection.busy" :disabled="!linkInput.trim()">连接 / 粘贴</a-button>
        <a-button :loading="connection.busy" :disabled="connection.status === 'disconnected'" @click="retry">重试</a-button>
        <a-button :loading="connection.busy" :disabled="connection.status === 'disconnected'" @click="sync">同步</a-button>
        <a-button danger :loading="connection.busy" :disabled="connection.status === 'disconnected'" @click="disconnectConfirmation">断开连接</a-button>
      </a-space>
    </a-form>
  </a-card>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Modal, message } from 'ant-design-vue'

import { useServerConnectionStore } from '../../stores/serverConnection.js'

const emit = defineEmits(['attempt'])
const connection = useServerConnectionStore()
const linkInput = ref('')

const STATE_PRESENTATION = Object.freeze({
  disconnected: { label: '未连接', color: 'default' },
  connecting: { label: '连接中', color: 'blue' },
  connected: { label: '已连接', color: 'green' },
  unreachable: { label: '暂时不可达', color: 'orange' },
  PERSISTENCE_PENDING: { label: '凭证尚未安全保存', color: 'orange', reason: '凭证尚未安全保存' },
  expiring: { label: '授权即将到期', color: 'orange' },
  disabled: { label: '授权已停用', color: 'red' },
  expired: { label: '授权已过期', color: 'red' },
  deleted: { label: '授权已删除', color: 'red' },
  account_inactive: { label: '账号或成员关系不可用', color: 'red' },
  org_inactive: { label: '组织不可用', color: 'red' }
})

const status = computed(() => {
  if (connection.reason === 'PERSISTENCE_PENDING') return STATE_PRESENTATION.PERSISTENCE_PENDING
  return STATE_PRESENTATION[connection.status] || STATE_PRESENTATION.disconnected
})

function dateLabel(value) {
  if (!value) return '永久 / 未设置'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString()
}

async function submit() {
  const input = linkInput.value
  linkInput.value = ''
  if (!input.trim()) return
  try {
    await connection.submitLink(input)
    emit('attempt')
  } catch {
    message.error(connection.error?.message || '无法读取连接链接')
  }
}

async function retry() {
  try { await connection.retryConnection() } catch { message.error(connection.error?.message || '无法重试服务端连接') }
}

async function sync() {
  try {
    await Promise.all([connection.syncConnection(), connection.syncModels(), connection.syncSkills()])
  } catch { message.error(connection.error?.message || '无法同步服务端连接') }
}

function disconnectConfirmation() {
  Modal.confirm({
    title: '断开服务端连接？',
    content: '这只会移除本机服务端凭证和在线目录，不会删除已安装的 Skills。',
    okText: '断开连接',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      try { await connection.disconnect() } catch { message.error(connection.error?.message || '无法断开服务端连接') }
    }
  })
}
</script>

<style scoped>
.server-connection-panel :deep(.ant-alert) { margin-bottom: 12px; }
.server-connection-form { margin-top: 16px; }
</style>
