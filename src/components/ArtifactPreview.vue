<template>
  <div class="artifact-preview">
    <div v-if="loading" class="artifact-state"><a-spin size="small" /> 加载中…</div>
    <div v-else-if="error" class="artifact-state artifact-error">{{ error }}</div>
    <template v-else-if="content">
      <img
        v-if="content.kind === 'image'"
        class="artifact-image"
        :src="`data:${content.mimeType};base64,${content.base64}`"
        :alt="artifact.name"
      />
      <pre v-else-if="content.kind === 'text'" class="artifact-text">{{ content.text }}</pre>
      <div
        v-else-if="content.kind === 'markdown'"
        class="markdown-body"
        v-html="markdownHtml"
        @click="onLinkClick"
      ></div>
      <div v-else class="markdown-body" v-html="htmlSafe" @click="onLinkClick"></div>
    </template>
    <div v-else class="artifact-state">暂无内容</div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import ipc from '../ipc.js'
import { renderMarkdown } from '../markdown.js'
import { openSafeLink } from '../artifactLinks.js'

const props = defineProps({
  sessionId: { type: String, required: true },
  artifact: { type: Object, required: true }
})

const loading = ref(false)
const error = ref('')
const content = ref(null)

const markdownHtml = computed(() =>
  content.value?.kind === 'markdown' ? renderMarkdown(content.value.text) : '')
const htmlSafe = computed(() =>
  content.value?.kind === 'html'
    ? DOMPurify.sanitize(content.value.text, { USE_PROFILES: { html: true } })
    : '')

async function load() {
  const artifact = props.artifact
  if (!artifact?.absolutePath) { content.value = null; return }
  loading.value = true
  error.value = ''
  content.value = null
  try {
    content.value = await ipc.readArtifact(props.sessionId, artifact.absolutePath, { kind: artifact.kind })
  } catch (e) {
    error.value = e?.code === 'ARTIFACT_TOO_LARGE' ? '文件过大，无法预览'
      : e?.code === 'ARTIFACT_PATH_UNSAFE' ? '路径不安全，已拒绝预览'
        : e?.code === 'ARTIFACT_NOT_FOUND' ? '文件不存在'
          : '预览失败：' + (e?.message || e)
  } finally {
    loading.value = false
  }
}

function onLinkClick(event) { openSafeLink(event, ipc.openExternal) }

watch(() => [props.sessionId, props.artifact?.absolutePath], load, { immediate: true })
</script>

<style scoped>
.artifact-preview { height: 100%; overflow: auto; }
.artifact-state { color: #8c8c8c; padding: 16px; text-align: center; }
.artifact-error { color: #cf1322; }
.artifact-image { max-width: 100%; }
.artifact-text { white-space: pre-wrap; word-break: break-all; font-family: monospace; font-size: 12px; }
.markdown-body { line-height: 1.75; }
.markdown-body :deep(pre) { overflow: auto; padding: 12px; background: #f5f5f5; }
</style>
