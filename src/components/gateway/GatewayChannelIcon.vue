<template>
  <svg
    v-if="channelType === 'feishu'"
    class="gateway-channel-icon"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path fill="#2F88FF" d="M4.7 12.2c0-4.1 3.4-7.4 7.5-7.4 2.2 0 4.2 1 5.6 2.6l-4.3 2.1a3.1 3.1 0 0 0-4.4 3.9L5 15.2a7.4 7.4 0 0 1-.3-3Z" />
    <path fill="#22C7A8" d="M17.8 7.4a7.5 7.5 0 0 1 1.4 8.9 7.5 7.5 0 0 1-10.1 3L11 15a3.1 3.1 0 0 0 4.5-3.8l2.3-3.8Z" />
    <path fill="#5CB7FF" d="m9.1 19.3-1.3-4.8a3.1 3.1 0 0 0 3.2.5L15.5 17a7.5 7.5 0 0 1-6.4 2.3Z" />
  </svg>
  <span v-else class="gateway-channel-fallback">{{ channelType?.slice(0, 1).toUpperCase() || 'G' }}</span>
</template>

<script setup>
defineProps({
  channelType: { type: String, default: 'feishu' }
})
</script>

<style scoped>
.gateway-channel-icon { width: 1em; height: 1em; display: inline-block; flex-shrink: 0; }
.gateway-channel-fallback { font-size: .9em; font-weight: 700; line-height: 1; }
</style>
