<template>
  <a-modal :open="open" title="生成工作总结" ok-text="生成" @ok="submit" @cancel="close">
    <a-form layout="vertical">
      <a-form-item label="总结周期"><a-segmented v-model:value="form.periodType" :options="periodOptions" /></a-form-item>
      <a-form-item label="周期范围">
        <a-radio-group v-model:value="form.partial"><a-radio :value="false">最近完成周期</a-radio><a-radio :value="true">当前周期（partial）</a-radio></a-radio-group>
        <div class="muted">{{ rangeLabel }}</div>
      </a-form-item>
      <a-form-item label="AI CLI"><a-select v-model:value="form.executorId" :options="executorOptions" /></a-form-item>
      <a-form-item label="配置档案"><a-input v-model:value="form.profileId" allow-clear placeholder="可选" /></a-form-item>
      <a-form-item label="模型"><a-input v-model:value="form.model" allow-clear placeholder="可选" /></a-form-item>
      <a-alert type="warning" show-icon message="可能产生费用" description="材料将通过所选 CLI/Provider 发送给 AI 服务。" />
    </a-form>
  </a-modal>
</template>

<script setup>
import { computed, reactive } from 'vue'

defineProps({ open: Boolean })
const emit = defineEmits(['update:open', 'submit'])
const form = reactive({ periodType: 'week', partial: false, executorId: 'claude', profileId: null, model: null })
const periodOptions = [{ label: '每日', value: 'day' }, { label: '每周', value: 'week' }, { label: '每月', value: 'month' }, { label: '每季度', value: 'quarter' }, { label: '每年', value: 'year' }]
const executorOptions = [{ label: 'Claude', value: 'claude' }, { label: 'Codex', value: 'codex' }, { label: 'OpenCode', value: 'opencode' }, { label: 'U-Code', value: 'ucode' }]
const range = computed(() => periodRange(form.periodType, form.partial))
const rangeLabel = computed(() => `${new Date(range.value.start).toLocaleString()} — ${new Date(range.value.endExclusive).toLocaleString()}`)

function periodRange(periodType, partial) {
  const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0)
  if (periodType === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  if (periodType === 'month') start.setDate(1)
  if (periodType === 'quarter') start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1)
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
function close() { emit('update:open', false) }
function submit() {
  const { start, endExclusive } = range.value
  emit('submit', { periodType: form.periodType, start, endExclusive, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', partial: form.partial, executorId: form.executorId, profileId: form.profileId || null, model: form.model || null })
  close()
}
</script>

<style scoped>
.muted { color:#8c8c8c; margin-top:6px; font-size:12px; }
</style>
