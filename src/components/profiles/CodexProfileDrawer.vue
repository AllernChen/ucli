<template>
  <a-drawer
    :open="open"
    :title="mode === 'edit' ? '编辑 Codex 档案' : mode === 'copy' ? '复制 Codex 档案' : '新建 Codex 档案'"
    width="520"
    @close="close"
  >
    <a-alert
      type="info"
      show-icon
      message="档案只影响由 UCLI 启动的 Codex 会话，不会改写 Codex 或 CC Switch 的全局配置。"
      style="margin-bottom: 16px"
    />
    <a-form layout="vertical">
      <a-form-item label="档案名称" required>
        <a-input v-model:value="form.name" maxlength="120" placeholder="例如：公司网关" />
      </a-form-item>
      <a-form-item label="档案类型" required>
        <a-radio-group v-model:value="form.kind" :disabled="mode === 'edit'">
          <a-radio value="reference">引用现有 Provider</a-radio>
          <a-radio value="managed">UCLI 托管</a-radio>
        </a-radio-group>
      </a-form-item>
      <a-form-item v-if="form.kind === 'reference'" label="Codex Provider" required>
        <a-select v-model:value="form.providerId" placeholder="选择 config.toml 中已有的 Provider">
          <a-select-option v-for="provider in providerCatalog" :key="provider.id" :value="provider.id">
            {{ provider.displayName }}（{{ provider.id }}）
          </a-select-option>
        </a-select>
      </a-form-item>
      <template v-else>
        <a-form-item label="Base URL" required>
          <a-input v-model:value="form.baseUrl" placeholder="https://api.example.com/v1" />
          <div class="profile-help">公网地址必须使用 HTTPS；HTTP 仅支持本机回环地址。</div>
        </a-form-item>
        <a-form-item :label="mode === 'edit' && profile?.hasSecret ? '替换 API Key（留空则不修改）' : 'API Key'" :required="mode !== 'edit' || !profile?.hasSecret">
          <a-input-password v-model:value="secretDraft" autocomplete="new-password" placeholder="仅在保存时交给系统加密" />
          <div class="profile-help">UCLI 不会把密钥写入档案文件、日志或页面状态。</div>
        </a-form-item>
      </template>
      <a-form-item label="模型">
        <a-input v-model:value="form.model" placeholder="例如：gpt-5" />
      </a-form-item>
      <a-collapse ghost>
        <a-collapse-panel key="advanced" header="高级设置">
          <a-form-item label="推理强度">
            <a-select v-model:value="form.reasoningEffort" allow-clear>
              <a-select-option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</a-select-option>
            </a-select>
          </a-form-item>
          <a-form-item label="上下文窗口">
            <a-input-number v-model:value="form.contextWindow" :min="1" style="width: 100%" />
            <div class="profile-help">上下文窗口只是发给 Codex 的配置提示，实际能力仍由所选模型和服务端决定。</div>
          </a-form-item>
          <a-form-item label="Wire API">
            <a-input value="Responses" disabled />
          </a-form-item>
        </a-collapse-panel>
      </a-collapse>
    </a-form>
    <template #footer>
      <div class="profile-drawer-footer">
        <a-button @click="close">取消</a-button>
        <a-button type="primary" :loading="saving" :disabled="!canSave" @click="save">保存档案</a-button>
      </div>
    </template>
  </a-drawer>
</template>

<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  open: Boolean,
  profile: { type: Object, default: null },
  mode: { type: String, default: 'create' },
  providerCatalog: { type: Array, default: () => [] },
  saving: Boolean
})
const emit = defineEmits(['update:open', 'save'])
const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh']
const secretDraft = ref('')
const form = reactive({
  name: '', kind: 'reference', providerId: null, baseUrl: '', model: '',
  reasoningEffort: null, contextWindow: null
})

watch(() => [props.open, props.profile], () => {
  if (!props.open) return
  Object.assign(form, {
    name: props.profile?.name || '',
    kind: props.profile?.kind || 'reference',
    providerId: props.profile?.providerId || props.providerCatalog[0]?.id || null,
    baseUrl: props.profile?.baseUrl || '',
    model: props.profile?.model || '',
    reasoningEffort: props.profile?.reasoningEffort || null,
    contextWindow: props.profile?.contextWindow || null
  })
  secretDraft.value = ''
}, { immediate: true })

const canSave = computed(() => Boolean(
  form.name.trim() &&
  (form.kind === 'reference' ? form.providerId : form.baseUrl.trim()) &&
  (props.mode === 'edit' || form.kind === 'reference' || secretDraft.value)
))

function close() {
  secretDraft.value = ''
  emit('update:open', false)
}

function save() {
  if (!canSave.value) return
  emit('save', {
    adapterId: 'codex',
    name: form.name,
    kind: form.kind,
    providerId: form.kind === 'reference' ? form.providerId : null,
    baseUrl: form.kind === 'managed' ? form.baseUrl : null,
    model: form.model || null,
    reasoningEffort: form.reasoningEffort || null,
    contextWindow: form.contextWindow || null,
    secret: secretDraft.value || undefined
  })
  secretDraft.value = ''
}

onUnmounted(() => { secretDraft.value = '' })
</script>

<style scoped>
.profile-help { margin-top: 4px; color: #8c8c8c; font-size: 12px; line-height: 1.5; }
.profile-drawer-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
