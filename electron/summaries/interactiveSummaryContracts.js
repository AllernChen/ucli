export const SUMMARY_EXECUTION_MODE = Object.freeze({
  ISOLATED_RUNNER: 'isolated-runner',
  INTERACTIVE_CLI: 'interactive-cli',
  LEGACY_WORKLOG_IMPORT: 'legacy-worklog-import'
})

// Claude may need two bounded 8-second transcript-confirmation attempts on a
// cold TUI start. Keep the outer fail-closed deadline longer than that adapter
// acceptance cycle, and share it between the job service and session runtime.
export const INTERACTIVE_SUMMARY_DELIVERY_TIMEOUT_MS = 30_000

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

const INTERACTIVE_SUMMARY_TERMINAL_PHASE_VALUES = new Set([
  INTERACTIVE_SUMMARY_PHASE.COMPLETED,
  INTERACTIVE_SUMMARY_PHASE.FAILED,
  INTERACTIVE_SUMMARY_PHASE.INTERRUPTED,
  INTERACTIVE_SUMMARY_PHASE.CANCELLED
])

export const INTERACTIVE_SUMMARY_TERMINAL_PHASES = Object.freeze({
  get size() {
    return INTERACTIVE_SUMMARY_TERMINAL_PHASE_VALUES.size
  },
  has(value) {
    return INTERACTIVE_SUMMARY_TERMINAL_PHASE_VALUES.has(value)
  },
  [Symbol.iterator]() {
    return INTERACTIVE_SUMMARY_TERMINAL_PHASE_VALUES[Symbol.iterator]()
  }
})

const INTERACTIVE_SUMMARY_PHASES = new Set(Object.values(INTERACTIVE_SUMMARY_PHASE))

const SAFE_MESSAGES = Object.freeze({
  SUMMARY_READY_TIMEOUT: 'AI CLI 启动超时',
  SUMMARY_TURN_NOT_CONFIRMED: '生成指令未确认送达',
  SUMMARY_RUN_TIMEOUT: '工作总结生成超时',
  SUMMARY_ARTIFACT_MISSING: '未生成 Markdown 报告',
  SUMMARY_ARTIFACT_INVALID: '生成的 Markdown 报告无效',
  SUMMARY_PROFILE_UNAVAILABLE: '所选 AI CLI 配置不可用',
  SUMMARY_APP_SHUTDOWN: '应用关闭，工作总结已中断',
  SUMMARY_RUN_FAILED: '工作总结生成失败'
})

const PERSISTED_SUMMARY_ERROR_CODES = new Set([
  'SUMMARY_GENERATION_FAILED',
  'SUMMARY_CANCELLED',
  'SUMMARY_EMPTY_EVIDENCE',
  'SUMMARY_MANUAL_CONFIRMATION_REQUIRED',
  'SUMMARY_PROCESS_RESTARTED',
  'SUMMARY_AUTOMATIC_CALL_LIMIT',
  'SUMMARY_INPUT_BUDGET_TOO_SMALL',
  'SUMMARY_PIPELINE_ABORTED',
  'SUMMARY_PROMPT_BUDGET_EXCEEDED',
  'SUMMARY_REDUCTION_NOT_CONVERGING',
  'SUMMARY_RUNNER_ABORTED',
  'SUMMARY_RUNNER_EXECUTABLE_NOT_FOUND',
  'SUMMARY_RUNNER_EXIT',
  'SUMMARY_RUNNER_INVALID_JSON',
  'SUMMARY_RUNNER_PROFILE_UNAVAILABLE',
  'SUMMARY_RUNNER_PROFILE_UNSUPPORTED',
  'SUMMARY_RUNNER_SCHEMA_INVALID',
  'SUMMARY_RUNNER_SPAWN',
  'SUMMARY_RUNNER_STDIN',
  'SUMMARY_RUNNER_TIMEOUT',
  'SUMMARY_RUNNER_UNSUPPORTED_EXECUTOR',
  'SUMMARY_STORAGE_PATH_UNSAFE',
  'SUMMARY_WORKSPACE_LIMIT',
  'SUMMARY_WORKSPACE_PROTECTION_CHECK_INVALID',
  'SUMMARY_WORKSPACE_QUOTA_INVALID',
  'SUMMARY_WORKSPACE_RETENTION_CHECK_INVALID',
  'SUMMARY_WORKSPACE_RETENTION_INVALID',
  'SUMMARY_WORKSPACE_STAGE_INVALID',
  ...Object.keys(SAFE_MESSAGES)
])
const AUTOMATIC_DUPLICATE_ERROR = /^SUMMARY_AUTOMATIC_DUPLICATE:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export function isPersistedSummaryErrorCode(value) {
  return typeof value === 'string' && PERSISTED_SUMMARY_ERROR_CODES.has(value)
}

export function isPersistedSummaryErrorText(value) {
  return value === null || isPersistedSummaryErrorCode(value) ||
    (typeof value === 'string' && AUTOMATIC_DUPLICATE_ERROR.test(value))
}

export function summaryAutomaticDuplicateReportId(value) {
  return typeof value === 'string' ? AUTOMATIC_DUPLICATE_ERROR.exec(value)?.[1] ?? null : null
}

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
