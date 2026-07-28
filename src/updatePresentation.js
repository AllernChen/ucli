const STATUS_LABELS = {
  idle: '尚未检查',
  checking: '正在检查更新',
  available: '发现新版本',
  downloading: '正在下载更新',
  downloaded: '更新已就绪',
  'not-available': '已是最新版本',
  unsupported: '此版本请手动更新',
  error: '检查更新失败'
}

export function updateStatusLabel(status) {
  return STATUS_LABELS[status] || '未知状态'
}

export function visibleReleaseNotes(value = '') {
  return String(value).replace(/<[^>]*>/g, '').trim().slice(0, 4000)
}
