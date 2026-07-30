<template>
  <a-drawer
    :open="open"
    title="通信 Gateway 配置"
    width="620"
    :destroy-on-close="true"
    @close="closeDrawer"
  >
    <section class="gateway-section">
      <h3>通信端配置</h3>
      <a-form layout="vertical">
        <a-form-item label="App ID">
          <a-input v-model:value="draft.appId" aria-label="飞书 App ID" placeholder="cli_..." />
        </a-form-item>
        <a-form-item label="App Secret">
          <a-input-password
            v-model:value="draft.appSecret"
            aria-label="飞书 App Secret"
            :placeholder="gateway.configuration?.hasAppSecret ? '已保存；留空则继续使用' : '请输入 App Secret'"
          />
        </a-form-item>
        <a-form-item label="目标类型">
          <a-radio-group v-model:value="draft.targetType" aria-label="飞书目标类型">
            <a-radio value="group">群聊</a-radio>
            <a-radio value="user">用户</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="目标 ID">
          <a-input v-model:value="draft.targetId" aria-label="飞书目标 ID" :placeholder="draft.targetType === 'group' ? 'oc_...' : 'ou_...'" />
        </a-form-item>
        <a-form-item label="Operator Open ID 白名单">
          <a-textarea
            v-model:value="draft.operators"
            aria-label="Operator Open ID 白名单"
            :rows="3"
            placeholder="每行一个 ou_..."
          />
        </a-form-item>
        <a-alert
          type="warning"
          show-icon
          message="仅转发用户决策、方案摘要和明确的任务完成事件；完整内容按需查看并执行脱敏。"
        />
        <div class="drawer-actions">
          <a-button :loading="testing" aria-label="测试 Gateway 连接" @click="testConnection">测试连接</a-button>
          <a-button
            type="primary"
            :loading="applying"
            :disabled="!canApply"
            aria-label="保存并应用 Gateway 配置"
            @click="applyConfiguration"
          >保存并应用</a-button>
        </div>
        <a-alert v-if="candidateError" type="error" show-icon :message="candidateError" />
      </a-form>
    </section>

    <a-divider />
    <section class="gateway-section">
      <h3>AI CLI 会话</h3>
      <a-list :data-source="gateway.sessions" :loading="gateway.loading">
        <template #renderItem="{ item }">
          <a-list-item>
            <template #actions>
              <a-switch
                :checked="item.relayEnabled"
                :aria-label="`${item.name || item.id} 转发开关`"
                @change="(enabled) => gateway.setSessionRelayEnabled(item.id, enabled)"
              />
              <a-button
                size="small"
                :disabled="!item.relayEnabled"
                :aria-label="`重新同步 ${item.name || item.id}`"
                @click="gateway.resyncSession(item.id)"
              >重新同步</a-button>
            </template>
            <a-list-item-meta :title="item.name || item.id">
              <template #description>
                {{ item.adapterId }}<span v-if="item.provider"> / {{ item.provider }}</span>
                · {{ item.status }} · 根消息 {{ item.routeStatus }} · 队列 {{ item.queueCount }}
              </template>
            </a-list-item-meta>
          </a-list-item>
        </template>
      </a-list>
      <a-empty v-if="!gateway.sessions.length" description="暂无可配置会话" />
    </section>

    <a-divider />
    <section class="gateway-section">
      <h3>Gateway 运行状态</h3>
      <a-descriptions size="small" :column="1" bordered>
        <a-descriptions-item label="期望状态">{{ gateway.runtime.desiredEnabled ? '开启' : '关闭' }}</a-descriptions-item>
        <a-descriptions-item label="连接阶段">{{ gatewayPhaseLabel(gateway.runtime.phase) }}</a-descriptions-item>
        <a-descriptions-item label="Bot 身份">
          {{ gateway.runtime.botIdentity?.name || gateway.runtime.botIdentity?.openId || '—' }}
        </a-descriptions-item>
        <a-descriptions-item label="最近连接">{{ gatewayTimeLabel(gateway.runtime.lastConnectedAt) }}</a-descriptions-item>
        <a-descriptions-item label="已选择 / 可转发">{{ gateway.runtime.selectedSessionCount }} / {{ gateway.runtime.readySessionCount }}</a-descriptions-item>
        <a-descriptions-item label="待处理决策">{{ gateway.runtime.pendingDecisionCount }}</a-descriptions-item>
        <a-descriptions-item label="队列任务">{{ gateway.runtime.queuedTaskCount }}</a-descriptions-item>
        <a-descriptions-item v-if="gateway.runtime.errorMessage" label="最近错误">
          <span class="copyable-error">{{ gateway.runtime.errorMessage }}</span>
        </a-descriptions-item>
      </a-descriptions>
    </section>
  </a-drawer>
