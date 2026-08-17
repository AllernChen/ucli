import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'

import {
  SETTINGS_SECTIONS,
  normalizeSettingsSection
} from '../src/settingsSections.js'

const sectionIds = [
  'general', 'gateway', 'cli', 'summaries', 'storage',
  'shortcuts', 'updates', 'support', 'about'
]

test('settings sections expose the fixed navigation contract and reject invalid query values', () => {
  assert.deepEqual(SETTINGS_SECTIONS.map(item => item.id), sectionIds)
  assert.equal(normalizeSettingsSection('storage'), 'storage')
  assert.equal(normalizeSettingsSection('../storage'), 'general')
  assert.equal(normalizeSettingsSection(['storage']), 'general')
  assert.equal(normalizeSettingsSection(undefined), 'general')
})

test('settings navigation compiles and drives desktop and mobile controls from one catalog', () => {
  const source = readFileSync(
    new URL('../src/components/settings/SettingsSectionNav.vue', import.meta.url),
    'utf8'
  )
  assert.deepEqual(parseSfc(source, { filename: 'SettingsSectionNav.vue' }).errors, [])
  assert.match(source, /class="settings-section-nav__desktop"[\s\S]*v-for="section in SETTINGS_SECTIONS"/)
  assert.match(source, /class="settings-section-nav__mobile"[\s\S]*v-for="section in SETTINGS_SECTIONS"/)
  assert.match(source, /defineModel\(/)
  assert.match(source, /position:\s*sticky/)
  assert.match(source, /@media\s*\(max-width:\s*899px\)/)
})

test('settings keeps one mounted form tree while wrapping every card in its deep-link section', () => {
  const source = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  assert.deepEqual(parseSfc(source, { filename: 'Settings.vue' }).errors, [])

  for (const id of sectionIds) {
    assert.match(source, new RegExp(`id="settings-section-${id}"`))
  }
  assert.equal((source.match(/id="settings-section-[a-z]+"/g) || []).length, sectionIds.length)
  assert.equal((source.match(/<SummaryCacheSettings\b/g) || []).length, 1)
  assert.doesNotMatch(source, /<component\s+:is=/)
})

test('section deep links preserve unrelated queries and scrolling replaces history', () => {
  const source = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')

  assert.match(source, /normalizeSettingsSection\(route\.query\.section\)/)
  assert.match(source, /router\.replace\(\{[\s\S]*query:\s*\{\s*\.\.\.route\.query,\s*section[\s\S]*\}\)/)
  assert.match(source, /query:\s*\{\s*\.\.\.route\.query,\s*panel:\s*'gateway'\s*\}/)
  assert.match(source, /scrollIntoView\(\{\s*block:\s*'start'\s*\}\)/)
  assert.match(source, /new IntersectionObserver/)
  assert.doesNotMatch(source, /router\.push\(\{[\s\S]{0,180}query:\s*\{[\s\S]{0,80}section/)
})
