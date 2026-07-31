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
        <a-alert
          type="info"
          show-icon
          message="目标会话无需手工填写 ID"
          description="保存配置并启动 Gateway 后，在飞书私聊机器人发送“绑定 UCLI”，或在群聊中 @机器人发送“绑定 UCLI”。UCLI 收到请求后会在这里等待你确认。"
        />
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
      <h3>飞书会话绑定</h3>
      <div v-if="gateway.configuration?.target" class="binding-row">
        <div>
          <a-tag color="green">已绑定</a-tag>
          <span>{{ gatewayTargetLabel(gateway.configuration) }}</span>
        </div>
        <a-popconfirm
          title="解除当前飞书绑定？Gateway 将回到等待绑定状态。"
          ok-text="解除绑定"
          cancel-text="取消"
          @confirm="clearBinding"
        >
          <a-button size="small" :loading="bindingBusy">解除绑定</a-button>
        </a-popconfirm>
      </div>
      <a-alert
        v-else-if="gateway.runtime.bindingCandidate"
        type="warning"
        show-icon
        message="收到新的绑定请求"
      >
        <template #description>
          <div class="binding-candidate">
            <span>
              {{ gateway.runtime.bindingCandidate.targetType === 'group' ? '群聊' : '用户' }}
              · {{ gateway.runtime.bindingCandidate.displayName }}
              （{{ gateway.runtime.bindingCandidate.targetHint }}）
            </span>
            <span>
              发起人 {{ gateway.runtime.bindingCandidate.operatorName }}
              （{{ gateway.runtime.bindingCandidate.operatorHint }}）
              将获得远程任务与决策权限
            </span>
            <strong>
              校验码 {{ gateway.runtime.bindingCandidate.confirmationCode }}
            </strong>
            <div class="binding-actions">
              <a-button
                size="small"
                type="primary"
                :loading="bindingBusy"
                @click="confirmBinding(gateway.runtime.bindingCandidate.id)"
              >确认绑定</a-button>
              <a-button
                size="small"
                :disabled="bindingBusy"
                @click="dismissBinding(gateway.runtime.bindingCandidate.id)"
              >忽略</a-button>
            </div>
          </div>
        </template>
      </a-alert>
      <a-alert
        v-else
        type="info"
        show-icon
        :message="gateway.runtime.desiredEnabled ? '等待飞书绑定' : '启动 Gateway 后等待绑定'"
        description="请在飞书中向机器人发送“绑定 UCLI”；群聊中需要 @机器人。"
      />
    </section>

    <a-divider />
    <section class="gateway-section">
      <h3>AI CLI 会话</h3>
      <a-list :data-source="gateway.sessions" :loading="gateway.loading">
        <template #renderItem="{ item }">
          <a-list-item>
            <template #actions>
              <a-switch
                :checked="relayView(item).selected"
                :loading="gateway.relayPendingFor(item.id)"
                :disabled="gateway.relayPendingFor(item.id)"
                :aria-label="`${item.name || '当前会话'} 转发开关`"
                @change="(enabled) => toggleSessionRelay(item.id, enabled)"
              />
              <a-button
                size="small"
                :disabled="!item.relayEnabled"
                :aria-label="`重新同步 ${item.name || '当前会话'}`"
                @click="gateway.resyncSession(item.id)"
              >重新同步</a-button>
            </template>
            <a-list-item-meta :title="item.name || item.id">
              <template #description>
                {{ item.adapterId }}<span v-if="item.provider"> / {{ item.provider }}</span>
                · {{ relayView(item).label }} · {{ item.status }} · 根消息 {{ item.routeStatus }} · 队列 {{ item.queueCount }}
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
  gatewayTargetLabel,
  gatewayTimeLabel
} from '../../gatewayPresentation.js'
import { deriveGatewayRelayControl } from '../../gatewayRelayPresentation.js'
import { useGatewayStore } from '../../stores/gateway.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['update:open', 'closed'])
const gateway = useGatewayStore()
const testing = ref(false)
const applying = ref(false)
const bindingBusy = ref(false)
const candidateError = ref('')
const testedSignature = ref('')
const draft = reactive({
  appId: '',
  appSecret: ''
})

const signature = computed(() => JSON.stringify({
  appId: draft.appId.trim()
}))
const canApply = computed(() =>
  Boolean(gateway.testedDraft?.testId) &&
  testedSignature.value === signature.value
)

function relayView(item) {
  return deriveGatewayRelayControl({
    session: item,
    gatewayPhase: gateway.runtime.phase,
    pending: gateway.relayPendingFor(item.id)
  })
}

async function toggleSessionRelay(sessionId, enabled) {
  try {
    await gateway.setSessionRelayEnabled(sessionId, enabled)
  } catch (error) {
    message.error(error?.message || '会话转发状态更新失败')
  }
}

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

function loadAppliedDraft() {
  const config = gateway.configuration
  draft.appId = config?.appId || ''
  draft.appSecret = ''
  candidateError.value = ''
  testedSignature.value = ''
  gateway.invalidateTest()
}

function payload() {
  const applied = gateway.configuration
  const preserveBinding = applied?.appId === draft.appId.trim()
  return {
    config: {
      channelType: 'feishu',
      appId: draft.appId,
      target: preserveBinding && applied?.target
        ? { ...applied.target }
        : null,
      operatorOpenIds: preserveBinding
        ? [...(applied?.operatorOpenIds || [])]
        : []
    },
    appSecret: draft.appSecret
  }
}

async function confirmBinding(bindingId) {
  if (!bindingId) return
  bindingBusy.value = true
  candidateError.value = ''
  try {
    await gateway.confirmBinding(bindingId)
    message.success('飞书会话已绑定')
  } catch (error) {
    candidateError.value = error?.message || '确认绑定失败'
  } finally {
    bindingBusy.value = false
  }
}

async function dismissBinding(bindingId) {
  if (!bindingId) return
  bindingBusy.value = true
  candidateError.value = ''
  try {
    await gateway.dismissBinding(bindingId)
  } catch (error) {
    candidateError.value = error?.message || '忽略绑定请求失败'
  } finally {
    bindingBusy.value = false
  }
}

async function clearBinding() {
  bindingBusy.value = true
  candidateError.value = ''
  try {
    await gateway.clearBinding()
    message.success('飞书绑定已解除')
  } catch (error) {
    candidateError.value = error?.message || '解除绑定失败'
  } finally {
    bindingBusy.value = false
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
.binding-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.binding-candidate { display: flex; flex-direction: column; gap: 10px; }
.binding-actions { display: flex; gap: 8px; }
.copyable-error { user-select: text; white-space: pre-wrap; }
</style>
