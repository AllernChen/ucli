<template>
  <a-card v-if="selectedCount || result" class="skills-batch-action-bar" size="small">
    <div class="skills-batch-heading">
      <strong>已选择 {{ selectedCount }} 个 Skill</strong>
      <a-space>
        <a-button size="small" :disabled="saving || !selectedCount" aria-label="清空已选择的 Skills" @click="$emit('clear')">清空选择</a-button>
        <a-button v-if="retryAvailable" size="small" :loading="saving" :disabled="saving" aria-label="仅重试失败的 Skills" @click="$emit('retry')">仅重试失败项</a-button>
      </a-space>
    </div>

    <a-space v-if="selectedCount" wrap class="skills-batch-actions">
      <a-button v-if="can('install_organization')" type="primary" :disabled="saving || !targetAdapterIds.length" aria-label="预览批量安装组织 Skills" @click="requestPreview('install_organization')">批量安装</a-button>
      <a-button v-if="can('update_organization')" :disabled="saving || !targetAdapterIds.length" aria-label="预览批量更新组织 Skills" @click="requestPreview('update_organization')">批量更新</a-button>
      <a-button v-if="can('update_packages')" :disabled="saving" aria-label="预览批量更新受管 Skills" @click="requestPreview('update_packages')">批量更新</a-button>
      <a-button v-if="can('set_cli_state')" :disabled="saving || !adapterId" aria-label="预览批量启用选定 CLI" @click="requestPreview('set_cli_state', 'enabled')">批量启用</a-button>
      <a-button v-if="can('set_cli_state')" :disabled="saving || !adapterId" aria-label="预览批量停用选定 CLI" @click="requestPreview('set_cli_state', 'disabled')">批量停用</a-button>
      <a-button v-if="can('remove_projections')" :disabled="saving || !adapterId" aria-label="预览批量移除投影" @click="requestPreview('remove_projections')">移除投影</a-button>
      <a-button v-if="can('remove_packages')" danger :disabled="saving" aria-label="预览批量移除受管包" @click="requestPreview('remove_packages')">移除受管包</a-button>
    </a-space>

    <a-space v-if="selectedCount" class="skills-batch-targets" wrap>
      <span>目标 CLI</span>
      <a-select v-model:value="adapterId" :options="adapterOptions" :disabled="saving" aria-label="批量操作的目标 CLI" style="min-width: 150px" />
      <a-select v-if="can('install_organization') || can('update_organization')" v-model:value="targetAdapterIds" mode="multiple" :options="adapterOptions" :disabled="saving" aria-label="组织 Skill 批量安装目标 CLI" style="min-width: 220px" />
    </a-space>

    <div v-if="result" class="skills-batch-result-summary" aria-live="polite">
      成功 {{ result.succeeded?.length || 0 }} · 失败 {{ result.failed?.length || 0 }} · 跳过 {{ result.skipped?.length || 0 }}
      <span v-if="result.aborted"> · 批次中止：{{ result.aborted.code }}</span>
    </div>
  </a-card>

  <a-modal :open="Boolean(preview)" title="批量操作预览" :closable="!saving" :mask-closable="!saving" :keyboard="!saving" @cancel="$emit('close-preview')">
    <p>将在当前选择范围内逐项执行；每个 Skill 独立处理，普通失败不会阻止其他项。</p>
    <div v-for="category in categories" :key="category.key" class="skills-batch-preview-category">
      <strong>{{ category.label }}（{{ preview?.categories?.[category.key]?.length || 0 }}）</strong>
      <div v-for="item in preview?.categories?.[category.key] || []" :key="`${item.item.kind}:${item.item.id}`" class="skills-muted">
        {{ item.item.id }}<span v-if="item.reasonCode"> · {{ item.reasonCode }}</span>
      </div>
    </div>
    <template #footer>
      <a-button :disabled="saving" @click="$emit('close-preview')">取消</a-button>
      <a-button v-if="preview?.action === 'remove_packages'" danger :loading="saving" :disabled="saving" aria-label="确认移除受管包" @click="managedRemovalOpen = true">移除受管包</a-button>
      <a-button v-else type="primary" :loading="saving" :disabled="saving" aria-label="确认应用批量操作" @click="$emit('apply')">确认应用</a-button>
    </template>
  </a-modal>

  <a-modal v-model:open="managedRemovalOpen" title="确认移除受管包" :confirm-loading="saving" ok-text="确认移除受管包" :ok-button-props="{ danger: true }" @ok="confirmManagedRemoval">
    <p>这会删除受管包、来源身份、期望状态和全部剩余投影；“移除投影”不会执行这项危险操作。</p>
  </a-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  selectedCount: { type: Number, default: 0 },
  actions: { type: Array, default: () => [] },
  adapters: { type: Array, default: () => [] },
  preview: { type: Object, default: null },
  result: { type: Object, default: null },
  retryAvailable: Boolean,
  saving: Boolean
})
const emit = defineEmits(['preview', 'apply', 'clear', 'retry', 'close-preview'])
const adapterId = ref('')
const targetAdapterIds = ref([])
const managedRemovalOpen = ref(false)
const adapterOptions = computed(() => props.adapters.filter((adapter) => !adapter.virtual)
  .map((adapter) => ({ value: adapter.id, label: adapter.displayName || adapter.id })))
const categories = [
  { key: 'direct', label: '可直接执行' },
  { key: 'migration_required', label: '需要迁移' },
  { key: 'blocked', label: '无法隔离' },
  { key: 'conflict', label: '存在冲突' },
  { key: 'noop', label: '无需变化' }
]

watch(adapterOptions, (options) => {
  const ids = new Set(options.map((option) => option.value))
  if (!ids.has(adapterId.value)) adapterId.value = options[0]?.value || ''
  targetAdapterIds.value = targetAdapterIds.value.filter((id) => ids.has(id))
}, { immediate: true })
watch(() => props.preview, (preview) => {
  if (!preview) managedRemovalOpen.value = false
})

function can(action) { return props.actions.includes(action) }
function requestPreview(action, desiredState = null) {
  emit('preview', {
    action,
    adapterId: adapterId.value,
    desiredState,
    targets: { targetAdapterIds: [...targetAdapterIds.value] }
  })
}
function confirmManagedRemoval() {
  managedRemovalOpen.value = false
  emit('apply')
}
</script>

<style scoped>
.skills-batch-action-bar { margin-bottom: 12px; }
.skills-batch-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.skills-batch-actions, .skills-batch-targets, .skills-batch-result-summary { margin-top: 10px; }
.skills-batch-preview-category { margin-top: 12px; }
.skills-muted { color: #8c8c8c; font-size: 12px; word-break: break-word; }
</style>
