<template>
  <div class="task-summary">
    <div class="summary-header">
      <span class="summary-icon">📋</span>
      <span class="summary-title">任务总结</span>
      <a-tag v-if="isRunning" color="processing" size="small">进行中</a-tag>
      <a-tag v-else-if="hasActivity" color="success" size="small">空闲</a-tag>
      <a-tag v-else color="default" size="small">等待中</a-tag>
    </div>

    <div v-if="!hasActivity" class="summary-empty">
      尚无活动，发送消息开始对话。
    </div>

    <div v-else class="summary-body">
      <!-- 当前任务 -->
      <div class="summary-section">
        <div class="section-label">🎯 当前任务</div>
        <div class="section-content task-text">{{ currentTask || '—' }}</div>
      </div>

      <!-- 当前步骤 -->
      <div class="summary-section">
        <div class="section-label">⚡ 当前步骤</div>
        <div class="section-content">
          <span v-if="currentStep" class="step-item">
            <span class="step-icon">{{ currentStepIcon }}</span>
            {{ currentStepText }}
          </span>
          <span v-else class="muted">—</span>
        </div>
      </div>

      <!-- 进度 -->
      <div v-if="completedSteps.length" class="summary-section">
        <div class="section-label">📊 进度 ({{ completedSteps.length }} 步完成)</div>
        <div class="section-content progress-list">
          <div v-for="(step, i) in recentSteps" :key="i" :class="['progress-step', step.status]">
            <span class="step-status">{{ step.status === 'done' ? '✅' : step.status === 'error' ? '❌' : '⏳' }}</span>
            <span class="step-desc">{{ step.desc }}</span>
          </div>
        </div>
      </div>

      <!-- 下一步建议 -->
      <div class="summary-section">
        <div class="section-label">💡 下一步</div>
        <div class="section-content suggestion">{{ nextStepSuggestion }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  activities: { type: Array, required: true, default: () => [] }
})

const hasActivity = computed(() => props.activities.length > 0)

const isRunning = computed(() => {
  const last = lastActivity.value
  return last && ['tool_call', 'reasoning'].includes(last.type)
})

function findLast(predicate) {
  for (let i = props.activities.length - 1; i >= 0; i--) {
    if (predicate(props.activities[i])) return props.activities[i]
  }
  return null
}

function findAll(predicate) {
  return props.activities.filter(predicate)
}

const lastActivity = computed(() => props.activities[props.activities.length - 1] || null)

// --- 当前任务：最近一条用户消息 ---
const currentTask = computed(() => {
  const userMsg = findLast(a => a.type === 'message' && a.role === 'user')
  return userMsg?.text || null
})

// --- 当前步骤 ---
const currentStep = computed(() => {
  const toolCalls = findAll(a => a.type === 'tool_call')
  const toolResults = findAll(a => a.type === 'tool_result')
  const resultIds = new Set(toolResults.map(r => r.toolUseId).filter(Boolean))

  // 没有 result 的 tool_call = 正在执行
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]
    if (tc.toolUseId && !resultIds.has(tc.toolUseId)) {
      return { ...tc, phase: 'running' }
    }
  }

  const lastMsg = findLast(a => a.type === 'message' && a.role === 'assistant')
  if (lastMsg) return { ...lastMsg, phase: 'done' }

  const lastTool = findLast(a => a.type === 'tool_call')
  if (lastTool) return { ...lastTool, phase: 'done' }

  return null
})

const currentStepIcon = computed(() => {
  if (!currentStep.value) return ''
  if (currentStep.value.phase === 'running') return '⏳'
  if (currentStep.value.type === 'tool_call') return '🔧'
  if (currentStep.value.type === 'message') return '🤖'
  return '📌'
})

const currentStepText = computed(() => {
  const s = currentStep.value
  if (!s) return ''
  if (s.type === 'tool_call') {
    const args = s.input?.command || s.input?.file_path || s.input?.path || ''
    return `${s.tool}: ${args}`.slice(0, 120)
  }
  if (s.type === 'message') return (s.text || '').slice(0, 120)
  if (s.type === 'reasoning') return '思考中…'
  return s.type
})

// --- 已完成步骤 ---
const completedSteps = computed(() => {
  const steps = []
  const toolCalls = findAll(a => a.type === 'tool_call')
  const toolResults = findAll(a => a.type === 'tool_result')
  const resultMap = {}
  for (const r of toolResults) {
    if (r.toolUseId) resultMap[r.toolUseId] = r
  }

  for (const tc of toolCalls) {
    const result = tc.toolUseId ? resultMap[tc.toolUseId] : null
    if (result) {
      steps.push({
        desc: `${tc.tool}: ${(tc.input?.command || tc.input?.file_path || tc.input?.path || '').slice(0, 80)}`,
        status: result.isError ? 'error' : 'done'
      })
    }
  }
  return steps
})

const recentSteps = computed(() => completedSteps.value.slice(-8))

// --- 下一步建议 ---
const nextStepSuggestion = computed(() => {
  const last = lastActivity.value
  if (!last) return '发送消息开始对话。'
  if (last.type === 'turn_complete') return '查看结果，决定是否继续或发送新指令。'
  if (last.type === 'message' && last.role === 'assistant') return '查看助手回复，发送后续指令。'
  if (last.type === 'tool_call') return '等待工具执行完成…'
  if (last.type === 'error') return '出现错误，检查后重试或调整指令。'
  if (last.type === 'exit') return '进程已退出，可重新启动会话。'
  return '查看最新活动，决定下一步操作。'
})
</script>

<style scoped>
.task-summary {
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  margin-bottom: 8px;
  overflow: hidden;
}
.summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: linear-gradient(135deg, #f6ffed 0%, #e6f4ff 100%);
  border-bottom: 1px solid #e8e8e8;
}
.summary-icon { font-size: 16px; }
.summary-title { font-weight: 600; font-size: 14px; }
.summary-empty { padding: 16px; text-align: center; color: #bfbfbf; font-size: 13px; }
.summary-body { padding: 8px 12px; }
.summary-section { margin-bottom: 8px; }
.summary-section:last-child { margin-bottom: 0; }
.section-label { font-size: 12px; font-weight: 600; color: #595959; margin-bottom: 4px; }
.section-content { font-size: 13px; color: #262626; line-height: 1.5; }
.task-text { background: #f5f5f5; padding: 6px 8px; border-radius: 4px; max-height: 60px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.step-item { display: flex; align-items: center; gap: 6px; }
.step-icon { flex-shrink: 0; }
.progress-list { display: flex; flex-direction: column; gap: 3px; }
.progress-step { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 6px; border-radius: 3px; }
.progress-step.done { color: #52c41a; }
.progress-step.error { color: #ff4d4f; background: #fff2f0; }
.step-status { flex-shrink: 0; }
.step-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #595959; }
.suggestion { background: #fffbe6; padding: 6px 8px; border-radius: 4px; border-left: 3px solid #faad14; font-size: 12px; }
.muted { color: #bfbfbf; }
</style>
