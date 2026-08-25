<template>
  <a-card title="版本历史" size="small">
    <a-list :data-source="versions" size="small">
      <template #renderItem="{ item }">
        <a-list-item @click="$emit('select', item.id)">
          <template #actions>
            <a-button v-if="item.status === 'completed' && !item.isCurrent" size="small" @click.stop="$emit('set-current', item.id)">设为当前版本</a-button>
            <a-button v-if="['failed', 'interrupted', 'cancelled'].includes(item.status)" size="small" @click.stop="$emit('retry', item)">重试（新版本）</a-button>
            <a-button size="small" aria-label="编辑总结任务" @click.stop="$emit('edit', item)">编辑</a-button>
            <a-popconfirm
              :title="deleteTitle(item)"
              ok-text="确认删除"
              cancel-text="取消"
              @confirm="$emit('delete-report', item.id)"
            >
              <a-button danger size="small" :title="deleteTitle(item)" :aria-label="deleteTitle(item)" @click.stop>删除</a-button>
            </a-popconfirm>
          </template>
          <a-list-item-meta :title="`${item.title || `v${item.version}`} · v${item.version} · ${statusMeta(item).label}`" :description="`${statusMeta(item).detail} · ${item.executorId || '—'} · ${item.createdAt ? new Date(item.createdAt).toLocaleString() : '—'}`" />
        </a-list-item>
      </template>
    </a-list>
  </a-card>
</template>
<script setup>
import { summaryTaskStatusMeta } from '../../../shared/summaryTaskContracts.js'

const props = defineProps({ versions: { type: Array, default: () => [] }, progress: { type: Object, default: () => ({}) } })
defineEmits(['select', 'edit', 'set-current', 'retry', 'delete-report'])

function statusMeta(report) { return summaryTaskStatusMeta(report, props.progress[report.id] || null) }
function deleteTitle(report) { return ['queued', 'running', 'awaiting_confirmation'].includes(report.status) ? '取消并删除这个总结任务？' : '删除这个总结任务？' }
</script>
