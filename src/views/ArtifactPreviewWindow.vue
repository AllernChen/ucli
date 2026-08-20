<template>
  <div class="preview-window">
    <ArtifactBrowser :session-id="sessionId" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ArtifactBrowser from '../components/ArtifactBrowser.vue'

const route = useRoute()
const sessionId = computed(() => String(route.query.session || ''))
</script>

<style scoped>
.preview-window { height: 100vh; padding: 8px; box-sizing: border-box; }
</style>
