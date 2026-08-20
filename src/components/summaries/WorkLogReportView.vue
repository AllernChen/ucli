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
    <a-empty v-else-if="workLog.kind === 'html'" description="HTML 报告使用浏览器打开">
      <template #extra>
        <a-button type="primary" @click="$emit('open-html', workLog.path)">在浏览器中打开</a-button>
      </template>
    </a-empty>
    <a-empty v-else description="报告内容尚未生成" />
  </a-card>
  <a-empty v-else description="请选择一份工作日志报告" />
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

watch(() => props.workLog, async (workLog) => {
  content.value = ''
  error.value = ''
  if (!workLog || workLog.kind !== 'markdown') return
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
</style>
