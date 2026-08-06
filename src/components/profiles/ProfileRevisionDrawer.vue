<template>
  <a-drawer :open="open" title="版本记录" width="480" @close="$emit('update:open', false)">
    <a-alert
      type="info"
      show-icon
      message="版本记录只包含非敏感配置。回滚不会恢复或更改 API Key。"
      style="margin-bottom: 16px"
    />
    <a-timeline v-if="revisions.length">
      <a-timeline-item v-for="revision in revisions" :key="revision.id">
        <div class="revision-heading">
          <strong>{{ revision.config?.name || '未命名版本' }}</strong>
          <span>{{ formatTime(revision.createdAt) }}</span>
        </div>
        <div class="revision-meta">
          {{ revision.config?.model || '默认模型' }} · {{ revision.reason === 'rollback' ? '回滚快照' : '修改前快照' }}
        </div>
        <a-button size="small" :loading="rollingBackId === revision.id" @click="$emit('rollback', revision.id)">
          回滚到此版本
        </a-button>
      </a-timeline-item>
    </a-timeline>
    <a-empty v-else description="还没有可回滚的版本" />
  </a-drawer>
</template>

<script setup>
defineProps({
  open: Boolean,
  revisions: { type: Array, default: () => [] },
  rollingBackId: { type: String, default: '' }
})
defineEmits(['update:open', 'rollback'])

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '未知时间'
}
</script>

<style scoped>
.revision-heading { display: flex; justify-content: space-between; gap: 12px; }
.revision-heading span, .revision-meta { color: #8c8c8c; font-size: 12px; }
.revision-meta { margin: 4px 0 8px; }
</style>
