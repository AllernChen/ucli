const PERIOD_LABELS = Object.freeze({
  day: '每日', week: '每周', month: '每月', quarter: '每季度', year: '每年'
})

const STATUS = Object.freeze({
  queued: { label: '等待生成', color: 'default', detail: '等待生成' },
  running: { label: '正在生成', color: 'processing', detail: '正在生成总结' },
  awaiting_confirmation: { label: '等待确认', color: 'warning', detail: '等待确认' },
  completed: { label: '已完成', color: 'green', detail: '总结已生成' },
  failed: { label: '生成失败', color: 'red', detail: '总结生成失败' },
  cancelled: { label: '已取消', color: 'default', detail: '生成已取消' },
  interrupted: { label: '已中断', color: 'default', detail: '生成已中断' },
  skipped_empty: { label: '无可总结内容', color: 'default', detail: '周期内没有可总结内容' }
})

const PHASE_DETAIL = Object.freeze({
  preparing: '正在准备材料',
  starting: '正在启动 AI CLI',
  'awaiting-delivery': '正在投递生成指令',
  running: '正在生成总结',
  validating: '正在验证 Markdown 报告'
})

const ERROR_META = Object.freeze({
  SUMMARY_READY_TIMEOUT: Object.freeze({
    code: 'SUMMARY_READY_TIMEOUT',
    message: 'AI CLI 启动超时。',
    action: '请检查 AI CLI 后重试。'
  }),
  SUMMARY_ARTIFACT_INVALID: Object.freeze({
    code: 'SUMMARY_ARTIFACT_INVALID',
    message: '报告已生成，但内容结构或安全校验未通过。',
    action: '请检查生成内容后重试。'
  }),
  SUMMARY_ARTIFACT_MISSING: Object.freeze({
    code: 'SUMMARY_ARTIFACT_MISSING',
    message: 'AI CLI 未写出报告文件。',
    action: '请确认 AI CLI 已完成后重试。'
  }),
  SUMMARY_TURN_NOT_CONFIRMED: Object.freeze({
    code: 'SUMMARY_TURN_NOT_CONFIRMED',
    message: '生成指令未确认送达 AI CLI。',
    action: '请重新生成总结。'
  }),
  SUMMARY_RUN_TIMEOUT: Object.freeze({
    code: 'SUMMARY_RUN_TIMEOUT',
    message: '生成超过允许时间。',
    action: '请重试生成总结。'
  }),
  SUMMARY_PROFILE_UNAVAILABLE: Object.freeze({
    code: 'SUMMARY_PROFILE_UNAVAILABLE',
    message: '所选 AI CLI 配置不可用。',
    action: '请检查配置后重试。'
  }),
  SUMMARY_APP_SHUTDOWN: Object.freeze({
    code: 'SUMMARY_APP_SHUTDOWN',
    message: '应用关闭，工作总结已中断。',
    action: '请重新打开应用后重试。'
  }),
  SUMMARY_RUN_FAILED: Object.freeze({
    code: 'SUMMARY_RUN_FAILED',
    message: '工作总结生成失败。',
    action: '请重试生成总结。'
  })
})

function invalidMetadata(message) {
  return Object.assign(new TypeError(message), { code: 'INVALID_SUMMARY_TASK_METADATA' })
}

export function buildSummaryTaskTitle({ periodType, createdAt, timezone }) {
  const label = PERIOD_LABELS[periodType]
  if (!label || !Number.isSafeInteger(createdAt) || typeof timezone !== 'string') {
    throw invalidMetadata('Invalid summary task title input')
  }
  let parts
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(createdAt)).map(part => [part.type, part.value]))
  } catch {
    throw invalidMetadata('Invalid summary task title input')
  }
  return `工作总结（${label}）${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function normalizeSummaryTaskMetadata({ title, taskNote } = {}) {
  if (typeof title !== 'string' || /[\u0000-\u001f\u007f]/.test(title)) {
    throw invalidMetadata('Invalid summary task metadata')
  }
  const safeTitle = title.trim()
  const safeNote = typeof taskNote === 'string' ? taskNote.replace(/\r\n?/g, '\n') : ''
  if (!safeTitle || safeTitle.length > 120 ||
    safeNote.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(safeNote)) {
    throw invalidMetadata('Invalid summary task metadata')
  }
  return { title: safeTitle, taskNote: safeNote }
}

export function summaryTaskStatusMeta(report = {}, progress = null) {
  const status = STATUS[report.status] || STATUS.running
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty']
    .includes(report.status)
  return {
    ...status,
    detail: terminal ? status.detail : progress?.text || PHASE_DETAIL[report.runPhase] || status.detail
  }
}

export function summaryTaskErrorMeta(errorText) {
  return Object.hasOwn(ERROR_META, errorText)
    ? ERROR_META[errorText]
    : ERROR_META.SUMMARY_RUN_FAILED
}
