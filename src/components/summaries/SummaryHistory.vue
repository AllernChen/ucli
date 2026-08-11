<template>
  <a-card title="版本历史" size="small">
    <a-list :data-source="versions" size="small">
      <template #renderItem="{ item }">
        <a-list-item @click="$emit('select', item.id)">
          <template #actions>
            <a-button v-if="item.status === 'completed' && !item.isCurrent" size="small" @click.stop="$emit('set-current', item.id)">设为当前版本</a-button>
            <a-button v-if="['failed', 'interrupted'].includes(item.status)" size="small" @click.stop="$emit('retry', item)">重试</a-button>
          </template>
          <a-list-item-meta :title="`v${item.version} · ${item.status}`" :description="`${item.executorId || '—'} · ${new Date(item.createdAt).toLocaleString()}`" />
        </a-list-item>
      </template>
    </a-list>
  </a-card>
</template>
<script setup>
defineProps({ versions: { type: Array, default: () => [] } })
defineEmits(['select', 'set-current', 'retry'])
</script>
