<template>
  <a-drawer
    :open="open"
    :title="mode === 'edit' ? '编辑 Claude Code 档案' : mode === 'copy' ? '复制 Claude Code 档案' : '新建 Claude Code 档案'"
    width="520"
    @close="close"
  >
    <a-alert
      type="info"
      show-icon
      message="档案只影响由 UCLI 启动的 Claude Code 会话，不会读取或修改 Claude 的登录凭据和全局配置。"
      style="margin-bottom: 16px"
    />
    <a-form layout="vertical">
      <a-form-item label="档案名称" required>
        <a-input v-model:value="form.name" maxlength="120" placeholder="例如：公司网关" />
      </a-form-item>

      <a-form-item label="连接方式" required>
        <a-radio-group v-model:value="form.connectionMode">
          <a-radio value="subscription">Claude 登录态</a-radio>
          <a-radio value="api_key">Anthropic API Key</a-radio>
          <a-radio value="bearer">Bearer Token 网关</a-radio>
        </a-radio-group>
      </a-form-item>

      <a-alert
        v-if="form.connectionMode !== 'subscription'"
        type="warning"
        show-icon
        message="会覆盖当前 Claude 订阅登录用于本会话"
        style="margin-bottom: 16px"
      />

      <a-form-item
        v-if="form.connectionMode !== 'subscription'"
        label="Base URL"
        :required="requiresBaseUrl"
      >
        <a-input v-model:value="form.baseUrl" placeholder="https://api.example.com" />
        <div class="profile-help">
          Anthropic API Key 可留空以使用官方地址；Bearer Token 网关必须填写 Base URL。
        </div>
      </a-form-item>

      <a-form-item
        v-if="secretLabel"
        :label="mode === 'edit' && profile?.hasSecret ? `替换 ${secretLabel}（留空则不修改）` : secretLabel"
        :required="mode !== 'edit' || !profile?.hasSecret"
      >
        <a-input-password
          v-model:value="secretDraft"
          autocomplete="new-password"
          placeholder="仅在保存时交给系统加密"
        />
        <div class="profile-help">UCLI 不会在档案页面、日志、会话记录或诊断报告中暴露凭据。</div>
      </a-form-item>

      <a-form-item label="首选模型">
        <a-input v-model:value="form.model" placeholder="例如：claude-sonnet-4-5" />
        <div class="profile-help">组织策略可能替换实际模型，UCLI 会在会话中提示。</div>
      </a-form-item>
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

import { claudeConnectionModePresentation } from '../../profilePresentation.js'

const props = defineProps({
  open: Boolean,
  profile: { type: Object, default: null },
  mode: { type: String, default: 'create' },
  saving: Boolean
})
const emit = defineEmits(['update:open', 'save'])
const secretDraft = ref('')
const form = reactive({ name: '', connectionMode: 'subscription', baseUrl: '', model: '' })

watch(() => [props.open, props.profile], () => {
  if (!props.open) return
  Object.assign(form, {
    name: props.profile?.name || '',
    connectionMode: props.profile?.connectionMode || 'subscription',
    baseUrl: props.profile?.baseUrl || '',
    model: props.profile?.model || ''
  })
  secretDraft.value = ''
}, { immediate: true })

const modeView = computed(() => claudeConnectionModePresentation(form.connectionMode))
const secretLabel = computed(() => modeView.value.secretLabel)
const requiresBaseUrl = computed(() => form.connectionMode === 'bearer' && modeView.value.requiresBaseUrl)
const needsSecret = computed(() => form.connectionMode !== 'subscription' && (
  props.mode !== 'edit' ||
  !props.profile?.hasSecret ||
  form.connectionMode !== props.profile?.connectionMode
))
const canSave = computed(() => Boolean(
  form.name.trim() &&
  (!requiresBaseUrl.value || form.baseUrl.trim()) &&
  (!needsSecret.value || secretDraft.value)
))

function clearSecret() {
  secretDraft.value = ''
}

function close() {
  clearSecret()
  emit('update:open', false)
}

function save() {
  if (!canSave.value) return
  emit('save', {
    adapterId: 'claude',
    name: form.name,
    connectionMode: form.connectionMode,
    baseUrl: form.connectionMode === 'subscription' ? null : (form.baseUrl || null),
    model: form.model || null,
    secret: secretDraft.value || undefined
  })
  clearSecret()
}

onUnmounted(clearSecret)
</script>

<style scoped>
.profile-help { margin-top: 4px; color: #8c8c8c; font-size: 12px; line-height: 1.5; }
.profile-drawer-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
