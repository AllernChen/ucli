<template>
  <a-card title="应用空间" class="settings-card">
    <template #extra>
      <a-button size="small" :loading="store.loading" @click="store.load()">刷新</a-button>
    </template>
    <a-alert v-if="store.error" type="error" show-icon :message="store.error.message" class="storage-alert" />
    <a-alert v-if="pendingRestart" type="info" show-icon message="清理已安排，请稍后重启 UCLI" class="storage-alert" />
    <a-descriptions v-if="store.snapshot" size="small" :column="2" bordered class="storage-totals">
      <a-descriptions-item label="应用总占用">{{ formatBytes(store.snapshot.totalBytes) }}</a-descriptions-item>
      <a-descriptions-item label="可清理">{{ formatBytes(store.snapshot.reclaimableBytes) }}</a-descriptions-item>
    </a-descriptions>
    <a-list :data-source="categories" :loading="store.loading && !store.snapshot">
      <template #renderItem="{ item: category }">
        <a-list-item>
          <template #actions>
            <a-tag v-if="category.clearMode === 'none'">受保护</a-tag>
            <a-button
              v-else size="small" danger
              :loading="store.clearingId === category.id"
              :disabled="Boolean(store.clearingId)"
              @click="confirmClear(category)"
            >{{ category.clearMode === 'restart' ? '下次启动清理' : '清理' }}</a-button>
          </template>
          <a-list-item-meta :title="presentation(category.id).label" :description="presentation(category.id).description" />
          <div class="storage-usage">
            <span>{{ usageText(category) }}</span>
            <span v-if="category.status !== 'unavailable'" class="muted">{{ category.itemCount }} 项</span>
            <a-tag v-if="category.status === 'partial'" color="orange">统计不完整</a-tag>
            <a-tag v-else-if="category.status === 'unavailable'" color="red">暂时无法读取</a-tag>
            <a-tag v-else-if="category.status === 'scheduled'" color="blue">等待重启</a-tag>
          </div>
        </a-list-item>
      </template>
    </a-list>
  </a-card>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { storageCategoryPresentation } from '../../storageCategories.js'
import { useStorageStore } from '../../stores/storage.js'

const store = useStorageStore()
const categories = computed(() => store.snapshot?.categories || [])
const pendingRestart = computed(() => (store.snapshot?.pendingRestart?.length || 0) > 0)
const presentation = storageCategoryPresentation

function formatBytes(value) {
  const bytes = Number.isSafeInteger(value) && value >= 0 ? value : 0
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unit = -1
  do { amount /= 1024; unit += 1 } while (amount >= 1024 && unit < units.length - 1)
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`
}

function usageText(category) {
  if (category.status === 'unavailable') return '无法统计'
  return `${category.status === 'partial' ? '至少 ' : ''}${formatBytes(category.bytes)}`
}

function confirmClear(category) {
  const restart = category.clearMode === 'restart'
  Modal.confirm({
    title: restart ? `安排清理${presentation(category.id).label}？` : `清理${presentation(category.id).label}？`,
    content: restart ? '此分类将在下次启动 UCLI 时、相关服务启动前清理。' : '可重新生成的数据将被移除，此操作无法撤销。',
    okText: restart ? '下次启动清理' : '确认清理',
    cancelText: '取消',
    async onOk() {
      try {
        const result = await store.clearCategory(category.id)
        if (result.pendingRestart) message.success('已安排清理，请稍后重启 UCLI')
        else if (result.partial) message.warning('已完成部分清理，仍有数据暂时无法移除')
        else message.success('清理完成')
      } catch {
        message.error(store.error?.message || '清理应用空间失败')
      }
    }
  })
}

onMounted(async () => { await store.load() })
</script>

<style scoped>
.storage-alert { margin-bottom: 12px; }
.storage-totals { margin-bottom: 8px; }
.storage-usage { min-width: 156px; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; }
.muted { color: #8c8c8c; }
@media (max-width: 699px) { .storage-usage { min-width: 0; justify-content: flex-start; } }
</style>
