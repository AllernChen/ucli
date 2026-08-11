export const projectDigestSchema = Object.freeze({
  type: 'object',
  required: [
    'project', 'accomplishments', 'status', 'blockers', 'nextSteps', 'evidenceRefs', 'confidence'
  ],
  additionalProperties: false,
  properties: {
    project: { type: 'string' },
    accomplishments: { type: 'array', items: { type: 'string' } },
    status: { enum: ['not_started', 'in_progress', 'blocked', 'completed', 'unclear'] },
    blockers: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    confidence: { enum: ['low', 'medium', 'high'] }
  }
})

export const finalReportSchema = Object.freeze({
  type: 'object',
  required: [
    'executiveSummary',
    'usageAnalysis',
    'projectDigests',
    'crossProjectObservations',
    'prioritizedNextSteps',
    'coverageNotes'
  ],
  additionalProperties: false,
  properties: {
    executiveSummary: { type: 'string' },
    usageAnalysis: {
      type: 'object',
      required: ['summary', 'observations'],
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        observations: { type: 'array', items: { type: 'string' } }
      }
    },
    projectDigests: { type: 'array', items: projectDigestSchema },
    crossProjectObservations: { type: 'array', items: { type: 'string' } },
    prioritizedNextSteps: { type: 'array', items: { type: 'string' } },
    coverageNotes: { type: 'array', items: { type: 'string' } }
  }
})

function bulletList(values) {
  const items = Array.isArray(values) ? values : []
  return items.length ? items.map((value) => `- ${value}`).join('\n') : '- 无'
}

const STATUS_LABELS = {
  not_started: '未开始',
  in_progress: '进行中',
  blocked: '受阻',
  completed: '已完成',
  unclear: '不明确'
}

export function renderSummaryMarkdown(report) {
  const sections = [
    '## 摘要',
    String(report.executiveSummary || ''),
    '',
    '## 使用量分析',
    String(report.usageAnalysis?.summary || ''),
    bulletList(report.usageAnalysis?.observations),
    '',
    '## 项目进展'
  ]
  for (const project of report.projectDigests || []) {
    sections.push(
      `### ${project.project}`,
      `- 状态：${STATUS_LABELS[project.status] || project.status}`,
      `- 置信度：${project.confidence}`,
      '#### 已完成工作',
      bulletList(project.accomplishments),
      '#### 阻塞与风险',
      bulletList([...(project.blockers || []), ...(project.risks || [])]),
      '#### 项目下一步',
      bulletList(project.nextSteps),
      '#### 证据引用',
      bulletList(project.evidenceRefs),
      ''
    )
  }
  sections.push(
    '## 跨项目观察',
    bulletList(report.crossProjectObservations),
    '',
    '## 下一步建议',
    bulletList(report.prioritizedNextSteps),
    '',
    '## 数据覆盖',
    bulletList(report.coverageNotes)
  )
  return sections.join('\n').trimEnd()
}
