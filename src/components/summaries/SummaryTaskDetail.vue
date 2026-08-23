<template>
  <div v-if="task" class="summary-task-detail">
    <div class="detail-header">
      <span class="detail-name" :title="task.displayName">{{ task.displayName }}</span>
      <span class="detail-adapter">{{ task.adapterId }}</span>
      <a-tag :color="status.color">{{ status.label }}</a-tag>
      <div class="detail-header-actions">
        <a-button type="primary" @click="emit('open-chat')">查看对话</a-button>
      </div>
    </div>
    <a-alert
      v-if="task.error"
      style="margin-bottom: 12px"
      type="error"
      show-icon
      :message="errorText"
    />
    <div class="detail-body">
      <template v-if="task.status === 'starting' || task.status === 'running'">
        <div class="detail-spin-row">
          <a-spin size="small" />
          <span class="detail-step">{{ stepText }}</span>
        </div>
        <a-progress
          v-if="task.status === 'running'"
          :percent="100"
          :show-info="false"
          status="active"
        />
        <div v-if="task.lastActivity" class="detail-activity">{{ task.lastActivity }}</div>
        <div v-if="task.tokens" class="detail-tokens">
          输入 {{ task.tokens.input.toLocaleString() }} · 输出 {{ task.tokens.output.toLocaleString() }}
        </div>
      </template>
      <WorkLogReportView
        v-else-if="task.status === 'completed'"
        :work-log="artifact"
        @open-html="openHtml"
      />
      <a-empty
        v-else-if="task.status === 'failed' || task.status === 'interrupted'"
        :description="errorText"
      />
      <a-empty v-else description="等待任务开始…" />
    </div>
  </div>
  <a-empty v-else description="选择左侧任务查看详情" />
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ipc } from '../../ipc.js'
import WorkLogReportView from './WorkLogReportView.vue'
import { taskErrorText, taskStatusMeta, taskStepText } from './summaryTaskStatus.js'

const props = defineProps({
  task: { type: Object, default: null }
})
const emit = defineEmits(['open-chat'])

const workLogs = ref([])
const status = computed(() => taskStatusMeta(props.task?.status))
const stepText = computed(() => taskStepText(props.task?.status))
const errorText = computed(() => taskErrorText(props.task))

// 完成任务后从 workLogs 目录里挑出本次运行写出的产物（优先 Markdown，回退 HTML）。
const artifact = computed(() => {
  if (!props.task?.suggestedFileName) return null
  const htmlName = props.task.suggestedFileName.replace(/\.md$/i, '.html')
  return workLogs.value.find((entry) => entry.name === props.task.suggestedFileName) ||
    workLogs.value.find((entry) => entry.name === htmlName) ||
    null
})

async function loadWorkLogs() {
  try {
    workLogs.value = await ipc.listSummaryWorkLogs()
  } catch {
    workLogs.value = []
  }
}

watch(
  () => [props.task?.sessionId, props.task?.status],
  () => { void loadWorkLogs() },
  { immediate: true }
)

function openHtml(path) {
  return ipc.openPath(path)
}
</script>

<style scoped>
.summary-task-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 420px;
}
.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.detail-name {
  font-weight: 600;
  font-size: 14px;
}
.detail-adapter {
  color: #8c8c8c;
  font-size: 12px;
}
.detail-header-actions {
  margin-left: auto;
}
.detail-body {
  flex: 1;
  min-height: 0;
}
.detail-spin-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.detail-step {
  color: #595959;
}
.detail-activity,
.detail-tokens {
  margin-top: 10px;
  color: #8c8c8c;
  font-size: 12px;
}
</style>
