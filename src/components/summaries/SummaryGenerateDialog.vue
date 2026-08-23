<template>
  <a-modal
    :open="open"
    title="生成工作总结"
    ok-text="打开总结 CLI"
    :confirm-loading="submitting"
    :ok-button-props="{ disabled: !canOpen }"
    @ok="submit"
    @cancel="close"
  >
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
      <div class="hint">将在工作总结（workLogs）目录打开所选 AI CLI。UCLI 已准备好 <code>data.json</code> 与 <code>template.md</code>，CLI 分析后直接把 Markdown 与 HTML 写入该目录。</div>
      <div class="hint">{{ coveragePreview }}</div>
      <a-alert style="margin-top:12px" type="warning" show-icon message="可能产生费用" description="材料将通过所选 CLI/Provider 发送给 AI 服务；实际费用由对应服务商决定。" />
      <a-alert v-if="!hasCli" style="margin-top:12px" type="error" show-icon message="未检测到已安装的 AI CLI" description="请先在「设置」中安装 Claude Code、Codex、OpenCode 或 U-Code。" />
    </a-form>
  </a-modal>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ipc } from '../../ipc.js'
import { useSessionsStore } from '../../stores/sessions.js'
import { useSummariesStore } from '../../stores/summaries.js'

const SUMMARY_CLI_IDS = ['claude', 'codex', 'opencode', 'ucode']

const props = defineProps({ open: Boolean })
const emit = defineEmits(['update:open', 'open'])
const summaries = useSummariesStore()
const sessions = useSessionsStore()
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

const installedTools = computed(() => tools.value
  .filter(tool => SUMMARY_CLI_IDS.includes(tool.id) && tool.installed))
// 「使用全局默认」＝使用设置里的默认 CLI；未安装则回退到第一个已安装 CLI。
const defaultExecutorId = computed(() => {
  const preferred = summaries.settings?.defaultExecutorId
  if (preferred && installedTools.value.some(tool => tool.id === preferred)) return preferred
  return installedTools.value[0]?.id || null
})
const selectedExecutor = computed(() => useDefaults.value ? defaultExecutorId.value : form.executorId)
const executorOptions = computed(() => installedTools.value.map(tool => ({ label: tool.displayName, value: tool.id })))
const profileOptions = computed(() => profiles.value
  .filter(profile => profile.adapterId === selectedExecutor.value && profile.status === 'ready')
  .map(profile => ({ label: profile.name, value: profile.id })))
const selectedProfile = computed(() => {
  const id = useDefaults.value ? summaries.settings?.defaultProfileId : form.profileId
  if (!id) return null
  const profile = profiles.value.find(candidate => candidate.id === id)
  return profile?.adapterId === selectedExecutor.value && profile?.status === 'ready' ? id : null
})
const selectedModel = computed(() => useDefaults.value ? summaries.settings?.defaultModel : form.model)
const hasCli = computed(() => installedTools.value.length > 0)
const canOpen = computed(() => hasCli.value && !!selectedExecutor.value)
const coveragePreview = computed(() => `预计覆盖 ${sessionCount.value} 个会话；最终 coverage 以采集结果为准`)
const range = computed(() => periodRange(form.periodType, form.partial))
const rangeLabel = computed(() => `${new Date(range.value.start).toLocaleString()} — ${new Date(range.value.endExclusive).toLocaleString()}${form.partial ? '（当前未完成周期）' : ''}`)

onMounted(async () => {
  await sessions.init()
  const [inventory, profileState, list] = await Promise.all([
    ipc.listCliTools(),
    ipc.getAiCliProfileState(),
    ipc.listSessions()
  ])
  tools.value = inventory
  profiles.value = profileState?.profiles || []
  sessionCount.value = list.length
  if (props.open) applyExecutionSelection()
})
watch(() => props.open, value => {
  if (!value) return
  applyExecutionSelection()
})

function applyExecutionSelection() {
  useDefaults.value = true
  form.executorId = defaultExecutorId.value
  form.profileId = summaries.settings?.defaultProfileId || null
  form.model = summaries.settings?.defaultModel || null
}

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
  const executorId = selectedExecutor.value
  if (!executorId) return
  submitting.value = true
  try {
    const selectedRange = periodRange(form.periodType, form.partial)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const prepared = await ipc.prepareSummary({
      periodType: form.periodType,
      start: selectedRange.start,
      endExclusive: selectedRange.endExclusive,
      timezone
    })
    const periodLabel = periodOptions.find(option => option.value === form.periodType)?.label || form.periodType
    // 一次生成 = 一张卡片，但同一周期的多次生成共用一个会话：复用同名同适配器的
    // 既有 `工作总结（周期）` 会话，避免工作台会话列表随每次生成堆积。
    const sessionId = await findOrCreateSummarySession({
      adapterId: executorId,
      periodLabel,
      cwd: prepared.workLogsDir,
      profileId: selectedProfile.value || undefined,
      model: selectedModel.value || undefined
    })
    // The work summary panel owns adapter startup and auto-sends the brief
    // prompt once the CLI reports ready; this dialog only hands the full task
    // metadata off so the panel can build a task card, persist the artifact
    // filename, and auto-run without any manual send.
    emit('open', {
      sessionId,
      adapterId: executorId,
      briefPrompt: prepared.briefPrompt,
      periodLabel,
      periodType: form.periodType,
      suggestedFileName: prepared.suggestedFileName,
      workLogsDir: prepared.workLogsDir,
      genTime: Date.now()
    })
    close()
  } catch (error) {
    summaries.error = error
  } finally { submitting.value = false }
}

// 按周期 + 执行 CLI 复用共享会话：同名且同适配器即视为共享会话（取最新一个）。
async function findOrCreateSummarySession({ adapterId, periodLabel, cwd, profileId, model }) {
  const list = await ipc.listSessions()
  const shared = list
    .filter(session => session.name === `工作总结（${periodLabel}）` && session.adapterId === adapterId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]
  if (shared) return shared.id
  return sessions.createSession({
    adapterId,
    cwd,
    name: `工作总结（${periodLabel}）`,
    profileId,
    model
  })
}
</script>

<style scoped>
.muted { color:#8c8c8c; margin-top:6px; font-size:12px; }
.hint { color:#8c8c8c; margin-top:8px; font-size:12px; line-height:1.6; }
.hint code { background:#f5f5f5; padding:0 4px; border-radius:3px; }
</style>
