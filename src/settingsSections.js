export const SETTINGS_SECTIONS = Object.freeze([
  { id: 'general', label: '常规设置' },
  { id: 'gateway', label: '通信 Gateway' },
  { id: 'cli', label: 'AI CLI' },
  { id: 'summaries', label: '工作总结' },
  { id: 'storage', label: '空间管理' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'updates', label: '软件更新' },
  { id: 'support', label: '支持诊断' },
  { id: 'about', label: '关于' }
])

const SETTINGS_SECTION_IDS = new Set(SETTINGS_SECTIONS.map(item => item.id))

export function normalizeSettingsSection(value) {
  return typeof value === 'string' && SETTINGS_SECTION_IDS.has(value) ? value : 'general'
}
