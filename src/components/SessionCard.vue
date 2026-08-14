<template>
  <a-card class="session-card" hoverable size="small" :class="{ waiting: ucliWaiting }" @click="$emit('open', session.id)">
    <template #title>
      <div class="card-title">
        <span class="icon">{{ session.icon }}</span>
        <span class="name">{{ session.displayName }}</span>
        <span :class="['status-badge', statusCls]">{{ statusText }}</span>
      </div>
    </template>
    <template #extra>
      <a-badge :dot="view.needsAttention" status="warning">
        <a-button
          type="text"
          size="small"
          aria-label="配置会话"
          title="配置会话"
          @click.stop="configure"
        >
          <SettingOutlined />
        </a-button>
      </a-badge>
      <a-tag v-if="capabilities.ucliPermission" :color="tierColor">{{ tierLabel }}</a-tag>
    </template>

    <div class="cwd" :title="session.cwd">
      <FolderOpenOutlined /> {{ session.cwd || '(未设置目录)' }}
      <span v-if="session.startedAt" class="sep">·</span>
      <span v-if="session.startedAt" class="started-at">{{ fmtShort(session.startedAt) }}</span>
    </div>
    <div class="last-activity">{{ session.lastActivity || '空闲' }}</div>

    <div v-if="capabilities.ucliPermission && isWaiting" class="waiting-bar">
      <a-badge status="warning" /> 有操作待确认
    </div>

    <div v-if="capabilities.ucliStats" class="card-footer">
      <span class="stat">↑{{ session.stats.tokens.input.toLocaleString() }}</span>
      <span class="stat">↓{{ session.stats.tokens.output.toLocaleString() }}</span>
      <span class="stat">{{ session.stats.turns }} 轮</span>
      <span v-if="session.stats.costAvailable === false" class="stat">费用不可用</span>
      <span v-else class="stat">${{ (session.stats.costUsd ?? 0).toFixed(4) }}</span>
    </div>
    <div v-else-if="capabilities.web" class="native-owner">DSH 原生管理权限、历史与统计</div>
  </a-card>
</template>

<script setup>
import { computed } from 'vue'
import { FolderOpenOutlined, SettingOutlined } from '@ant-design/icons-vue'
import { deriveSessionConfigState } from '../sessionConfigPresentation.js'
import { deriveSessionCapabilityState } from '../sessionMaintenancePresentation.js'

const props = defineProps({ session: { type: Object, required: true } })
const emit = defineEmits(['open', 'configure'])
const view = computed(() => deriveSessionConfigState(props.session))
const capabilities = computed(() => deriveSessionCapabilityState(props.session))

function configure() {
  emit('configure', props.session.id)
}

const isWaiting = computed(() => props.session.status === 'waiting')
const ucliWaiting = computed(() => capabilities.value.ucliPermission && isWaiting.value)

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
.card-title .name { min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.card-title .status-badge { margin-left: auto; }
.cwd { font-size: 12px; color: #8c8c8c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px; }
.sep { color: #d9d9d9; }
.started-at { font-size: 11px; color: #bfbfbf; flex-shrink: 0; }
.last-activity { font-size: 12px; color: #595959; min-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.waiting-bar { margin-top: 6px; padding: 3px 8px; background: #fffbe6; border-radius: 4px; font-size: 12px; color: #ad6800; }
.card-footer { margin-top: 6px; display: flex; gap: 10px; }
.stat { font-size: 11px; color: #8c8c8c; white-space: nowrap; }
.native-owner { margin-top: 6px; color: #8c8c8c; font-size: 11px; }
</style>
