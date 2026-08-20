<template>
  <a-drawer
    :open="open"
    :width="720"
    title="会话产物"
    placement="right"
    @close="emit('update:open', false)"
  >
    <template #extra>
      <a-button size="small" @click="popOut">
        <ExportOutlined /> 弹出窗口
      </a-button>
    </template>

    <ArtifactBrowser :session-id="sessionId" :open="open" />
  </a-drawer>
</template>

<script setup>
import { ExportOutlined } from '@ant-design/icons-vue'
import ipc from '../ipc.js'
import ArtifactBrowser from './ArtifactBrowser.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  sessionId: { type: String, required: true }
})
const emit = defineEmits(['update:open'])

function popOut() {
  emit('update:open', false)
  ipc.openArtifactWindow(props.sessionId).catch((e) =>
    ipc.log('error', 'openArtifactWindow failed', e?.message || e))
}
</script>
