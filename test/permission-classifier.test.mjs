import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RULESET } from '../electron/permission/defaultRules.js'
import { classify } from '../electron/permission/classifier.js'

test('default rules allow ordinary removal but confirm recursive removal', () => {
  assert.equal(
    classify({ tool: 'Bash', command: 'rm note.txt' }, DEFAULT_RULESET).classification,
    'default'
  )
  assert.equal(
    classify({ tool: 'Bash', command: 'rm -r build' }, DEFAULT_RULESET).classification,
    'high-risk'
  )
})

test('command prefix rules match Windows command casing', () => {
  assert.equal(
    classify(
      { tool: 'Bash', command: 'remove-item -recurse build' },
      DEFAULT_RULESET
    ).classification,
    'high-risk'
  )
})

test('home-relative secret paths match their absolute Windows location', () => {
  const home = process.env.HOME || process.env.USERPROFILE
  assert.ok(home)
  assert.equal(
    classify(
      { tool: 'Write', path: `${home}\\.aws\\credentials` },
      DEFAULT_RULESET
    ).classification,
    'high-risk'
  )
})
