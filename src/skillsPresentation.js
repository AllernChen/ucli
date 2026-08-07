const STATUSES = {
  ready: { label: '可用', color: 'green' },
  disabled: { label: '已停用', color: 'default' },
  drifted: { label: '已被外部修改', color: 'orange' },
  conflict: { label: '同名内容冲突', color: 'red' },
  missing: { label: '投放文件缺失', color: 'red' },
  invalid: { label: 'Skill 无效', color: 'red' },
  update_available: { label: '有可用更新', color: 'blue' },
  mirror: { label: '兼容镜像', color: 'cyan' }
}

const ORIGINS = {
  managed: 'UCLI 托管',
  external: '现有 Skill',
  bundled: 'CLI 内置',
  system: 'CLI 系统'
}

const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', ucode: 'U-Code' }

export function skillStatusPresentation(status) {
  return STATUSES[status] || { label: '未知状态', color: 'default' }
}

export function skillOriginLabel(origin) {
  return ORIGINS[origin] || '未知来源'
}

export function skillCliName(adapterId) {
  return CLI_NAMES[adapterId] || adapterId || '未知 CLI'
}

export function skillVisibilitySummary(visibility = {}) {
  if (visibility.direct) return '直接投放'
  if (visibility.inheritedFrom?.length) {
    return `从 ${visibility.inheritedFrom.map(skillCliName).join('、')} 兼容继承`
  }
  return '不可见'
}

export function skillSourceLabel(pkg = {}) {
  if (pkg.sourceType === 'github') return 'GitHub'
  if (pkg.sourceType === 'zip') return '本地 ZIP'
  if (pkg.sourceType === 'adopted') return '接管现有 Skill'
  return '本地目录'
}
