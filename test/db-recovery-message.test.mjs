import test from 'node:test'
import assert from 'node:assert/strict'
import { describeDatabaseRecovery } from '../electron/persistence/recoveryMessage.js'

test('database recovery message explains backup restoration and preserved corrupt file', () => {
  const message = describeDatabaseRecovery({
    reason: 'invalid-database',
    backupPath: 'C:\\Users\\User\\AppData\\Roaming\\ucli\\ucli.db.corrupt-1.bak',
    restoredFromBackup: true
  })

  assert.deepEqual(message, {
    type: 'warning',
    title: 'UCLI 数据库已恢复',
    message: '检测到损坏的数据库，已从上一份有效备份恢复会话与统计。',
    detail: '损坏文件已保留：C:\\Users\\User\\AppData\\Roaming\\ucli\\ucli.db.corrupt-1.bak'
  })
})

test('database recovery message explains when a fresh database was created', () => {
  const message = describeDatabaseRecovery({
    reason: 'invalid-database',
    backupPath: 'C:\\Users\\User\\AppData\\Roaming\\ucli\\ucli.db.corrupt-2.bak',
    restoredFromBackup: false
  })

  assert.equal(message.message, '检测到损坏的数据库；没有可用备份，已创建新数据库。')
  assert.match(message.detail, /ucli\.db\.corrupt-2\.bak/)
})
