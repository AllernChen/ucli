<template>
  <a-drawer
    :open="open"
    :width="720"
    placement="right"
    :title="drawerTitle"
    @close="emit('update:open', false)"
  >
    <template #extra>
      <a-tag v-if="task" :color="status.color">{{ status.label }}</a-tag>
    </template>
    <div v-if="task" class="drawer-body">
      <a-tabs v-model:activeKey="tab" @change="onTabChange">
        <a-tab-pane key="history" tab="历史记录">
          <PaneHistory :session-id="task.sessionId" :active="open && tab === 'history'" />
        </a-tab-pane>
        <a-tab-pane key="terminal" tab="实时终端">
          <div v-if="tab === 'terminal'" class="drawer-terminal">
            <SessionTerminal :session-id="task.sessionId" ref="terminal" />
          </div>
        </a-tab-pane>
      </a-tabs>
    </div>
  </a-drawer>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { ipc } from '../../ipc.js'
import PaneHistory from '../PaneHistory.vue'
import SessionTerminal from '../SessionTerminal.vue'
import { taskStatusMeta } from './summaryTaskStatus.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  task: { type: Object, default: null }
})
const emit = defineEmits(['update:open'])

const tab = ref('history')
const terminal = ref(null)
const status = computed(() => taskStatusMeta(props.task?.status))
const drawerTitle = computed(() =>
  props.task ? `${props.task.displayName} · ${props.task.adapterId}` : '总结对话')

// 每次打开都回到「历史记录」，实时终端（v-if 挂载）随之卸载，下次进入时
// 以全新订阅重新挂载，避免跨打开残留旧输出。
watch(() => props.open, (open) => {
  if (open) tab.value = 'history'
})

async function onTabChange(key) {
  tab.value = key
  if (key !== 'terminal' || !props.task) return
  const sessionId = props.task.sessionId
  // 等 SessionTerminal 挂载并订阅 session:terminal-output 后，再回放历史 +
  // 重发 PTY 尺寸（修复 PTY 停在 120×40 的排版错乱）。
  await nextTick()
  try {
    await ipc.attachTerminal(sessionId)
  } catch (error) {
    ipc.log('warn', 'attachTerminal failed:', error?.message || String(error))
  }
  terminal.value?.refit()
}
</script>

<style scoped>
.drawer-body {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
  min-height: 360px;
}
.drawer-body :deep(.ant-tabs) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.drawer-body :deep(.ant-tabs-content-holder) {
  flex: 1;
  min-height: 0;
}
.drawer-body :deep(.ant-tabs-content),
.drawer-body :deep(.ant-tabs-tabpane) {
  height: 100%;
}
.drawer-terminal {
  height: 100%;
  min-height: 320px;
}
</style>
