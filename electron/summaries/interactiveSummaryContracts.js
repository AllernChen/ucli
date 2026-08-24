export const SUMMARY_EXECUTION_MODE = Object.freeze({
  ISOLATED_RUNNER: 'isolated-runner',
  INTERACTIVE_CLI: 'interactive-cli',
  LEGACY_WORKLOG_IMPORT: 'legacy-worklog-import'
})

export const INTERACTIVE_SUMMARY_PHASE = Object.freeze({
  PREPARING: 'preparing',
  STARTING: 'starting',
  AWAITING_DELIVERY: 'awaiting-delivery',
  RUNNING: 'running',
  VALIDATING: 'validating',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  CANCELLED: 'cancelled'
})

export const INTERACTIVE_SUMMARY_TERMINAL_PHASES = Object.freeze(new Set([
  INTERACTIVE_SUMMARY_PHASE.COMPLETED,
  INTERACTIVE_SUMMARY_PHASE.FAILED,
  INTERACTIVE_SUMMARY_PHASE.INTERRUPTED,
  INTERACTIVE_SUMMARY_PHASE.CANCELLED
]))

const INTERACTIVE_SUMMARY_PHASES = new Set(Object.values(INTERACTIVE_SUMMARY_PHASE))

const SAFE_MESSAGES = Object.freeze({
  SUMMARY_READY_TIMEOUT: 'AI CLI 启动超时',
  SUMMARY_TURN_NOT_CONFIRMED: '生成指令未确认送达',
  SUMMARY_RUN_TIMEOUT: '工作总结生成超时',
  SUMMARY_ARTIFACT_INVALID: '生成的 Markdown 报告无效',
  SUMMARY_RUN_FAILED: '工作总结生成失败'
})

export function assertInteractiveSummaryPhase(value) {
  if (!INTERACTIVE_SUMMARY_PHASES.has(value)) {
    throw Object.assign(new TypeError('Invalid interactive summary phase'), {
      code: 'SUMMARY_RUN_PHASE_INVALID'
    })
  }
  return value
}

export function safeInteractiveSummaryError(error, fallbackCode) {
  const requestedCode = Object.hasOwn(SAFE_MESSAGES, error?.code)
    ? error.code
    : fallbackCode
  const code = Object.hasOwn(SAFE_MESSAGES, requestedCode)
    ? requestedCode
    : 'SUMMARY_RUN_FAILED'
  return { code, message: SAFE_MESSAGES[code] }
}
