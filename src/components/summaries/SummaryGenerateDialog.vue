<template>
  <a-modal :open="open" title="生成工作总结" :confirm-loading="submitting" :ok-button-props="{ disabled: !canGenerate }" @ok="submit" @cancel="close">
    <a-form layout="vertical">
      <a-form-item label="总结周期">
        <a-segmented v-model:value="form.periodType" :options="periodOptions" />
      </a-form-item>
      <a-form-item label="周期范围">
        <a-radio-group v-model:value="form.partial">
          <a-radio :value="false">最近完成周期</a-radio>
          <a-radio :value="true">当前周期（partial）</a-radio>
        </a-radio-group>
        <div class="muted">{{ rangeLabel }}</div>
      </a-form-item>
      <a-form-item label="执行方式">
        <a-radio-group v-model:value="useDefaults">
          <a-radio :value="true">使用全局默认</a-radio>
          <a-radio :value="false">本次覆盖</a-radio>
        </a-radio-group>
      </a-form-item>
      <template v-if="!useDefaults">
        <a-form-item label="AI CLI">
          <a-select v-model:value="form.executorId" :options="executorOptions" @change="clearExecutorDefaults" />
        </a-form-item>
        <a-form-item label="配置档案">
          <a-select v-model:value="form.profileId" allow-clear :options="profileOptions" placeholder="可选" />
        </a-form-item>
        <a-form-item label="模型">
          <a-input v-model:value="form.model" allow-clear placeholder="可选：使用 CLI 默认模型" />
        </a-form-item>
      </template>
      <a-descriptions size="small" :column="2" bordered>
        <a-descriptions-item label="预计分块">{{ estimatedChunks }}</a-descriptions-item>
        <a-descriptions-item label="预计调用">{{ estimatedCalls }}</a-descriptions-item>
        <a-descriptions-item label="coverage" :span="2">{{ coveragePreview }}</a-descriptions-item>
      </a-descriptions>
      <a-alert style="margin-top:12px" type="warning" show-icon message="可能产生费用" description="材料将通过所选 CLI/Provider 发送给 AI 服务；实际费用由对应服务商决定。" />
      <a-alert v-if="!canGenerate" style="margin-top:12px" type="error" show-icon message="所选 executable/profile 当前不可用" />
    </a-form>
  </a-modal>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ipc } from '../../ipc.js'
import { useSummariesStore } from '../../stores/summaries.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['update:open', 'generated'])
const summaries = useSummariesStore()
const tools = ref([])
const profiles = ref([])
const sessionCount = ref(0)
const useDefaults = ref(true)
const submitting = ref(false)
const form = reactive({ periodType: 'week', partial: false, executorId: null, profileId: null, model: null })
const periodOptions = [
  { label: '每日', value: 'day' }, { label: '每周', value: 'week' }, { label: '每月', value: 'month' },
  { label: '每季度', value: 'quarter' }, { label: '每年', value: 'year' }
]

const selectedExecutor = computed(() => useDefaults.value ? summaries.settings?.defaultExecutorId : form.executorId)
const selectedProfile = computed(() => useDefaults.value ? summaries.settings?.defaultProfileId : form.profileId)
const selectedModel = computed(() => useDefaults.value ? summaries.settings?.defaultModel : form.model)
const executorOptions = computed(() => tools.value
  .filter(tool => tool.installed && tool.summaryExecutorAvailable)
  .map(tool => ({ label: tool.displayName, value: tool.id })))
const profileOptions = computed(() => profiles.value.filter(profile => profile.adapterId === selectedExecutor.value && profile.status === 'ready').map(profile => ({ label: profile.name, value: profile.id })))
const canGenerate = computed(() => {
  const executable = tools.value.some(tool =>
    tool.id === selectedExecutor.value && tool.installed && tool.summaryExecutorAvailable
  )
  const profile = !selectedProfile.value || profiles.value.some(item => item.id === selectedProfile.value && item.adapterId === selectedExecutor.value && item.status === 'ready')
  return executable && profile
})
const estimatedChunks = computed(() => Math.max(1, sessionCount.value))
const estimatedCalls = computed(() => estimatedChunks.value * 2 + 1)
const coveragePreview = computed(() => `预计覆盖 ${sessionCount.value} 个会话；最终 coverage 以采集结果为准`)
const range = computed(() => periodRange(form.periodType, form.partial))
const rangeLabel = computed(() => `${new Date(range.value.start).toLocaleString()} — ${new Date(range.value.endExclusive).toLocaleString()}${form.partial ? '（当前未完成周期）' : ''}`)

onMounted(async () => {
  const [inventory, profileState, sessions] = await Promise.all([ipc.listCliTools(), ipc.getAiCliProfileState(), ipc.listSessions()])
  tools.value = inventory
  profiles.value = profileState?.profiles || []
  sessionCount.value = sessions.length
})
watch(() => props.open, value => {
  if (!value) return
  form.executorId = summaries.settings?.defaultExecutorId || null
  form.profileId = summaries.settings?.defaultProfileId || null
  form.model = summaries.settings?.defaultModel || null
})

function periodRange(periodType, partial) {
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (periodType === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  if (periodType === 'month') start.setDate(1)
  if (periodType === 'quarter') { start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1) }
  if (periodType === 'year') start.setMonth(0, 1)
  if (partial) return { start: start.getTime(), endExclusive: now.getTime() }
  const end = new Date(start)
  if (periodType === 'day') start.setDate(start.getDate() - 1)
  if (periodType === 'week') start.setDate(start.getDate() - 7)
  if (periodType === 'month') start.setMonth(start.getMonth() - 1)
  if (periodType === 'quarter') start.setMonth(start.getMonth() - 3)
  if (periodType === 'year') start.setFullYear(start.getFullYear() - 1)
  return { start: start.getTime(), endExclusive: end.getTime() }
}
function clearExecutorDefaults() { form.profileId = null; form.model = null }
function close() { emit('update:open', false) }
async function submit() {
  if (!canGenerate.value) return
  submitting.value = true
  try {
    const selectedRange = periodRange(form.periodType, form.partial)
    const result = await summaries.generate({
      periodType: form.periodType, ...selectedRange,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      partial: form.partial,
      executorId: selectedExecutor.value,
      profileId: selectedProfile.value || null,
      model: selectedModel.value || null
    })
    emit('generated', result.reportId)
    close()
  } catch (error) {
    summaries.error = error
  } finally { submitting.value = false }
}
</script>

<style scoped>.muted { color:#8c8c8c; margin-top:6px; font-size:12px; }</style>
