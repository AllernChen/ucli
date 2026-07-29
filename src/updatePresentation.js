const STATUS_LABELS = {
  idle: '尚未检查',
  checking: '正在检查更新',
  available: '发现新版本',
  downloading: '正在下载更新',
  downloaded: '更新已就绪',
  installing: '正在启动安装程序',
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

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function updateProgressText({ status, progressPercent, transferred, total, bytesPerSecond } = {}) {
  if (status !== 'downloading') return ''
  const percent = Number.isFinite(progressPercent) ? `${Math.round(progressPercent)}%` : '…'
  const transferredText = formatBytes(transferred)
  const totalText = formatBytes(total)
  const speedText = formatBytes(bytesPerSecond)
  const details = [
    transferredText && totalText ? `${transferredText} / ${totalText}` : '',
    speedText ? `${speedText}/s` : ''
  ].filter(Boolean)
  return details.length ? `已下载 ${percent}（${details.join('，')}）` : `已下载 ${percent}`
}
