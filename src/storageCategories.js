export const STORAGE_CATEGORY_PRESENTATION = Object.freeze({
  'core-data': Object.freeze({ label: '核心数据', description: '数据库、配置、会话索引与窗口状态' }),
  'installed-skills': Object.freeze({ label: '已安装 Skills', description: '由 UCLI 管理并保留的 Skills' }),
  'other-user-data': Object.freeze({ label: '其他应用数据', description: 'UCLI 数据目录内未单独分类的受保护文件' }),
  'summary-cache': Object.freeze({ label: '总结缓存', description: '可重新生成的 AI 中间结果' }),
  'summary-workspaces': Object.freeze({ label: '总结工作区', description: '可重新生成的非活动派生文件' }),
  'browser-cache': Object.freeze({ label: '浏览器缓存', description: 'UCLI 界面运行所用的 Chromium 缓存' }),
  'skill-staging': Object.freeze({ label: 'Skills 临时区', description: '安装 Skills 时产生的来源暂存数据' }),
  'update-downloads': Object.freeze({ label: '更新下载', description: '软件更新器已下载的临时文件' }),
  logs: Object.freeze({ label: '运行日志', description: 'UCLI 当前运行日志' })
})

export function storageCategoryPresentation(categoryId) {
  return STORAGE_CATEGORY_PRESENTATION[categoryId] || {
    label: '未知分类', description: '无法识别的应用数据'
  }
}
