<template>
  <a-drawer :open="open" :width="720" placement="right" title="总结对话" @close="emit('update:open', false)">
    <div v-if="!sessionId" class="no-session">此报告没有关联的交互会话</div>
    <a-tabs v-else v-model:activeKey="tab" @change="onTabChange">
      <a-tab-pane key="history" tab="历史记录"><PaneHistory :session-id="sessionId" :active="open && tab === 'history'" /></a-tab-pane>
      <a-tab-pane key="terminal" tab="实时终端"><div v-if="tab === 'terminal'" class="drawer-terminal"><SessionTerminal :session-id="sessionId" ref="terminal" /></div></a-tab-pane>
    </a-tabs>
  </a-drawer>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { ipc } from '../../ipc.js'
import PaneHistory from '../PaneHistory.vue'
import SessionTerminal from '../SessionTerminal.vue'

const props = defineProps({ open: { type: Boolean, default: false }, reportId: { type: String, default: null }, sessionId: { type: String, default: null } })
const emit = defineEmits(['update:open'])
const tab = ref('history')
const terminal = ref(null)

watch(() => props.open, open => { if (open) tab.value = 'history' })
async function onTabChange(key) {
  tab.value = key
  if (key !== 'terminal' || !props.sessionId) return
  await nextTick()
  try { await ipc.attachTerminal(props.sessionId) } catch { /* terminal attachment is optional */ }
  terminal.value?.refit()
}
</script>

<style scoped>
.no-session { color:#8c8c8c; padding:16px 0; }
.drawer-terminal { min-height:320px; }
</style>
