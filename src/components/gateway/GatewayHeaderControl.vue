<template>
  <div class="gateway-header-control">
    <a-tooltip :title="gatewayTooltip(gateway.runtime)">
      <a-switch
        :checked="gateway.runtime.desiredEnabled"
        :loading="switching"
        aria-label="Gateway 总开关"
        size="small"
        @change="toggleGateway"
      />
    </a-tooltip>
    <a-button
      type="text"
      size="small"
      class="gateway-status"
      aria-label="打开 Gateway 设置"
      @click="openSettings"
    >
      <a-badge :status="badgeStatus" />
      {{ gatewayPhaseLabel(gateway.runtime.phase) }}
    </a-button>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'

import {
  gatewayPhaseLabel,
  gatewayTooltip
} from '../../gatewayPresentation.js'
import { useGatewayStore } from '../../stores/gateway.js'

const gateway = useGatewayStore()
const router = useRouter()
const switching = ref(false)
const badgeStatus = computed(() => ({
  connected: 'success',
  error: 'error',
  connecting: 'processing',
  waiting_binding: 'warning',
  reconnecting: 'warning'
}[gateway.runtime.phase] || 'default'))

onMounted(() => gateway.init().catch(() => {}))

function openSettings() {
  router.push({ name: 'settings', query: { panel: 'gateway' } })
}

async function toggleGateway(enabled) {
  switching.value = true
  try {
    await gateway.setDesiredEnabled(enabled)
  } catch (error) {
    if (
      error?.code === 'CONFIG_REQUIRED' ||
      error?.message?.includes('CONFIG_REQUIRED') ||
      error?.message?.includes('configuration is required')
    ) openSettings()
    else message.error(error?.message || 'Gateway 状态切换失败')
  } finally {
    switching.value = false
  }
}
</script>

<style scoped>
.gateway-header-control { display: inline-flex; align-items: center; gap: 4px; }
.gateway-status { padding-inline: 4px; color: #595959; }
</style>
