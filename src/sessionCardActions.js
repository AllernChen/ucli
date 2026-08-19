export function sessionCardActionItems({ running }) {
  const items = [
    ...(running ? [{ key: 'stop', label: '停止', danger: false }] : []),
    { key: 'restart', label: '重启', danger: false },
    { key: 'rename', label: '重命名', danger: false },
    { key: 'configure', label: '配置', danger: false },
    { key: 'delete', label: '删除', danger: true }
  ]
  return items
}
