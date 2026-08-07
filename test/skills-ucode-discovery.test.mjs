import assert from 'node:assert/strict'
import test from 'node:test'

import { listUCodeSkills, parseUCodeSkillOutput } from '../electron/skills/ucodeDiscovery.js'

test('U-Code debug skill output is reduced to safe discovery metadata', () => {
  const result = parseUCodeSkillOutput(JSON.stringify([
    {
      name: 'ucode-docs',
      description: 'U-Code documentation',
      location: 'C:\\Users\\demo\\.cache\\ucode\\skills\\ucode-docs\\SKILL.md',
      content: 'large private instructions',
      bundled: true,
      hidden: false
    }
  ]))
  assert.deepEqual(result, [{
    name: 'ucode-docs',
    description: 'U-Code documentation',
    path: 'C:\\Users\\demo\\.cache\\ucode\\skills\\ucode-docs\\SKILL.md',
    origin: 'bundled',
    hidden: false
  }])
  assert.equal(JSON.stringify(result).includes('large private'), false)
})

test('U-Code discovery falls back quietly when the CLI is unavailable', () => {
  assert.deepEqual(listUCodeSkills({ run() { throw new Error('not found') } }), [])
})