</template>

<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'

import {
  gatewayPhaseLabel,
  gatewayTimeLabel
} from '../../gatewayPresentation.js'
import { useGatewayStore } from '../../stores/gateway.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['update:open', 'closed'])
const gateway = useGatewayStore()
const testing = ref(false)
const applying = ref(false)
const candidateError = ref('')
const testedSignature = ref('')
const draft = reactive({
  appId: '',
  appSecret: '',
  targetType: 'group',
  targetId: '',
  operators: ''
})

const signature = computed(() => JSON.stringify({
  appId: draft.appId.trim(),
  targetType: draft.targetType,
  targetId: draft.targetId.trim(),
  operators: operatorIds()
}))
const canApply = computed(() =>
  Boolean(gateway.testedDraft?.testId) &&
  testedSignature.value === signature.value
)

watch(() => props.open, async (open) => {
  if (!open) return
  await gateway.init()
  await Promise.all([
    gateway.refreshConfiguration(),
    gateway.refreshSessions()
  ])
  loadAppliedDraft()
}, { immediate: true })

watch(signature, (value) => {
  if (testedSignature.value && testedSignature.value !== value) {
    gateway.invalidateTest()
    testedSignature.value = ''
  }
})

watch(() => draft.appSecret, (value) => {
  if (value && gateway.testedDraft) {
    gateway.invalidateTest()
    testedSignature.value = ''
  }
})

function operatorIds() {
  return [...new Set(
    draft.operators.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean)
  )]
}

function loadAppliedDraft() {
  const config = gateway.configuration
  draft.appId = config?.appId || ''
  draft.targetType = config?.target?.type || 'group'
  draft.targetId = config?.target?.id || ''
  draft.operators = (config?.operatorOpenIds || []).join('\n')
  draft.appSecret = ''
  candidateError.value = ''
  testedSignature.value = ''
  gateway.invalidateTest()
}

function payload() {
  return {
    config: {
      channelType: 'feishu',
      appId: draft.appId,
      target: { type: draft.targetType, id: draft.targetId },
      operatorOpenIds: operatorIds()
    },
    appSecret: draft.appSecret
  }
}

async function testConnection() {
  testing.value = true
  candidateError.value = ''
  try {
    await gateway.testDraft(payload())
    testedSignature.value = signature.value
    message.success('Gateway 连接测试成功')
  } catch (error) {
    candidateError.value = error?.message || '连接测试失败'
  } finally {
    draft.appSecret = ''
    testing.value = false
  }
}

async function applyConfiguration() {
  if (!canApply.value) return
  applying.value = true
  candidateError.value = ''
  try {
    await gateway.applyDraft(gateway.testedDraft.testId)
    testedSignature.value = ''
    message.success('Gateway 配置已应用')
  } catch (error) {
    candidateError.value = error?.message || '配置应用失败'
  } finally {
    applying.value = false
  }
}

function closeDrawer() {
  draft.appSecret = ''
  gateway.invalidateTest()
  testedSignature.value = ''
  emit('update:open', false)
  emit('closed')
}

onUnmounted(() => {
  draft.appSecret = ''
  gateway.invalidateTest()
})
</script>

<style scoped>
.gateway-section h3 { margin: 0 0 14px; }
.drawer-actions { display: flex; gap: 8px; margin: 14px 0; }
.copyable-error { user-select: text; white-space: pre-wrap; }
</style>
