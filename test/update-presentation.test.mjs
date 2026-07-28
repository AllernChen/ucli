import test from 'node:test'
import assert from 'node:assert/strict'
import { updateStatusLabel, visibleReleaseNotes } from '../src/updatePresentation.js'

test('update presentation labels every update state in Chinese', () => {
  assert.equal(updateStatusLabel('idle'), '尚未检查')
  assert.equal(updateStatusLabel('checking'), '正在检查更新')
  assert.equal(updateStatusLabel('available'), '发现新版本')
  assert.equal(updateStatusLabel('downloading'), '正在下载更新')
  assert.equal(updateStatusLabel('downloaded'), '更新已就绪')
  assert.equal(updateStatusLabel('not-available'), '已是最新版本')
  assert.equal(updateStatusLabel('unsupported'), '此版本请手动更新')
  assert.equal(updateStatusLabel('error'), '检查更新失败')
  assert.equal(updateStatusLabel('other'), '未知状态')
})

test('release notes stay plain text and bounded', () => {
  assert.equal(visibleReleaseNotes('<b>Fix</b>\nDetails'), 'Fix\nDetails')
  assert.equal(visibleReleaseNotes('x'.repeat(5000)).length, 4000)
})
