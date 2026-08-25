<template>
  <a-list-item :class="{ selected }" @click="emit('select', report.id)">
    <a-list-item-meta>
      <template #title>
        <span>{{ report.title }}</span>
        <a-tag>v{{ report.version }}</a-tag>
        <a-tag v-if="report.isCurrent" color="blue">当前</a-tag>
      </template>
      <template #description>
        <a-tag :color="status.color">{{ status.label }}</a-tag>
        <span>{{ failed ? error.message : status.detail }}</span>
        <span v-if="failed">{{ error.action }}</span>
        <span>{{ report.executorId || '—' }} · {{ createdAt }}</span>
        <span v-if="report.taskNote">{{ report.taskNote }}</span>
      </template>
    </a-list-item-meta>
    <template #actions>
      <a-button :data-testid="`summary-task-edit-${report.id}`" aria-label="编辑总结任务" @click.stop="emit('edit', report)">编辑</a-button>
      <a-button v-if="retryable" aria-label="重试生成总结" @click.stop="emit('retry', report)">重试</a-button>
      <a-button aria-label="查看关联对话" @click.stop="emit('open-conversation', report)">查看对话</a-button>
      <a-popconfirm
        :title="deleteTitle"
        ok-text="确认删除"
        cancel-text="取消"
        :disabled="deleting"
        @confirm="confirmDelete"
      >
        <a-button
          danger
          :loading="deleting"
          :disabled="deleting"
          :data-testid="`summary-task-delete-${report.id}`"
          :title="deleteTitle"
          :aria-label="deleteTitle"
          @click.stop
        >删除</a-button>
      </a-popconfirm>
    </template>
  </a-list-item>
</template>

<script setup>
import { computed } from 'vue'
import { summaryTaskErrorMeta, summaryTaskStatusMeta } from '../../../shared/summaryTaskContracts.js'

const props = defineProps({
  report: { type: Object, required: true },
  progress: { type: Object, default: null },
  selected: Boolean,
  deleting: Boolean,
  deleteReport: Function
})
const emit = defineEmits(['select', 'edit', 'delete-report', 'retry', 'open-conversation'])
const status = computed(() => summaryTaskStatusMeta(props.report, props.progress))
const failed = computed(() => props.report.status === 'failed')
const error = computed(() => summaryTaskErrorMeta(props.report.errorText))
const active = computed(() => ['queued', 'running', 'awaiting_confirmation'].includes(props.report.status))
const retryable = computed(() => ['failed', 'interrupted', 'cancelled'].includes(props.report.status))
const deleteTitle = computed(() => active.value ? '取消并删除这个总结任务？' : '删除这个总结任务？')
const createdAt = computed(() => props.report.createdAt ? new Date(props.report.createdAt).toLocaleString() : '—')
function confirmDelete() {
  if (props.deleting) return Promise.resolve()
  if (props.deleteReport) return props.deleteReport(props.report.id)
  emit('delete-report', props.report.id)
}
</script>

<style scoped>
.selected { background:#e6f4ff; }
</style>
