<template>
  <a-modal
    :open="open"
    title="确认连接服务端"
    ok-text="确认连接"
    cancel-text="取消"
    :ok-button-props="{ disabled: !canConfirm || connection.busy, loading: connection.busy }"
    @ok="confirm"
    @cancel="cancel"
  >
    <a-descriptions v-if="attempt" size="small" :column="1" bordered>
      <a-descriptions-item label="服务端">{{ attempt.serverOrigin }}</a-descriptions-item>
      <a-descriptions-item label="组织">{{ preview.organization?.name || '未知' }}</a-descriptions-item>
      <a-descriptions-item label="成员">{{ preview.account?.displayName || '未知' }}</a-descriptions-item>
      <a-descriptions-item label="链接状态">{{ link.status || '未知' }}</a-descriptions-item>
      <a-descriptions-item label="链接有效期">{{ dateLabel(link.expiresAt) }}</a-descriptions-item>
      <a-descriptions-item label="授权状态">{{ authorization.status || '未知' }}</a-descriptions-item>
      <a-descriptions-item label="授权有效期">{{ dateLabel(authorization.expiresAt) }}</a-descriptions-item>
      <a-descriptions-item label="服务器时间">{{ dateLabel(authorization.serverTime) }}</a-descriptions-item>
    </a-descriptions>
    <a-alert v-if="attempt && !canConfirm" type="warning" show-icon message="当前链接或授权不可确认" />
  </a-modal>
</template>

<script setup>
import { computed } from 'vue'
import { message } from 'ant-design-vue'

import { useServerConnectionStore } from '../../stores/serverConnection.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['update:open'])
const connection = useServerConnectionStore()
const attempt = computed(() => connection.attempt)
const preview = computed(() => attempt.value?.preview || {})
const link = computed(() => preview.value.link || {})
const authorization = computed(() => preview.value.authorization || {})
const canConfirm = computed(() => link.value.status === 'AVAILABLE' && authorization.value.status === 'AVAILABLE')

function dateLabel(value) {
  if (!value) return '永久 / 未设置'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString()
}

async function confirm() {
  try {
    await connection.confirmAttempt()
    emit('update:open', false)
  } catch { message.error(connection.error?.message || '无法完成服务端连接') }
}

async function cancel() {
  try { await connection.cancelAttempt() } finally { emit('update:open', false) }
}
</script>
