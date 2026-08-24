import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
for (const name of ['Element', 'HTMLElement', 'Node', 'SVGElement']) globalThis[name] = dom.window[name]
dom.window.HTMLCanvasElement.prototype.getContext = () => ({})

let Vue
let createServer
let vuePlugin
let createPinia
let setActivePinia
let defineComponent
let flushPromises
let shallowMount
let mount
let compileScript
let compileTemplate
let parseSfc

const request = {
  periodType: 'week', start: 1, endExclusive: 2, timezone: 'Asia/Shanghai',
  partial: false, executorId: 'claude', profileId: 'p1', model: 'sonnet'
}

function createStubs() {
  return {
    GenerateDialogStub: defineComponent({
      name: 'SummaryGenerateDialog', emits: ['submit'], setup: () => ({ request }),
      template: '<button data-testid="summary-generate" @click="$emit(\'submit\', request)">生成</button>'
    }),
    ReportViewStub: defineComponent({
      name: 'SummaryReportView', props: { report: Object, progress: Object }, emits: ['cancel', 'open-conversation'],
      template: `<section><p data-testid="report-markdown">{{ report?.markdown }}</p><p data-testid="report-progress">{{ progress?.text }}</p><button data-testid="summary-cancel" @click="$emit('cancel', report.id)">取消</button><button data-testid="summary-conversation" @click="$emit('open-conversation', report)">对话</button></section>`
    }),
    HistoryStub: defineComponent({
      name: 'SummaryHistory', props: { versions: Array }, emits: ['select', 'retry'],
      template: `<section><button data-testid="summary-select-v1" @click="$emit('select', 'r1')">v1</button><button data-testid="summary-select-v2" @click="$emit('select', 'r2')">v2</button><button data-testid="summary-retry" @click="$emit('retry', versions.find(item => item.id === 'r2'))">重试</button></section>`
    }),
    ConversationStub: defineComponent({
      name: 'SummaryConversationDrawer', props: { open: Boolean, reportId: String, sessionId: String },
      template: '<p data-testid="conversation">{{ open ? `${reportId}:${sessionId || "此报告没有关联的交互会话"}` : "" }}</p>'
    })
  }
}

function attachClientRender(component, fileName, bindingMetadata = {}) {
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: fileName,
    id: 'summary-mounted',
    compilerOptions: { mode: 'function', runtimeGlobalName: 'Vue', bindingMetadata }
  })
  assert.deepEqual(compiled.errors, [])
  component.render = new Function('Vue', compiled.code)(Vue)
  return component
}

async function loadMountedPanel(vite, stubs) {
  await vite.transformRequest('/src/components/summaries/WorkSummaryPanel.vue')
  const fileName = '../src/components/summaries/WorkSummaryPanel.vue'
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiledScript = compileScript(descriptor, { id: 'summary-mounted' })
  let code = compiledScript.content
  code = code.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  code = `const { computed, onBeforeUnmount, onMounted, ref } = Vue\n${code}`
  const { useSummariesStore } = await import('../src/stores/summaries.js')
  const panel = new Function(
    'Vue', 'useSummariesStore', 'SummaryGenerateDialog', 'SummaryConversationDrawer', 'SummaryHistory', 'SummaryReportView', code
  )(Vue, useSummariesStore, stubs.GenerateDialogStub, stubs.ConversationStub, stubs.HistoryStub, stubs.ReportViewStub)
  return attachClientRender(panel, fileName, compiledScript.bindings)
}

async function loadMountedDrawer(vite) {
  await vite.transformRequest('/src/components/summaries/SummaryConversationDrawer.vue')
  const fileName = '../src/components/summaries/SummaryConversationDrawer.vue'
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiledScript = compileScript(descriptor, { id: 'summary-drawer-mounted' })
  let code = compiledScript.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  code = `const { nextTick, ref, watch } = Vue\n${code}`
  const pane = defineComponent({ template: '<div>history</div>' })
  const terminal = defineComponent({ template: '<div>terminal</div>' })
  const drawer = new Function('Vue', 'ipc', 'PaneHistory', 'SessionTerminal', code)(Vue, { attachTerminal: async () => {} }, pane, terminal)
  return attachClientRender(drawer, fileName, compiledScript.bindings)
}

async function loadMountedReport(vite) {
  await vite.transformRequest('/src/components/summaries/SummaryReportView.vue')
  const fileName = '../src/components/summaries/SummaryReportView.vue'
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiledScript = compileScript(descriptor, { id: 'summary-report-mounted' })
  let code = compiledScript.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  code = `const { computed } = Vue\n${code}`
  const report = new Function('Vue', 'DOMPurify', 'MarkdownIt', 'ipc', 'openSummaryReportLink', code)(
    Vue,
    { sanitize: value => value },
    class { render(value) { return value } },
    { openExternal: () => {} },
    () => {}
  )
  return attachClientRender(report, fileName, compiledScript.bindings)
}

