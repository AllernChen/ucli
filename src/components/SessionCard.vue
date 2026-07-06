<template>
  <a-card class="session-card" hoverable size="small" :class="{ waiting: isWaiting }" @click="$emit('open', session.id)">
    <template #title>
      <div class="card-title">
        <span class="icon">{{ session.icon }}</span>
        <span class="name">{{ session.displayName }}</span>
        <span :class="['status-badge', statusCls]">{{ statusText }}</span>
      </div>
    </template>
    <template #extra>
      <a-tag :color="tierColor">{{ tierLabel }}</a-tag>
    </template>

    <div class="cwd" :title="session.cwd">
      <FolderOpenOutlined /> {{ session.cwd || '(未设置目录)' }}
      <span v-if="session.startedAt" class="started-at">{{ fmtShort(session.startedAt) }}</span>
    </div>
    <div class="last-activity">{{ session.lastActivity || '空闲' }}</div>

    <div v-if="isWaiting" class="waiting-bar">
      <a-badge status="warning" /> 有操作待确认
    </div>

    <div class="card-footer">
      <span class="token-mini sid">{{ session.id.slice(0, 8) }}</span>
      <span class="token-mini">↑{{ session.stats.tokens.input.toLocaleString() }} ↓{{ session.stats.tokens.output.toLocaleString() }}</span>
      <span class="token-mini">{{ session.stats.turns }} 轮</span>
      <span v-if="session.stats.costUsd" class="token-mini">${{ session.stats.costUsd.toFixed(4) }}</span>
    </div>
  </a-card>
</template>

<script setup>
import { computed } from 'vue'
import { FolderOpenOutlined } from '@ant-design/icons-vue'

const props = defineProps({ session: { type: Object, required: true } })
defineEmits(['open'])

const isWaiting = computed(() => props.session.status === 'waiting')

const statusCls = computed(() => {
  const m = { running: 'status-running', idle: 'status-idle', waiting: 'status-waiting', starting: 'status-running', error: 'status-error', exited: 'status-exited', offline: 'status-exited' }
  return m[props.session.status] || 'status-idle'
})
const statusText = computed(() => {
  const m = { running: '运行中', idle: '空闲', waiting: '待确认', starting: '启动中', error: '错误', exited: '已退出', offline: '已离线' }
  return m[props.session.status] || props.session.status
})

const tierMap = {
  'always-agree': { label: '一直同意', color: 'red' },
  'safety-rules': { label: '安全规则', color: 'blue' },
  'ask-everything': { label: '逐次确认', color: 'orange' }
}
const tierLabel = computed(() => tierMap[props.session.tier]?.label || props.session.tier)
const tierColor = computed(() => tierMap[props.session.tier]?.color || 'default')
function fmtShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}
</script>

<style scoped>
.session-card { cursor: pointer; transition: box-shadow .15s; }
.session-card.waiting { border-color: #faad14; box-shadow: 0 0 0 2px rgba(250,173,20,.25); }
.card-title { display: flex; align-items: center; gap: 6px; }
.card-title .icon { font-size: 16px; }
.card-title .name { font-weight: 600; }
.card-title .status-badge { margin-left: auto; }
.cwd { font-size: 12px; color: #595959; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.started-at { font-size: 10px; color: #8c8c8c; flex-shrink: 0; }
.last-activity { font-size: 13px; color: #262626; min-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.waiting-bar { margin-top: 8px; padding: 4px 8px; background: #fffbe6; border-radius: 4px; font-size: 12px; color: #ad6800; }
.card-footer { margin-top: 10px; display: flex; justify-content: space-between; gap: 8px; border-top: 1px dashed #f0f0f0; padding-top: 8px; }
</style>
