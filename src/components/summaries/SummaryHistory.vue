<template>
  <a-card title="版本历史" size="small">
    <a-list :data-source="versions" size="small">
      <template #renderItem="{ item }">
        <a-list-item @click="$emit('select', item.id)">
          <template #actions>
            <a-tag v-if="item.isCurrent" color="blue">当前版本</a-tag>
            <a-button v-if="item.status === 'completed' && !item.isCurrent" size="small" @click.stop="$emit('set-current', item.id)">设为当前版本</a-button>
            <a-button v-if="['failed', 'interrupted', 'cancelled'].includes(item.status)" size="small" @click.stop="$emit('retry', item)">重试（新版本）</a-button>
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
defineEmits(['select', 'set-current', 'retry'])

function statusMeta(report) { return summaryTaskStatusMeta(report, props.progress[report.id] || null) }
</script>