test('mounted work summary panel uses canonical reports for generation, progress, versions, retry, cancel, and conversations', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ setActivePinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, mount, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const { GenerateDialogStub, ReportViewStub, HistoryStub, ConversationStub } = createStubs()
  const startCalls = []
  const cancelCalls = []
  let progressListener = () => {}
  let unsubscribeCalls = 0
  const progressListeners = new Set()
  const reports = {
    r1: {
      id: 'r1', version: 1, status: 'completed', runPhase: 'completed', executionMode: 'interactive-cli',
      markdown: '# 摘要\n\nversion one marker', sessionId: 'session-1', periodType: 'week', periodStart: 1,
      periodEndExclusive: 2, timezone: 'Asia/Shanghai', executorId: 'claude', profileId: 'p1', model: 'sonnet'
    },
    r2: {
      id: 'r2', version: 2, status: 'failed', runPhase: 'failed', executionMode: 'interactive-cli',
      markdown: null, sessionId: 'session-2', periodType: 'week', periodStart: 1,
      periodEndExclusive: 2, timezone: 'Asia/Shanghai', executorId: 'claude', profileId: 'p1', model: 'sonnet'
    },
    imported: {
      id: 'imported', version: 1, status: 'completed', runPhase: 'completed', executionMode: 'imported',
      markdown: '# 导入报告', sessionId: null, periodType: 'month', periodStart: 3,
      periodEndExclusive: 4, timezone: 'Asia/Shanghai', executorId: null, profileId: null, model: null
    }
  }
  window.ucli = {
    listSummaryReports: async filters => {
      if (filters?.periodType === 'week') return [reports.r2, reports.r1]
      return [reports.r2, reports.r1, reports.imported]
    },
    getSummaryReport: async id => reports[id],
    startInteractiveSummary: async value => {
      startCalls.push(value)
      reports.r3 = {
          id: 'r3', version: 3, status: 'queued', runPhase: 'preparing', executionMode: 'interactive-cli',
          markdown: null, sessionId: 'session-3', periodType: value.periodType, periodStart: value.start,
          periodEndExclusive: value.endExclusive, timezone: value.timezone, executorId: value.executorId,
          profileId: value.profileId, model: value.model
      }
      return { report: reports.r3, sessionId: 'session-3' }
    },
    cancelSummary: async id => { cancelCalls.push(id); return { reportId: id } },
    setCurrentSummary: async id => reports[id],
    deleteSummaryReport: async () => ({ currentReportId: null }),
    exportSummaryMarkdown: async () => ({ canceled: false }),
    exportSummaryHtml: async () => ({ canceled: false }),
    onSummaryProgress: listener => {
      progressListener = listener
      progressListeners.add(listener)
      return () => { unsubscribeCalls += 1; progressListeners.delete(listener); if (progressListener === listener) progressListener = () => {} }
    }
  }

  const vite = await createServer({
    plugins: [vuePlugin()],
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-fit'] },
    server: { middlewareMode: true },
    appType: 'custom'
  })
  let wrapper
  try {
    wrapper = shallowMount(await loadMountedPanel(vite, { GenerateDialogStub, ReportViewStub, HistoryStub, ConversationStub }), {
      global: {
        plugins: [createPinia()],
        stubs: {
          SummaryGenerateDialog: GenerateDialogStub,
          SummaryReportView: ReportViewStub,
          SummaryHistory: HistoryStub,
          SummaryConversationDrawer: ConversationStub,
          'a-button': { template: '<button><slot /></button>' },
          'a-alert': { template: '<div><slot /></div>' },
          'a-list': { template: '<div><slot /></div>' },
          'a-list-item': { template: '<div><slot /></div>' },
          'a-list-item-meta': { template: '<div><slot /></div>' },
          'a-row': { template: '<div><slot /></div>' },
          'a-col': { template: '<div><slot /></div>' },
          'a-spin': { template: '<div><slot /></div>' }
        }
      }
    })
    await flushPromises()

    await wrapper.get('[data-testid="summary-generate"]').trigger('click')
    assert.deepEqual(startCalls, [request])
    assert.ok(wrapper.vm.summaries.versions.some(report => report.id === 'r3'))

    progressListener({ reportId: 'r3', phase: 'running', status: 'running', completed: 0, total: 1, text: '正在生成总结' })
    reports.r3 = { ...reports.r3, status: 'completed', runPhase: 'completed', markdown: '# 摘要\n\n新版本' }
    progressListener({ reportId: 'r3', phase: 'completed', status: 'completed', completed: 1, total: 1, text: '总结已生成' })
    await flushPromises()
    assert.match(wrapper.text(), /总结已生成/)
    assert.match(wrapper.text(), /# 摘要/)

    await wrapper.get('[data-testid="summary-select-v2"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="summary-retry"]').trigger('click')
    assert.deepEqual(startCalls.at(-1), {
      periodType: 'week', start: 1, endExclusive: 2, timezone: 'Asia/Shanghai',
      partial: false, executorId: 'claude', profileId: 'p1', model: 'sonnet'
    })

    await wrapper.get('[data-testid="summary-cancel"]').trigger('click')
    assert.deepEqual(cancelCalls, ['r3'])

    await wrapper.get('[data-testid="summary-select-v1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="summary-conversation"]').trigger('click')
    assert.match(wrapper.get('[data-testid="conversation"]').text(), /r1:session-1/)

    await wrapper.vm.summaries.selectReport('imported')
    await flushPromises()
    await wrapper.get('[data-testid="summary-conversation"]').trigger('click')
    assert.match(wrapper.get('[data-testid="conversation"]').text(), /此报告没有关联的交互会话/)

    const { useSummariesStore } = await import('../src/stores/summaries.js')
    const panelStore = wrapper.vm.summaries
    setActivePinia(createPinia())
    const otherStore = useSummariesStore()
    await otherStore.init()
    wrapper.unmount()
    wrapper = null
    await flushPromises()
    for (const listener of progressListeners) listener({ reportId: 'other-store', status: 'running', phase: 'running', completed: 0, total: 1, text: '另一页仍在生成' })
    assert.equal(panelStore.progress['other-store'], undefined)
    assert.equal(otherStore.progress['other-store'].text, '另一页仍在生成')
    otherStore.dispose()
  } finally {
    wrapper?.unmount()
    await flushPromises()
    await vite.close()
  }
  assert.deepEqual(cancelCalls, ['r3'])
})

