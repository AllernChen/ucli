<template>
  <div class="preview-window">
    <div v-if="loading" class="preview-window-state"><a-spin /> 正在读取产物…</div>
    <div v-else-if="error" class="preview-window-state preview-error">{{ error }}</div>
    <a-empty v-else-if="missing" description="该会话没有可提取的产物" />
    <a-empty v-else-if="!artifacts.length" description="没有发现产物文件" />
    <a-tabs v-else v-model:activeKey="activeKey" class="preview-tabs">
      <a-tab-pane v-for="item in artifacts" :key="item.absolutePath" :tab="item.name">
        <ArtifactPreview :session-id="sessionId" :artifact="item" />
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import ipc from '../ipc.js'
import ArtifactPreview from '../components/ArtifactPreview.vue'

const route = useRoute()
const sessionId = computed(() => String(route.query.session || ''))
const loading = ref(true)
const missing = ref(false)
const error = ref('')
const artifacts = ref([])
const activeKey = ref('')

async function load() {
  loading.value = true
  missing.value = false
  error.value = ''
  artifacts.value = []
  activeKey.value = ''
  try {
    const result = await ipc.listArtifacts(sessionId.value)
    missing.value = Boolean(result.missing)
    artifacts.value = result.artifacts || []
    if (artifacts.value.length) activeKey.value = artifacts.value[0].absolutePath
  } catch (e) {
    error.value = e?.message || '读取产物失败'
  } finally {
    loading.value = false
  }
}

watch(sessionId, load, { immediate: true })
</script>

<style scoped>
.preview-window { height: 100vh; padding: 8px; box-sizing: border-box; }
.preview-window-state { display: flex; align-items: center; justify-content: center; height: 100%; }
.preview-error { color: #cf1322; }
.preview-tabs { height: 100%; }
.preview-tabs :deep(.ant-tabs-content-holder) { overflow: auto; }
</style>
