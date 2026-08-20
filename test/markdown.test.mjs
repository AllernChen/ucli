import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { openSafeLink } from '../src/artifactLinks.js'

test('renderMarkdown wires markdown-it with html disabled and DOMPurify sanitize', () => {
  const source = readFileSync(new URL('../src/markdown.js', import.meta.url), 'utf8')
  assert.match(source, /new MarkdownIt\(\{\s*html:\s*false/)
  assert.match(source, /linkify:\s*true/)
  assert.match(source, /breaks:\s*true/)
  assert.match(source, /DOMPurify\.sanitize/)
})

test('ArtifactPreview sanitizes html and image src uses data: URL', () => {
  const source = readFileSync(new URL('../src/components/ArtifactPreview.vue', import.meta.url), 'utf8')
  assert.match(source, /DOMPurify\.sanitize/)
  assert.match(source, /USE_PROFILES:\s*\{\s*html:\s*true\s*\}/)
  assert.match(source, /data:\$\{.*mimeType.*\};base64/)
  assert.match(source, /openSafeLink/)
})

test('openSafeLink opens only http(s) links and prevents default', () => {
  const opened = []
  let prevented = 0
  const anchor = { getAttribute: () => 'https://example.com/a.md' }
  const handled = openSafeLink({
    target: { closest: (selector) => selector === 'a[href]' ? anchor : null },
    preventDefault() { prevented += 1 }
  }, (url) => { opened.push(url) })

  assert.equal(handled, true)
  assert.equal(prevented, 1)
  assert.deepEqual(opened, ['https://example.com/a.md'])
})

test('openSafeLink ignores non-http(s) hrefs', () => {
  const opened = []
  let prevented = 0
  const anchor = { getAttribute: () => 'file:///etc/passwd' }
  const handled = openSafeLink({
    target: { closest: (selector) => selector === 'a[href]' ? anchor : null },
    preventDefault() { prevented += 1 }
  }, (url) => { opened.push(url) })

  assert.equal(handled, false)
  assert.equal(prevented, 1)
  assert.deepEqual(opened, [])
})

test('openSafeLink returns false without an anchor', () => {
  assert.equal(openSafeLink({ target: { closest: () => null } }, () => {}), false)
})