test('mounted persisted awaiting-confirmation report keeps cancellation available without a progress event', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = mount(await loadMountedReport(vite), {
      props: {
        report: { id: 'legacy', version: 1, status: 'awaiting_confirmation', periodStart: 1, periodEndExclusive: 2, markdown: null },
        progress: null
      },
      global: { stubs: {
        'a-card': { template: '<section><slot /><slot name="extra" /></section>' }, 'a-tag': true, 'a-descriptions': { template: '<div><slot /></div>' }, 'a-descriptions-item': { template: '<div><slot /></div>' },
        'a-alert': { props: ['message', 'description'], template: '<div>{{ message }} {{ description }}</div>' }, 'a-progress': true, 'a-button': { template: '<button><slot /></button>' }, 'a-popconfirm': { template: '<div><slot /></div>' }, 'a-empty': true
      } }
    })
    assert.match(wrapper.text(), /此报告无法在此继续。请取消后重试/)
    assert.match(wrapper.text(), /取消生成/)
    assert.doesNotMatch(wrapper.text(), /确认继续/)
    await wrapper.get('button').trigger('click')
    assert.deepEqual(wrapper.emitted('cancel'), [['legacy']])
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('mounted panel unmount preserves a pending initialization for the next mount without obsolete selection', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const stubs = createStubs()
  const listeners = new Set()
  let resolveReports
  let listCalls = 0
  const selected = []
  const report = {
    id: 'pending', version: 1, status: 'completed', runPhase: 'completed', markdown: '# 已完成',
    sessionId: 'session-pending', periodType: 'week', periodStart: 1, periodEndExclusive: 2,
    timezone: 'Asia/Shanghai', executorId: 'claude', profileId: null, model: null, isCurrent: true
  }
  const pendingList = new Promise(resolve => { resolveReports = resolve })
  const api = window.ucli
  const originalApi = { ...api }
  Object.assign(api, {
    listSummaryReports: () => { listCalls += 1; return pendingList },
    getSummaryReport: async id => { selected.push(id); return report },
    startInteractiveSummary: async () => ({ report, sessionId: report.sessionId }),
    cancelSummary: async () => ({ reportId: report.id }), setCurrentSummary: async () => report,
    deleteSummaryReport: async () => ({ currentReportId: null }), exportSummaryMarkdown: async () => ({ canceled: false }),
    exportSummaryHtml: async () => ({ canceled: false }),
    onSummaryProgress: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  })
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let first
  let second
  try {
    const panel = await loadMountedPanel(vite, stubs)
    const pinia = createPinia()
    const options = {
      global: {
        plugins: [pinia],
        stubs: {
          SummaryGenerateDialog: stubs.GenerateDialogStub, SummaryReportView: stubs.ReportViewStub,
          SummaryHistory: stubs.HistoryStub, SummaryConversationDrawer: stubs.ConversationStub,
          'a-button': { template: '<button><slot /></button>' }, 'a-alert': { template: '<div><slot /></div>' },
          'a-list': { template: '<div><slot /></div>' }, 'a-list-item': { template: '<div><slot /></div>' },
          'a-list-item-meta': { template: '<div><slot /></div>' }, 'a-row': { template: '<div><slot /></div>' },
          'a-col': { template: '<div><slot /></div>' }, 'a-spin': { template: '<div><slot /></div>' }
        }
      }
    }
    first = shallowMount(panel, options)
    await flushPromises()
    assert.equal(listCalls, 1)
    assert.equal(listeners.size, 1)
    first.unmount()
    first = null
    await flushPromises()
    assert.equal(listeners.size, 0)

    second = shallowMount(panel, options)
    await flushPromises()
    assert.equal(listCalls, 1)
    assert.equal(listeners.size, 1)

    resolveReports([report])
    await flushPromises()
    assert.deepEqual(second.vm.summaries.reports.map(item => item.id), ['pending'])
    assert.deepEqual(selected, ['pending'])
  } finally {
    first?.unmount()
    second?.unmount()
    await flushPromises()
    await vite.close()
    Object.assign(api, originalApi)
  }
  assert.equal(listeners.size, 0)
})

