import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'parse5'

import { SUMMARY_THEME_IDS, getSummaryTheme } from '../electron/summaries/summaryThemeCatalog.js'
import { renderSummaryTheme } from '../electron/summaries/summaryThemeRenderer.js'
import { SUMMARY_THEMES } from '../src/summaryThemes.js'

const markdown = `# 周报 <script>alert(1)</script>

## 摘要

完成 **缓存** 优化。[危险](javascript:alert(2)) ![远程图](https://example.com/a.png)

## 项目进展

### UCLI

- 完成主题渲染

## 下一步

继续验证。<img src="https://example.com/x.png" onerror="alert(3)">`

const report = {
  id: 'report-secret', periodType: 'week', version: 3,
  periodStart: 10, periodEndExclusive: 20, timezone: 'Asia/Shanghai',
  executorId: 'claude', profileId: 'profile-secret', model: 'sonnet',
  customCss: 'body{display:none}', onclick: 'alert(4)'
}

const usageSnapshot = {
  totals: { inputTokens: 1200, outputTokens: 345, turns: 8, costUsd: 1.25 },
  rawHtml: '<script>alert(5)</script>', path: 'C:\\secret'
}

function walk(node, visit) {
  visit(node)
  for (const child of node.childNodes || []) walk(child, visit)
}

function elements(document, name = null) {
  const found = []
  walk(document, node => {
    if (node.tagName && (!name || node.tagName === name)) found.push(node)
  })
  return found
}

function attribute(node, name) {
  return node.attrs?.find(item => item.name === name)?.value ?? null
}

function text(node) {
  let result = node.nodeName === '#text' ? node.value : ''
  for (const child of node.childNodes || []) result += text(child)
  return result
}

test('catalog exposes exactly five fixed themes to main and renderer', () => {
  assert.deepEqual(SUMMARY_THEME_IDS, [
    'executive', 'engineering', 'timeline', 'dashboard', 'print'
  ])
  assert.deepEqual(SUMMARY_THEMES.map(theme => theme.id), SUMMARY_THEME_IDS)
  assert.equal(new Set(SUMMARY_THEMES.map(theme => theme.label)).size, 5)
  assert.throws(() => getSummaryTheme('custom'), error => error?.code === 'SUMMARY_THEME_INVALID')
})

test('all themes render deterministic complete safe documents with heading navigation', () => {
  const markers = new Set()
  for (const themeId of SUMMARY_THEME_IDS) {
    const input = { themeId, markdown, report, usageSnapshot }
    const html = renderSummaryTheme(input)
    assert.equal(renderSummaryTheme(input), html)
    assert.match(html, /^<!doctype html>/i)
    const document = parse(html)
    const all = elements(document)
    assert.equal(elements(document, 'main').length, 1)
    assert.equal(elements(document, 'nav').length, 1)
    assert.equal(elements(document, 'style').length, 1)
    const body = elements(document, 'body')[0]
    const marker = attribute(body, 'data-summary-theme')
    assert.equal(marker, themeId)
    markers.add(marker)

    const headings = elements(document, 'main')[0].childNodes
      ? elements(elements(document, 'main')[0]).filter(node => /^h[1-6]$/.test(node.tagName))
      : []
    assert.deepEqual(headings.map(node => text(node).trim()), [
      '周报 <script>alert(1)</script>', '摘要', '项目进展', 'UCLI', '下一步'
    ])
    const ids = headings.map(node => attribute(node, 'id'))
    assert.equal(new Set(ids).size, ids.length)
    const links = elements(document, 'nav').flatMap(node => elements(node, 'a'))
    assert.deepEqual(links.map(node => attribute(node, 'href')), ids.map(id => `#${id}`))

    for (const node of all) {
      assert.equal(['script', 'img', 'iframe', 'object', 'embed', 'link'].includes(node.tagName), false)
      for (const attr of node.attrs || []) {
        assert.equal(/^on/i.test(attr.name), false)
        if (['href', 'src', 'action'].includes(attr.name)) assert.match(attr.value, /^#/)
      }
    }
    assert.doesNotMatch(html, /(?:href|src)="(?:https?:|javascript:)|@import|url\s*\(|body\{display:none\}|profile-secret|C:\\secret/i)
  }
  assert.equal(markers.size, 5)
})

test('theme structures differ and dashboard KPIs use only trusted numeric usage', () => {
  for (const themeId of SUMMARY_THEME_IDS) {
    const html = renderSummaryTheme({ themeId, markdown, report, usageSnapshot })
    const document = parse(html)
    const timeline = elements(document).filter(node => attribute(node, 'data-timeline') !== null)
    const kpis = elements(document).filter(node => attribute(node, 'data-kpi') !== null)
    const engineering = elements(document).filter(node => attribute(node, 'data-engineering-grid') !== null)
    const executive = elements(document).filter(node => attribute(node, 'data-executive-brief') !== null)
    const print = elements(document).filter(node => attribute(node, 'data-print-layout') !== null)
    assert.equal(timeline.length, themeId === 'timeline' ? 1 : 0)
    assert.equal(kpis.length >= 3, themeId === 'dashboard')
    assert.equal(engineering.length, themeId === 'engineering' ? 1 : 0)
    assert.equal(executive.length, themeId === 'executive' ? 1 : 0)
    assert.equal(print.length, themeId === 'print' ? 1 : 0)
    if (themeId === 'dashboard') {
      assert.match(text(document), /1,200/)
      assert.match(text(document), /345/)
      assert.match(text(document), /8/)
      assert.doesNotMatch(html, /rawHtml|alert\(5\)|path/)
    }
  }
})

test('invalid renderer inputs fail typed before producing markup', () => {
  for (const input of [
    { themeId: 'custom', markdown: '# x' },
    { themeId: 'print', markdown: null },
    { themeId: 'print', markdown: '# x', usageSnapshot: [] }
  ]) {
    assert.throws(
      () => renderSummaryTheme(input),
      error => /^SUMMARY_THEME_(?:INVALID|INPUT_INVALID)$/.test(error?.code || '')
    )
  }
})
