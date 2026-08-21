// 总结任务状态 → 展示文案 / Ant Design 标签配色。卡片、详情、对话抽屉共用，
// 避免三处各自维护一套颜色映射。
export const SUMMARY_TASK_STATUS = {
  starting: { label: '准备中', color: 'blue' },
  running: { label: '运行中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
  interrupted: { label: '中断', color: 'default' }
}

export function taskStatusMeta(status) {
  return SUMMARY_TASK_STATUS[status] || { label: status || '未知', color: 'default' }
}

// 详情页按状态展示的步骤文案。
export function taskStepText(status) {
  return {
    starting: '正在准备材料并启动 CLI…',
    running: 'AI 正在分析并撰写总结…',
    completed: '总结已完成',
    failed: '生成失败',
    interrupted: '生成已中断'
  }[status] || status || ''
}

export function taskErrorText(task) {
  const message = task?.error?.message || task?.error
  return message || taskStepText(task?.status)
}
