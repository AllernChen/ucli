import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  skillOriginLabel,
  skillStatusPresentation,
  skillVisibilitySummary
} from '../src/skillsPresentation.js'

test('Skills presentation makes managed states actionable', () => {
  assert.deepEqual(skillStatusPresentation('ready'), { label: '可用', color: 'green' })
  assert.deepEqual(skillStatusPresentation('update_available'), { label: '有可用更新', color: 'blue' })
  assert.equal(skillStatusPresentation('drifted').label, '已被外部修改')
  assert.equal(skillStatusPresentation('conflict').color, 'red')
  assert.equal(skillOriginLabel('bundled'), 'CLI 内置')
})

test('visibility summary distinguishes direct and inherited CLI access', () => {
  assert.equal(skillVisibilitySummary({ direct: true, inheritedFrom: [] }), '直接投放')
  assert.equal(skillVisibilitySummary({ direct: false, inheritedFrom: ['codex'] }), '从 Codex 兼容继承')
  assert.equal(skillVisibilitySummary({ visible: false, direct: false, inheritedFrom: [] }), '不可见')
})

test('Skills is a first-level route with managed and discovered workflows', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const router = readFileSync(new URL('../src/router.js', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(router, /path:\s*'\/skills'/)
  assert.match(app, /key="\/skills"/)
  assert.match(page, /已管理/)
  assert.match(page, /已发现/)
  assert.match(page, /安装 Skill/)
  assert.match(page, /接管/)
  assert.match(page, /兼容继承/)
  assert.doesNotMatch(page, /编辑 SKILL\.md/)
})
