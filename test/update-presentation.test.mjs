import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as updatePresentation from '../src/updatePresentation.js'

test('update presentation labels every update state in Chinese', () => {
  assert.equal(updatePresentation.updateStatusLabel('idle'), '尚未检查')
  assert.equal(updatePresentation.updateStatusLabel('checking'), '正在检查更新')
  assert.equal(updatePresentation.updateStatusLabel('available'), '发现新版本')
  assert.equal(updatePresentation.updateStatusLabel('downloading'), '正在下载更新')
  assert.equal(updatePresentation.updateStatusLabel('downloaded'), '更新已就绪')
  assert.equal(updatePresentation.updateStatusLabel('installing'), '正在启动安装程序')
  assert.equal(updatePresentation.updateStatusLabel('not-available'), '已是最新版本')
  assert.equal(updatePresentation.updateStatusLabel('unsupported'), '此版本请手动更新')
  assert.equal(updatePresentation.updateStatusLabel('error'), '检查更新失败')
  assert.equal(updatePresentation.updateStatusLabel('other'), '未知状态')
})

test('release notes stay plain text and bounded', () => {
  assert.equal(updatePresentation.visibleReleaseNotes('<b>Fix</b>\nDetails'), 'Fix\nDetails')
  assert.equal(updatePresentation.visibleReleaseNotes('x'.repeat(5000)).length, 4000)
})

test('download progress has a readable percentage and transfer detail', () => {
  assert.equal(typeof updatePresentation.updateProgressText, 'function')
  assert.equal(updatePresentation.updateProgressText({
    status: 'downloading',
    progressPercent: 42,
    transferred: 10 * 1024 * 1024,
    total: 24 * 1024 * 1024,
    bytesPerSecond: 2 * 1024 * 1024
  }), '已下载 42%（10.0 MB / 24.0 MB，2.0 MB/s）')
})

test('settings renders download progress and explains the installation handoff', () => {
  const source = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')

  assert.match(source, /<a-progress[^>]*:percent="updateState\.progressPercent \?\? 0"/)
  assert.match(source, /{{ updateProgressText\(updateState\) }}/)
  assert.match(source, /v-if="updateState\?\.status === 'installing'"/)
})

test('settings derives update button loading from the explicit update phase', () => {
  const source = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /updateBusy/)
  assert.match(source, /:loading="updateState\?\.status === 'checking'"/)
  assert.match(source, /:loading="updateState\?\.status === 'downloading'"/)
  assert.match(source, /:loading="updateState\?\.status === 'installing'"/)
})