test('mounted panels sharing a store retain progress ownership until the final panel unmounts', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const stubs = createStubs()
  const listeners = new Set()
  let cancellations = 0
  const report = {
    id: 'shared', version: 1, status: 'running', runPhase: 'running', markdown: null,
    sessionId: 'session-shared', periodType: 'week', periodStart: 1, periodEndExclusive: 2,
    timezone: 'Asia/Shanghai', executorId: 'claude', profileId: null, model: null, isCurrent: true
  }
  const api = window.ucli
  const originalApi = { ...api }
  Object.assign(api, {
    listSummaryReports: async () => [report], getSummaryReport: async () => report,
    startInteractiveSummary: async () => ({ report, sessionId: report.sessionId }),
    cancelSummary: async () => { cancellations += 1 }, setCurrentSummary: async () => report,
    deleteSummaryReport: async () => ({ currentReportId: null }), exportSummaryMarkdown: async () => ({ canceled: false }),
    exportSummaryHtml: async () => ({ canceled: false }),
    onSummaryProgress: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  })
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let first
  let second
  try {
    const panel = await loadMountedPanel(vite, stubs)
    const options = {
      global: {
        plugins: [createPinia()],
        stubs: {
          SummaryGenerateDialog: stubs.GenerateDialogStub, SummaryReportView: stubs.ReportViewStub,
          SummaryHistory: stubs.HistoryStub, SummaryConversationDrawer: stubs.ConversationStub,
          'a-button': { template: '<button><slot /></button>' }, 'a-alert': { template: '<div><slot /></div>' },
          'a-list': { template: '<div><slot /></div>' }, 'a-list-item': { template: '<div><slot /></div>' },
          'a-list-item-meta': { template: '<div><slot /></div>' }, 'a-row': { template: '<div><slot /></div>' },
          'a-col': { template: '<div><slot /></div>' }, 'a-spin': { template: '<div><slot /></div>' }
        }
      }
    }
    first = shallowMount(panel, options)
    second = shallowMount(panel, options)
    await flushPromises()
    assert.equal(listeners.size, 1)

    first.unmount()
    first = null
    assert.equal(listeners.size, 1)
    for (const listener of listeners) listener({ reportId: 'shared', status: 'running', phase: 'running', completed: 1, total: 2, text: '第二个面板仍在接收进度' })
    await flushPromises()
    assert.match(second.get('[data-testid="report-progress"]').text(), /第二个面板仍在接收进度/)
    assert.equal(cancellations, 0)

    second.unmount()
    second = null
    assert.equal(listeners.size, 0)
  } finally {
    first?.unmount()
    second?.unmount()
    await flushPromises()
    await vite.close()
    Object.assign(api, originalApi)
  }
})

test('mounted conversation drawer never falls back when an imported report has no session', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ defineComponent } = Vue)
  ;({ mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = mount(await loadMountedDrawer(vite), {
      props: { open: true, reportId: 'imported', sessionId: null },
      global: { stubs: { 'a-drawer': { template: '<section><slot /></section>' }, 'a-tabs': true, 'a-tab-pane': true } }
    })
    assert.match(wrapper.text(), /此报告没有关联的交互会话/)
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})
