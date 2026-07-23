export function describeDatabaseRecovery(recoveryInfo) {
  return {
    type: 'warning',
    title: 'UCLI 数据库已恢复',
    message: recoveryInfo.restoredFromBackup
      ? '检测到损坏的数据库，已从上一份有效备份恢复会话与统计。'
      : '检测到损坏的数据库；没有可用备份，已创建新数据库。',
    detail: `损坏文件已保留：${recoveryInfo.backupPath}`
  }
}
