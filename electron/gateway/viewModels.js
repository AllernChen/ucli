import { prepareDecisionSummary, redactDisplayText } from './redaction.js'

export function buildDecisionView(decision) {
  const summary = prepareDecisionSummary(decision?.summary || '')
  return {
    kind: decision?.kind || 'terminal_prompt',
    title: decision?.title || '需要用户处理',
    summary: summary.summary,
    options: Array.isArray(decision?.options)
      ? decision.options.map((option) => ({
          id: option.id,
          label: option.label,
          description: redactDisplayText(option.description || '').text
        }))
      : [],
    responseMode: decision?.responseMode || 'single',
    desktopOnly: summary.desktopOnly,
    actions: summary.actions
  }
}

export function buildPlanUnavailableView() {
  return {
    available: false,
    message: '无法可靠提取完整方案，请在 UCLI 中处理',
    actions: []
  }
}

export function buildResultUnavailableView() {
  return {
    available: false,
    message: '无法可靠提取完整结果，请在 UCLI 中查看',
    actions: []
  }
}

export function planReviewActions() {
  return [
    { id: 'execute', label: '执行方案' },
    { id: 'reject', label: '拒绝' },
    { id: 'revise', label: '回复修改意见' }
  ]
}
