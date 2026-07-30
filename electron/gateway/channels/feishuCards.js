const INTEGRATION = 'ucli-gateway'

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function markdown(content) {
  return { tag: 'markdown', content: text(content, '-') }
}

function actionButton(action) {
  if (!action?.token || !action?.label) return null
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: action.label },
    type: action.type || (action.id === 'execute' ? 'primary' : 'default'),
    behaviors: [{
      type: 'callback',
      value: {
        integration: INTEGRATION,
        token: action.token
      }
    }]
  }
}

function actionElements(actions = []) {
  return actions.map(actionButton).filter(Boolean)
}

function createCard(title, elements, template = 'blue') {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      title: { tag: 'plain_text', content: text(title, 'UCLI Gateway') },
      template
    },
    body: {
      direction: 'vertical',
      elements: elements.filter(Boolean)
    }
  }
}

export function buildRootCard(view = {}) {
  const lines = [
    `**会话：** ${text(view.displayName, '未命名会话')}`,
    `**AI CLI：** ${text(view.adapterLabel, '-')}`,
    `**会话标识：** ${text(view.shortSessionId, '-')}`,
    `**状态：** ${text(view.stateLabel, '等待同步')}`,
    `**队列：** ${Number.isInteger(view.queueCount) ? view.queueCount : 0}`
  ]
  if (view.currentTaskLabel) lines.push(`**当前任务：** ${text(view.currentTaskLabel)}`)
  if (view.latestCompletionLabel) {
    lines.push(`**最近完成：** ${text(view.latestCompletionLabel)}`)
  }
  const actions = view.interruptToken
    ? [{ id: 'interrupt', label: '中断当前任务', token: view.interruptToken }]
    : []
  return createCard(
    'UCLI 会话',
    [markdown(lines.join('\n')), ...actionElements(actions)],
    view.template || 'blue'
  )
}

export function buildDecisionCard(view = {}) {
  const summary = text(view.summary, '请在 UCLI 中处理')
  return createCard(
    text(view.title, '需要用户确认'),
    [markdown(summary), ...actionElements(view.actions)],
    view.desktopOnly ? 'grey' : 'orange'
  )
}

export function buildPlanOverviewCard(view = {}) {
  const overview = view.overview || {}
  const lines = []
  if (overview.goal) lines.push(`**目标**\n${overview.goal}`)
  if (overview.headings?.length) {
    lines.push(`**章节 / 步骤**\n${overview.headings.map((item) => `- ${item}`).join('\n')}`)
  }
  if (overview.filePaths?.length) {
    lines.push(`**涉及文件**\n${overview.filePaths.map((item) => `- \`${item}\``).join('\n')}`)
  }
  lines.push(
    `共 ${overview.headingCount || 0} 个标题、${overview.fileCount || 0} 个文件、${overview.characterCount || 0} 字符`
  )
  const actions = view.viewToken
    ? [{ id: 'view_plan', label: '查看完整方案', token: view.viewToken }]
    : []
  return createCard(
    text(overview.title, '方案概览'),
    [markdown(lines.join('\n\n')), ...actionElements(actions)],
    'purple'
  )
}

export function buildPlanDetailCard(view = {}) {
  const finalChunk = view.index === view.total
  return createCard(
    `${text(view.title, '完整方案')}（${view.index || 1}/${view.total || 1}）`,
    [
      markdown(view.markdown),
      ...actionElements(finalChunk ? view.actions : [])
    ],
    'purple'
  )
}

export function buildCompletionCard(view = {}) {
  const actions = view.resultToken
    ? [{ id: 'view_result', label: '查看完整结果', token: view.resultToken }]
    : []
  return createCard(
    text(view.title, '任务完成'),
    [markdown(view.summary), ...actionElements(actions)],
    view.failed ? 'red' : 'green'
  )
}

export function buildQueueCard(view = {}) {
  return createCard(
    '任务已加入队列',
    [markdown(
      `${text(view.sessionLabel, '当前会话')}：已加入队列，第 ${view.position || 1} 条`
    )],
    'blue'
  )
}

export function buildNoticeCard(view = {}) {
  return createCard(
    'UCLI Gateway',
    [markdown(text(view.message, '该消息无法处理。'))],
    'grey'
  )
}

export function buildInterruptCard(view = {}) {
  const actions = []
  if (view.continueToken) {
    actions.push({
      id: 'continue',
      label: '继续队列',
      token: view.continueToken,
      type: 'primary'
    })
  }
  if (view.clearToken) {
    actions.push({
      id: 'clear',
      label: '清空队列',
      token: view.clearToken,
      type: 'danger'
    })
  }
  return createCard(
    '任务已中断',
    [markdown(view.cancelledTaskLabel), ...actionElements(actions)],
    'orange'
  )
}
