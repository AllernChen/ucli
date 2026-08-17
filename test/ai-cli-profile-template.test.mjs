import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('profile center is a first-level route with five honest CLI entries', () => {
  const app = read('../src/App.vue')
  const router = read('../src/router.js')
  const page = read('../src/views/ProfileCenter.vue')
  assert.match(router, /path:\s*'\/profiles'/)
  assert.match(app, /key="\/profiles"/)
  assert.match(app, /配置档案/)
  for (const cli of ['Codex', 'Claude Code', 'OpenCode', 'U-Code', 'DeepSeek Harness']) assert.match(page, new RegExp(cli))
  assert.match(page, /\$\{appVersion\}/)
})

test('profile center exposes cards, defaults, revisions, and explicit repair without showing secrets', () => {
  const page = read('../src/views/ProfileCenter.vue')
  const drawer = read('../src/components/profiles/CodexProfileDrawer.vue')
  const revisions = read('../src/components/profiles/ProfileRevisionDrawer.vue')
  assert.match(page, /profile-card-grid/)
  assert.match(page, /新建档案/)
  assert.match(page, /设为应用默认/)
  assert.match(page, /设为项目默认/)
  assert.match(page, /重新读取/)
  assert.match(page, /用 UCLI 版本覆盖|重新生成/)
  assert.match(page, /版本记录/)
  assert.match(drawer, /Responses/)
  assert.match(drawer, /高级设置/)
  assert.match(drawer, /上下文窗口只是发给 Codex 的配置提示/)
  assert.match(revisions, /回滚到此版本/)
  assert.doesNotMatch(page + drawer + revisions, /显示密钥|查看密钥|明文密钥/)
})
