<template>
  <a-modal
    :open="open"
    title="Codex 会话诊断"
    :footer="null"
    width="720px"
    @cancel="close"
  >
    <div class="diagnostic-toolbar">
      <span class="diagnostic-hint">检查 UCLI 记录与本机 Codex 主会话的绑定关系</span>
      <a-button size="small" :loading="loading" @click="loadDiagnostics">刷新</a-button>
    </div>

    <a-spin :spinning="loading">
      <a-alert
        v-if="error"
        type="error"
        show-icon
        :message="error"
      />
      <template v-else-if="diagnostic">
        <a-alert
          show-icon
          :type="sessionBindingAlertType(diagnostic.bindingState)"
          :message="sessionBindingStateLabel(diagnostic.bindingState)"
          class="binding-alert"
        />
        <a-descriptions size="small" :column="1" bordered>
          <a-descriptions-item label="UCLI 会话 ID">
            <a-typography-text copyable>{{ diagnostic.sessionId }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item label="当前绑定">
            <a-typography-text v-if="diagnostic.storedNativeSessionId" copyable>
              {{ diagnostic.storedNativeSessionId }}
            </a-typography-text>
            <span v-else>—</span>
          </a-descriptions-item>
          <a-descriptions-item label="解析结果">
            <a-typography-text v-if="diagnostic.resolvedNativeSessionId" copyable>
              {{ diagnostic.resolvedNativeSessionId }}
            </a-typography-text>
            <span v-else>—</span>
          </a-descriptions-item>
          <a-descriptions-item label="项目目录">
            <a-typography-text copyable>{{ diagnostic.cwd || '—' }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item label="父子链">
            <div v-if="diagnostic.lineage?.length" class="lineage">
              <template v-for="(item, index) in diagnostic.lineage" :key="item.sessionId">
                <a-typography-text copyable class="lineage-id">{{ item.sessionId }}</a-typography-text>
                <span v-if="index < diagnostic.lineage.length - 1" class="lineage-arrow">→</span>
              </template>
            </div>
            <span v-else>—</span>
          </a-descriptions-item>
        </a-descriptions>
      </template>
    </a-spin>

    <div class="diagnostic-footer">
      <span class="resume-hint">在 Codex 中使用 /resume 选择会话后，UCLI 会自动保存新绑定。</span>
      <a-space>
        <a-button @click="close">关闭</a-button>
        <a-button
          type="primary"
          :loading="repairing"
          :disabled="!diagnostic?.repairAvailable"
          @click="repairBinding"
        >修复绑定</a-button>
      </a-space>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useSessionsStore } from '../stores/sessions.js'
import {
  sessionBindingAlertType,
  sessionBindingStateLabel
} from '../sessionDiagnosticsPresentation.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  sessionId: { type: String, default: '' }
})
const emit = defineEmits(['update:open'])
const sessions = useSessionsStore()
const diagnostic = ref(null)
const loading = ref(false)
const repairing = ref(false)
const error = ref('')

function close() {
  emit('update:open', false)
}

async function loadDiagnostics() {
  if (!props.sessionId) return
  loading.value = true
  error.value = ''
  try {
    diagnostic.value = await sessions.getDiagnostics(props.sessionId)
  } catch (cause) {
    diagnostic.value = null
    error.value = '读取会话诊断失败：' + (cause?.message || cause)
  } finally {
    loading.value = false
  }
}

async function repairBinding() {
  if (!diagnostic.value?.repairAvailable || !props.sessionId) return
  repairing.value = true
  error.value = ''
  try {
    const result = await sessions.repairBinding(props.sessionId)
    diagnostic.value = result.diagnostic
    message.success(result.changed ? '会话绑定已修复并保存' : '当前绑定已经是最新状态')
  } catch (cause) {
    error.value = '修复会话绑定失败：' + (cause?.message || cause)
  } finally {
    repairing.value = false
  }
}

watch(
  () => [props.open, props.sessionId],
  ([open, sessionId]) => {
    if (open && sessionId) loadDiagnostics()
    if (!open) {
      diagnostic.value = null
      error.value = ''
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.diagnostic-toolbar,
.diagnostic-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.diagnostic-toolbar { margin-bottom: 12px; }
.diagnostic-footer { margin-top: 16px; }
.diagnostic-hint,
.resume-hint { color: #8c8c8c; font-size: 12px; }
.binding-alert { margin-bottom: 12px; }
.lineage { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lineage-id { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.lineage-arrow { color: #8c8c8c; }
</style>
