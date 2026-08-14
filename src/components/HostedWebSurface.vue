<template>
  <div class="hosted-web-surface">
    <iframe
      v-if="view.status === 'ready'"
      class="hosted-web-frame"
      title="DeepSeek Harness Web"
      :src="view.url"
      sandbox="allow-same-origin allow-scripts"
      allow="clipboard-write"
      referrerpolicy="no-referrer"
    />
    <div v-else-if="view.status === 'starting' || view.status === 'stopping'" class="surface-state">
      {{ view.status === 'starting' ? '正在启动 DeepSeek Harness Web…' : '正在停止 DeepSeek Harness Web…' }}
    </div>
    <div v-else-if="view.status === 'error'" class="surface-state surface-error">
      DeepSeek Harness Web 不可用（{{ view.errorCode }}）
    </div>
    <div v-else class="surface-state">DeepSeek Harness Web 已停止</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { deriveHostedWebSurface } from '../sessionSurfacePresentation.js'

const props = defineProps({
  state: { type: Object, required: true }
})

const view = computed(() => deriveHostedWebSurface(props.state))
</script>

<style scoped>
.hosted-web-surface,
.hosted-web-frame {
  width: 100%;
  height: 100%;
}

.hosted-web-frame {
  border: 0;
}

.surface-state {
  display: grid;
  height: 100%;
  place-items: center;
  color: var(--text-secondary);
}

.surface-error {
  color: var(--color-error);
}
</style>
