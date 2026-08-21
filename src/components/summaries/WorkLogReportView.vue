<template>
  <a-card v-if="workLog" class="worklog-report">
    <template #title>{{ workLog.name }}</template>
    <template #extra>
      <a-tag :color="workLog.kind === 'html' ? 'geekblue' : 'green'">
        {{ workLog.kind === 'html' ? 'HTML' : 'Markdown' }}
      </a-tag>
    </template>
    <a-descriptions v-if="workLog.mtime" size="small" :column="1">
      <a-descriptions-item label="修改时间">{{ new Date(workLog.mtime).toLocaleString() }}</a-descriptions-item>
    </a-descriptions>
    <a-alert
      v-if="error"
      style="margin-top:12px"
      type="error"
      show-icon
      :message="error"
    />
    <div v-if="loading" class="loading"><a-spin size="small" /> 正在读取…</div>
    <article
      v-else-if="content && workLog.kind === 'markdown'"
      class="markdown-body"
      v-html="safeHtml"
      @click="handleReportLink"
    />
    <div v-else-if="content && workLog.kind === 'html'" class="html-preview">
      <iframe
        class="html-frame"
        :srcdoc="htmlSafe"
        sandbox="allow-same-origin"
        title="HTML 预览"
      ></iframe>
      <div class="html-preview-actions">
        <a-button type="primary" size="small" @click="$emit('open-html', workLog.path)">在浏览器中打开</a-button>
      </div>
    </div>
    <a-empty v-else description="报告内容尚未生成" />
  </a-card>
  <a-empty v-else description="请选择一份工作报告" />
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import ipc from '../../ipc.js'
import { openSummaryReportLink } from '../../summaryLinks.js'

const props = defineProps({ workLog: Object })
defineEmits(['open-html'])
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const content = ref('')
const loading = ref(false)
const error = ref('')
const safeHtml = computed(() => DOMPurify.sanitize(markdown.render(content.value || '')))
const htmlSafe = computed(() =>
  content.value && props.workLog?.kind === 'html'
    ? DOMPurify.sanitize(content.value, { USE_PROFILES: { html: true } })
    : '')

watch(() => props.workLog, async (workLog) => {
  content.value = ''
  error.value = ''
  if (!workLog || (workLog.kind !== 'markdown' && workLog.kind !== 'html')) return
  loading.value = true
  try {
    const result = await ipc.readSummaryWorkLog(workLog.name)
    content.value = result.content
  } catch (err) {
    error.value = err?.message || '无法读取报告'
  } finally {
    loading.value = false
  }
}, { immediate: true })

function handleReportLink(event) { openSummaryReportLink(event, ipc.openExternal) }
</script>

<style scoped>
.loading { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: #8c8c8c; }
.markdown-body { margin-top: 18px; line-height: 1.75; }
.markdown-body :deep(pre) { overflow: auto; padding: 12px; background: #f5f5f5; }
.markdown-body :deep(table) { border-collapse: collapse; }
.markdown-body :deep(td), .markdown-body :deep(th) { border: 1px solid #ddd; padding: 6px; }
.html-preview { margin-top: 14px; }
.html-frame { width: 100%; min-height: 420px; border: 1px solid #eee; border-radius: 6px; }
.html-preview-actions { margin-top: 8px; }
</style>
