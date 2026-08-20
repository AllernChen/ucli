<template>
  <a-drawer
    :open="open"
    :width="720"
    title="会话产物"
    placement="right"
    @close="emit('update:open', false)"
  >
    <template #extra>
      <a-button size="small" :disabled="!artifacts.length" @click="popOut">
        <ExportOutlined /> 弹出窗口
      </a-button>
    </template>

    <div v-if="loading" class="artifact-drawer-state"><a-spin size="small" /> 正在读取产物…</div>
    <div v-else-if="error" class="artifact-drawer-state artifact-error">{{ error }}</div>
    <a-empty v-else-if="missing" description="该会话没有可提取的产物" />
    <a-empty v-else-if="!artifacts.length" description="没有发现产物文件" />
    <div v-else class="artifact-drawer-body">
      <ul class="artifact-list">
        <li
          v-for="item in artifacts"
          :key="item.absolutePath"
          :class="['artifact-item', { active: selected && selected.absolutePath === item.absolutePath }]"
          @click="selected = item"
        >
          <span class="artifact-kind">{{ kindIcon(item.kind) }}</span>
          <span class="artifact-meta">
            <span class="artifact-name" :title="item.absolutePath">{{ item.name }}</span>
            <span class="artifact-path" :title="item.absolutePath">{{ item.path }}</span>
          </span>
          <a-button size="small" type="text" title="用系统程序打开" aria-label="用系统程序打开" @click.stop="openInSystem(item)">
            <ExportOutlined />
          </a-button>
        </li>
      </ul>
      <div class="artifact-preview-pane">
        <ArtifactPreview v-if="selected" :session-id="sessionId" :artifact="selected" />
        <a-empty v-else description="选择左侧产物预览" />
      </div>
    </div>
  </a-drawer>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ExportOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import ipc from '../ipc.js'
import ArtifactPreview from './ArtifactPreview.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  sessionId: { type: String, required: true }
})
const emit = defineEmits(['update:open'])

const loading = ref(false)
const missing = ref(false)
const error = ref('')
const artifacts = ref([])
const selected = ref(null)

function kindIcon(kind) {
  return kind === 'image' ? '🖼️'
    : kind === 'markdown' ? '📝'
      : kind === 'html' ? '🌐'
        : '📄'
}

async function load() {
  if (!props.open) return
  loading.value = true
  missing.value = false
  error.value = ''
  artifacts.value = []
  selected.value = null
  try {
    error.value = ''
    const result = await ipc.listArtifacts(props.sessionId)
    missing.value = Boolean(result.missing)
    artifacts.value = result.artifacts || []
    if (artifacts.value.length) selected.value = artifacts.value[0]
  } catch (e) {
    error.value = e?.message || '读取产物失败'
  } finally {
    loading.value = false
  }
}

async function openInSystem(item) {
  const result = await ipc.openPath(item.absolutePath)
  if (result && result !== '') message.error('无法用系统程序打开该文件')
}

function popOut() {
  emit('update:open', false)
  ipc.openArtifactWindow(props.sessionId).catch((e) =>
    ipc.log('error', 'openArtifactWindow failed', e?.message || e))
}

watch(() => [props.open, props.sessionId], load, { immediate: true })
</script>

<style scoped>
.artifact-drawer-state { color: #8c8c8c; padding: 24px; text-align: center; }
.artifact-error { color: #cf1322; }
.artifact-drawer-body { display: flex; gap: 12px; height: 100%; }
.artifact-list { flex: 0 0 240px; margin: 0; padding: 0; list-style: none; overflow-y: auto; border-right: 1px solid #f0f0f0; }
.artifact-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; border-radius: 6px; }
.artifact-item:hover { background: #f5f5f5; }
.artifact-item.active { background: #e6f4ff; }
.artifact-kind { flex-shrink: 0; }
.artifact-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.artifact-name { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifact-path { font-size: 10px; color: #bfbfbf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifact-preview-pane { flex: 1; min-width: 0; overflow: auto; border: 1px solid #f0f0f0; border-radius: 8px; padding: 12px; }
</style>
