<template>
  <a-card class="session-card" hoverable size="small" :class="{ waiting: isWaiting }" @click="$emit('open', session.id)">
    <template #title>
      <div class="card-title">
        <span class="icon">{{ session.icon }}</span>
        <span v-if="editingId !== session.id" class="name-wrap">
          <span class="name">{{ session.displayName }}</span>
          <EditOutlined class="name-edit-icon" @click.stop="startEdit" title="重命名" />
        </span>
        <a-input
          v-else
          ref="nameInputRef"
          v-model:value="editDraft"
          size="small"
          class="name-input"
          @click.stop
          @press-enter="saveEdit"
          @blur="saveEdit"
          @keydown.escape.prevent="cancelEdit"
        />
        <span :class="['status-badge', statusCls]">{{ statusText }}</span>
      </div>
    </template>
    <template #extra>
      <a-tag :color="tierColor">{{ tierLabel }}</a-tag>
    </template>

    <div class="cwd" :title="session.cwd">
      <FolderOpenOutlined /> {{ session.cwd || '(未设置目录)' }}
      <span v-if="session.startedAt" class="sep">·</span>
      <span v-if="session.startedAt" class="started-at">{{ fmtShort(session.startedAt) }}</span>
    </div>
    <div class="last-activity">{{ session.lastActivity || '空闲' }}</div>

    <div v-if="isWaiting" class="waiting-bar">
      <a-badge status="warning" /> 有操作待确认
    </div>

    <div class="card-footer">
      <span class="stat">↑{{ session.stats.tokens.input.toLocaleString() }}</span>
      <span class="stat">↓{{ session.stats.tokens.output.toLocaleString() }}</span>
      <span class="stat">{{ session.stats.turns }} 轮</span>
      <span v-if="session.stats.costAvailable === false" class="stat">费用不可用</span>
      <span v-else class="stat">${{ (session.stats.costUsd ?? 0).toFixed(4) }}</span>
    </div>
  </a-card>
</template>

<script setup>
import { computed, ref, nextTick } from 'vue'
import { FolderOpenOutlined, EditOutlined } from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'

const props = defineProps({ session: { type: Object, required: true } })
const emit = defineEmits(['open'])
const sessions = useSessionsStore()

const editingId = ref(null)
const editDraft = ref('')
const nameInputRef = ref(null)

function startEdit() {
  editingId.value = props.session.id
  editDraft.value = props.session.displayName || ''
  nextTick(() => nameInputRef.value?.focus())
}
async function saveEdit() {
  const id = editingId.value
  if (!id) return
  const name = editDraft.value.trim()
  if (name && name !== props.session.displayName) {
    await sessions.updateName(id, name)
  }
  editingId.value = null
}
function cancelEdit() {
  editingId.value = null
  editDraft.value = ''
}

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
.card-title .name-wrap { display: inline-flex; align-items: center; gap: 2px; }
.card-title .name { font-weight: 600; }
.card-title .name-edit-icon { font-size: 12px; color: #bfbfbf; cursor: pointer; opacity: 0; transition: opacity .15s; }
.card-title .name-wrap:hover .name-edit-icon { opacity: 1; }
.card-title .name-edit-icon:hover { color: #1677ff; }
.card-title .name-input { width: auto; min-width: 120px; max-width: 240px; font-weight: 600; }
.card-title .status-badge { margin-left: auto; }
.cwd { font-size: 12px; color: #8c8c8c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px; }
.sep { color: #d9d9d9; }
.started-at { font-size: 11px; color: #bfbfbf; flex-shrink: 0; }
.last-activity { font-size: 12px; color: #595959; min-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.waiting-bar { margin-top: 6px; padding: 3px 8px; background: #fffbe6; border-radius: 4px; font-size: 12px; color: #ad6800; }
.card-footer { margin-top: 6px; display: flex; gap: 10px; }
.stat { font-size: 11px; color: #8c8c8c; white-space: nowrap; }
</style>
