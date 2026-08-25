<template>
  <a-list-item
    class="summary-task-card"
    :class="{ 'is-selected': selected }"
    role="option"
    :aria-selected="selected"
    tabindex="0"
    @click="selectCard"
    @keydown="handleCardKeydown"
  >
    <div class="summary-task-card__body">
      <div class="summary-task-card__title-row">
        <span class="summary-task-card__title">{{ report.title }}</span>
        <a-tag>v{{ report.version }}</a-tag>
        <a-tag v-if="report.isCurrent" color="blue">当前</a-tag>
      </div>
      <div class="summary-task-card__meta">
        <a-tag :color="status.color">{{ status.label }}</a-tag>
        <span>{{ report.executorId || '—' }} · {{ createdAt }}</span>
      </div>
      <div class="summary-task-card__detail">{{ status.detail }}</div>
      <div v-if="failed" class="summary-task-card__failure">{{ error.message }}</div>
      <div v-if="failed" class="summary-task-card__failure-action">{{ error.action }}</div>
      <div v-if="report.taskNote" class="summary-task-card__note">{{ report.taskNote }}</div>
      <div class="summary-task-card__actions">
        <a-button
          v-if="retryable"
          size="small"
          aria-label="重试生成总结"
          @click.stop="emit('retry', report)"
        >重试</a-button>
        <a-dropdown :trigger="['click']">
          <template #overlay>
            <a-menu @click="handleMenuClick">
              <a-menu-item key="edit">编辑任务</a-menu-item>
              <a-menu-item key="conversation">查看关联对话</a-menu-item>
              <a-menu-divider />
              <a-menu-item key="delete" danger>删除任务</a-menu-item>
            </a-menu>
          </template>
          <a-button size="small" aria-label="更多操作" @click.stop>更多</a-button>
        </a-dropdown>
      </div>
    </div>
  </a-list-item>
  <a-modal
    :open="deleteConfirmOpen"
    :title="deleteTitle"
    ok-text="确认删除"
    cancel-text="取消"
    :confirm-loading="deleteConfirmLoading"
    :mask-closable="!deleteConfirmLoading"
    :keyboard="!deleteConfirmLoading"
    :closable="!deleteConfirmLoading"
    :cancel-button-props="{ disabled: deleteConfirmLoading }"
    @ok="confirmDelete"
    @cancel="cancelDeleteConfirm"
  />
</template>

<script setup>
import { computed, ref } from 'vue'
import { summaryTaskErrorMeta, summaryTaskStatusMeta } from '../../../shared/summaryTaskContracts.js'

const props = defineProps({
  report: { type: Object, required: true },
  progress: { type: Object, default: null },
  selected: Boolean,
  deleting: Boolean,
  deleteReport: Function
})
const emit = defineEmits(['select', 'edit', 'delete-report', 'retry', 'open-conversation'])
const deleteConfirmOpen = ref(false)
const deletePending = ref(false)
const status = computed(() => summaryTaskStatusMeta(props.report, props.progress))
const failed = computed(() => props.report.status === 'failed')
const error = computed(() => summaryTaskErrorMeta(props.report.errorText))
const active = computed(() => ['queued', 'running', 'awaiting_confirmation'].includes(props.report.status))
const retryable = computed(() => ['failed', 'interrupted', 'cancelled'].includes(props.report.status))
const deleteTitle = computed(() => active.value ? '取消并删除这个总结任务？' : '删除这个总结任务？')
const createdAt = computed(() => props.report.createdAt ? new Date(props.report.createdAt).toLocaleString() : '—')
const deleteConfirmLoading = computed(() => deletePending.value || props.deleting)

function selectCard() {
  emit('select', props.report.id)
}

function handleCardKeydown(event) {
  if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
  event.preventDefault()
  selectCard()
}

function handleMenuClick({ key }) {
  if (key === 'edit') emit('edit', props.report)
  if (key === 'conversation') emit('open-conversation', props.report)
  if (key === 'delete' && !props.deleting) deleteConfirmOpen.value = true
}

async function confirmDelete() {
  if (deleteConfirmLoading.value) return
  deletePending.value = true
  try {
    if (props.deleteReport) await props.deleteReport(props.report.id)
    else emit('delete-report', props.report.id)
    deleteConfirmOpen.value = false
  } catch {
    // The parent owns deletion errors; preserve the confirmation for a retry.
  } finally {
    deletePending.value = false
  }
}

function cancelDeleteConfirm() {
  if (!deleteConfirmLoading.value) deleteConfirmOpen.value = false
}
</script>

<style scoped>
.summary-task-card {
  cursor: pointer;
  transition: background-color .2s ease, box-shadow .2s ease;
}

.summary-task-card:hover,
.summary-task-card.is-selected {
  background: #e6f4ff;
}

.summary-task-card:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: -2px;
}

.summary-task-card__body {
  min-width: 0;
  width: 100%;
}

.summary-task-card__title-row,
.summary-task-card__meta,
.summary-task-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.summary-task-card__title-row {
  align-items: flex-start;
}

.summary-task-card__title,
.summary-task-card__note {
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.summary-task-card__title {
  flex: 1;
  font-weight: 500;
}

.summary-task-card__meta,
.summary-task-card__detail,
.summary-task-card__failure,
.summary-task-card__failure-action,
.summary-task-card__note {
  margin-top: 4px;
  color: rgba(0, 0, 0, .65);
  font-size: 12px;
}

.summary-task-card__detail,
.summary-task-card__failure,
.summary-task-card__failure-action {
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.summary-task-card__failure {
  color: #cf1322;
}

.summary-task-card__actions {
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
