<template>
  <div
    class="summary-task-card"
    :class="{ active }"
    role="button"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter="emit('select')"
  >
    <div class="task-card-top">
      <span class="task-card-title" :title="task.displayName">{{ task.displayName }}</span>
      <span class="task-card-adapter">{{ task.adapterId }}</span>
    </div>
    <div class="task-card-status">
      <a-spin v-if="task.status === 'starting' || task.status === 'running'" size="small" />
      <a-tag :color="status.color">{{ status.label }}</a-tag>
    </div>
    <div v-if="task.lastActivity" class="task-card-activity">{{ task.lastActivity }}</div>
    <div class="task-card-actions" @click.stop>
      <a-button size="small" type="link" @click="emit('open-chat')">查看对话</a-button>
      <a-popconfirm
        title="删除该任务卡片？"
        ok-text="删除"
        cancel-text="取消"
        @confirm="emit('remove')"
      >
        <a-button size="small" type="link" danger>删除</a-button>
      </a-popconfirm>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { taskStatusMeta } from './summaryTaskStatus.js'

const props = defineProps({
  task: { type: Object, required: true },
  active: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'open-chat', 'remove'])

const status = computed(() => taskStatusMeta(props.task.status))
</script>

<style scoped>
.summary-task-card {
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.summary-task-card:hover {
  border-color: #1677ff;
}
.summary-task-card.active {
  border-color: #1677ff;
  box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.12);
}
.task-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.task-card-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-card-adapter {
  color: #8c8c8c;
  font-size: 12px;
  flex-shrink: 0;
}
.task-card-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.task-card-status .ant-tag {
  margin: 0;
}
.task-card-activity {
  margin: 2px 0 4px;
  color: #595959;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-card-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
</style>
