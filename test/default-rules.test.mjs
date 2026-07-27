import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RULESET,
  LEGACY_DEFAULT_RULESET,
  upgradeDefaultRuleset
} from '../electron/permission/defaultRules.js'

test('default safety rules reserve confirmation for materially dangerous operations', () => {
  assert.ok(DEFAULT_RULESET.highRisk.includes('Bash(git push:*)'))
  assert.ok(DEFAULT_RULESET.highRisk.includes('Bash(git reset --hard:*)'))
  assert.ok(DEFAULT_RULESET.highRisk.includes('Bash(docker system prune:*)'))
  assert.ok(DEFAULT_RULESET.highRisk.includes('Bash(sudo:*)'))

  assert.ok(!DEFAULT_RULESET.highRisk.includes('Bash(rm:*)'))
  assert.ok(!DEFAULT_RULESET.highRisk.includes('Bash(rmdir:*)'))
  assert.ok(!DEFAULT_RULESET.highRisk.includes('Bash(docker rm:*)'))
  assert.ok(!DEFAULT_RULESET.highRisk.includes('Bash(docker rmi:*)'))
  assert.ok(!DEFAULT_RULESET.highRisk.includes('Bash(chmod:*)'))
  assert.ok(!DEFAULT_RULESET.highRisk.includes('Write(.env*)'))
  assert.ok(!DEFAULT_RULESET.highRisk.includes('Edit(.env*)'))
})

test('upgrades the untouched v0.4.3 default rules while preserving customized rules', () => {
  assert.deepEqual(
    upgradeDefaultRuleset(structuredClone(LEGACY_DEFAULT_RULESET)),
    DEFAULT_RULESET
  )

  const customized = structuredClone(LEGACY_DEFAULT_RULESET)
  customized.highRisk.push('Bash(custom deploy:*)')
  assert.deepEqual(upgradeDefaultRuleset(customized), customized)
})
