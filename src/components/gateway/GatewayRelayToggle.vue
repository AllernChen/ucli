<template>
  <a-tooltip :title="view.tooltip">
    <a-button
      type="text"
      size="small"
      class="gateway-relay-toggle"
      :class="[`tone-${view.tone}`, { 'is-relay-selected': view.selected }]"
      :loading="pending"
      :disabled="pending"
      :aria-pressed="view.selected"
      :aria-label="`${view.label}：${sessionName || '当前会话'}`"
      @click.stop="toggleRelay"
    >
      <GatewayChannelIcon :channel-type="gateway.configuration?.channelType || 'feishu'" />
      <span v-if="!compact">{{ view.label }}</span>
    </a-button>
  </a-tooltip>
</template>

<script setup>
import { computed } from 'vue'
import { message } from 'ant-design-vue'
import { deriveGatewayRelayControl } from '../../gatewayRelayPresentation.js'
import { useGatewayStore } from '../../stores/gateway.js'
import GatewayChannelIcon from './GatewayChannelIcon.vue'

const props = defineProps({
  sessionId: { type: String, required: true },
  compact: { type: Boolean, default: false }
})

const gateway = useGatewayStore()
const session = computed(() => gateway.relaySessionFor(props.sessionId))
const pending = computed(() => gateway.relayPendingFor(props.sessionId))
const sessionName = computed(() => session.value?.name || session.value?.sessionName || '')
const view = computed(() => deriveGatewayRelayControl({
  session: session.value,
  gatewayPhase: gateway.runtime.phase,
  pending: pending.value
}))

async function toggleRelay() {
  try {
    await gateway.setSessionRelayEnabled(props.sessionId, view.value.nextEnabled)
  } catch (error) {
    message.error(error?.message || '会话转发状态更新失败')
  }
}
</script>

<style scoped>
.gateway-relay-toggle { padding-inline: 4px; color: #bfbfbf; }
.tone-default { color: #bfbfbf; }
.gateway-relay-toggle.is-relay-selected.tone-blue { color: #1677ff; }
.gateway-relay-toggle.is-relay-selected.tone-green { color: #389e0d; }
.gateway-relay-toggle.is-relay-selected.tone-orange { color: #d46b08; }
.gateway-relay-toggle.is-relay-selected.tone-red { color: #cf1322; }
.gateway-relay-toggle:not(.is-relay-selected) :deep(.gateway-channel-icon) {
  filter: grayscale(1);
  opacity: .48;
}
</style>
