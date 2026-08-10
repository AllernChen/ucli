<template>
  <a-dropdown :trigger="['click']" :disabled="pendingAction !== ''">
    <a-button
      type="text"
      size="small"
      aria-label="会话操作"
      title="会话操作"
      :loading="pendingAction !== ''"
      @click.stop
    >
      <MoreOutlined /> 会话操作
    </a-button>
    <template #overlay>
      <a-menu class="maintenance-menu" @click="handleAction">
        <a-menu-item key="interrupt" :disabled="!view.canInterrupt || pendingAction !== ''">
          <div class="action-title">中断当前任务</div>
          <div class="action-help">只中断当前任务，CLI 进程继续运行</div>
        </a-menu-item>
        <a-menu-item key="stop" :disabled="!view.canStop || pendingAction !== ''">
          <div class="action-title">停止进程</div>
          <div class="action-help">停止整个 CLI 进程，会话转为离线</div>
        </a-menu-item>
        <a-menu-item key="restart" :disabled="!view.canRestart || pendingAction !== ''">
          <div class="action-title">重启会话</div>
          <div class="action-help">停止现有进程后恢复同一会话</div>
        </a-menu-item>
        <a-menu-divider />
        <a-menu-item key="remove" danger :disabled="!view.canRemove || pendingAction !== ''">
          <div class="action-title">移除 UCLI 记录</div>
          <div class="action-help">保留原生 CLI 历史与用量统计</div>
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<script setup>
import { computed, ref } from 'vue'
import { MoreOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'

import { deriveSessionMaintenanceState } from '../sessionMaintenancePresentation.js'
import { useSessionsStore } from '../stores/sessions.js'

const props = defineProps({
  sessionId: { type: String, required: true }
})
const emit = defineEmits(['removed'])

const sessions = useSessionsStore()
const session = computed(() => sessions.byId(props.sessionId) || null)
const view = computed(() => deriveSessionMaintenanceState(session.value || {}))
const pendingAction = ref('')

async function runAction(action, operation, successText) {
  if (!session.value || pendingAction.value) return
  pendingAction.value = action
  try {
    await operation(session.value.id)
    if (successText) message.success(successText)
  } catch (error) {
    message.error(`${actionLabel(action)}失败：${error?.message || error}`)
  } finally {
    pendingAction.value = ''
  }
}

function actionLabel(action) {
  return ({
    interrupt: '中断任务',
    stop: '停止进程',
    restart: '重启会话',
    remove: '移除会话'
  })[action] || '会话操作'
}

function interruptSession() {
  if (!view.value.canInterrupt) return
  return runAction(
    'interrupt',
    (sessionId) => sessions.interrupt(sessionId),
    '已发送中断信号，CLI 进程继续运行'
  )
}

function stopSession() {
  if (!view.value.canStop) return
  return runAction('stop', (sessionId) => sessions.stop(sessionId), '进程已停止，会话已离线')
}

function restartSession() {
  if (!view.value.canRestart) return
  const shouldStopFirst = view.value.stopBeforeRestart
  return runAction('restart', async (sessionId) => {
    if (shouldStopFirst) await sessions.stop(sessionId)
    await sessions.restart(sessionId)
  }, '会话正在重启')
}

async function removeSession() {
  if (!view.value.canRemove) return
  const sessionId = props.sessionId
  await runAction('remove', (id) => sessions.deleteSession(id), '会话已从 UCLI 移除')
  if (!sessions.byId(sessionId)) emit('removed', sessionId)
}

function confirmRemove() {
  Modal.confirm({
    title: '从 UCLI 移除该会话？',
    content: '原生 CLI 历史和用量统计会保留，此操作不会删除 CLI 的历史记录。',
    okText: '移除',
    okType: 'danger',
    cancelText: '取消',
    onOk: removeSession
  })
}

function handleAction({ key, domEvent }) {
  domEvent?.stopPropagation()
  if (key === 'interrupt') return interruptSession()
  if (key === 'stop') return stopSession()
  if (key === 'restart') return restartSession()
  if (key === 'remove') confirmRemove()
}
</script>

<style scoped>
.maintenance-menu { width: 280px; }
.action-title { font-weight: 500; }
.action-help { margin-top: 1px; color: #8c8c8c; font-size: 11px; line-height: 1.35; }
</style>
