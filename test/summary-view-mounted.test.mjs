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
    }),
    HtmlStyleDialogStub: defineComponent({
      name: 'SummaryHtmlStyleDialog', props: { open: Boolean }, emits: ['update:open', 'submit'],
      template: '<button v-if="open" data-testid="summary-export-print" @click="$emit(\'submit\', { mode: \'theme\', themeId: \'print\' })">导出打印版</button>'
    }),
    ReportListItemStub: defineComponent({
      name: 'SummaryReportListItem', props: { report: Object, progress: Object }, emits: ['select', 'edit', 'delete-report', 'retry', 'open-conversation'],
      template: '<button @click="$emit(\'select\', report.id)">{{ progress?.text || report?.title }}</button>'
    }),
    TaskEditDialogStub: defineComponent({
      name: 'SummaryTaskEditDialog', props: { open: Boolean, report: Object }, emits: ['update:open', 'submit'],
      template: '<div />'
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
  const fallback = defineComponent({ template: '<div />' })
  const panel = new Function(
    'Vue', 'useSummariesStore', 'SummaryGenerateDialog', 'SummaryConversationDrawer', 'SummaryHistory', 'SummaryReportView', 'SummaryHtmlStyleDialog', 'SummaryReportListItem', 'SummaryTaskEditDialog', code
  )(Vue, useSummariesStore, stubs.GenerateDialogStub, stubs.ConversationStub, stubs.HistoryStub, stubs.ReportViewStub, stubs.HtmlStyleDialogStub, stubs.ReportListItemStub || fallback, stubs.TaskEditDialogStub || fallback)
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
  code = code.replace(/\bsummaryTaskStatusMeta\b/g, 'statusMeta').replace(/\bsummaryTaskErrorMeta\b/g, 'errorMeta')
  const { summaryTaskStatusMeta, summaryTaskErrorMeta } = await import('../shared/summaryTaskContracts.js')
  const report = new Function('Vue', 'DOMPurify', 'MarkdownIt', 'ipc', 'openSummaryReportLink', 'statusMeta', 'errorMeta', code)(
    Vue,
    { sanitize: value => value },
    class { render(value) { return value } },
    { openExternal: () => {} },
    () => {},
    summaryTaskStatusMeta,
    summaryTaskErrorMeta
  )
  return attachClientRender(report, fileName, compiledScript.bindings)
}

async function loadMountedListItem(vite) {
  await vite.transformRequest('/src/components/summaries/SummaryReportListItem.vue')
  const fileName = '../src/components/summaries/SummaryReportListItem.vue'
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiledScript = compileScript(descriptor, { id: 'summary-list-item-mounted' })
  let code = compiledScript.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  code = `const { computed, ref } = Vue\n${code}`
  code = code.replace(/\bsummaryTaskStatusMeta\b/g, 'statusMeta').replace(/\bsummaryTaskErrorMeta\b/g, 'errorMeta')
  const { summaryTaskStatusMeta, summaryTaskErrorMeta } = await import('../shared/summaryTaskContracts.js')
  const item = new Function('Vue', 'statusMeta', 'errorMeta', code)(Vue, summaryTaskStatusMeta, summaryTaskErrorMeta)
  return attachClientRender(item, fileName, compiledScript.bindings)
}

async function loadMountedTaskEditDialog(vite) {
  await vite.transformRequest('/src/components/summaries/SummaryTaskEditDialog.vue')
  const fileName = '../src/components/summaries/SummaryTaskEditDialog.vue'
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiledScript = compileScript(descriptor, { id: 'summary-task-edit-mounted' })
  let code = compiledScript.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  code = `const { reactive, watch } = Vue\n${code}`
  const dialog = new Function('Vue', code)(Vue)
  return attachClientRender(dialog, fileName, compiledScript.bindings)
}

async function loadMountedHistory(vite) {
  await vite.transformRequest('/src/components/summaries/SummaryHistory.vue')
  const fileName = '../src/components/summaries/SummaryHistory.vue'
  const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: fileName })
  assert.deepEqual(errors, [])
  const compiledScript = compileScript(descriptor, { id: 'summary-history-mounted' })
  let code = compiledScript.content.replace(/^import[^\n]*\n/gm, '').replace('export default', 'return')
  const { summaryTaskStatusMeta } = await import('../shared/summaryTaskContracts.js')
  const history = new Function('summaryTaskStatusMeta', code)(summaryTaskStatusMeta)
  return attachClientRender(history, fileName, compiledScript.bindings)
}

test('summary task card keeps secondary actions behind the compact menu and preserves their payloads', async () => {
  Vue = await import('vue')
  ;({ defineComponent } = Vue)
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ flushPromises, mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    const report = {
      id: 'failed-report', title: '需要截断的工作总结标题', taskNote: '需要截断的任务备注',
      version: 3, status: 'failed', errorText: 'SUMMARY_ARTIFACT_INVALID', markdown: null,
      createdAt: Date.UTC(2026, 7, 25, 9, 50),
      periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai'
    }
    const MenuStub = defineComponent({ name: 'TaskCardMenuStub', emits: ['click'], template: '<div><slot /></div>' })
    wrapper = mount(await loadMountedListItem(vite), {
      props: { report, progress: null, selected: false },
      global: { stubs: {
        'a-list-item': { template: '<section><slot /></section>' },
        'a-tag': { template: '<span><slot /></span>' },
        'a-button': { template: '<button v-bind="$attrs"><slot /></button>' },
        'a-dropdown': defineComponent({
          setup: () => ({ open: Vue.ref(false) }),
          template: '<div @click.capture="open = true"><slot /><div v-if="open"><slot name="overlay" /></div></div>'
        }),
        'a-menu': MenuStub,
        'a-menu-item': { template: '<button><slot /></button>' },
        'a-menu-divider': { template: '<hr />' },
        'a-modal': { props: ['open', 'title'], emits: ['ok', 'cancel'], template: '<section v-if="open" data-testid="delete-confirm"><p>{{ title }}</p><button @click="$emit(\'ok\')">确认删除</button></section>' }
      } }
    })
    assert.match(wrapper.get('.summary-task-card__title').text(), /需要截断的工作总结标题/)
    assert.match(wrapper.get('.summary-task-card__note').text(), /需要截断的任务备注/)
    assert.match(wrapper.text(), /生成失败/)
    assert.match(wrapper.text(), /v3/)
    assert.match(wrapper.get('.summary-task-card__meta').text(), /2026/)
    assert.equal(wrapper.get('.summary-task-card').attributes('aria-current'), undefined)
    assert.equal(wrapper.get('.summary-task-card').attributes('role'), undefined)
    assert.equal(wrapper.get('.summary-task-card').attributes('aria-selected'), undefined)
    assert.match(wrapper.get('.summary-task-card__failure-action').text(), /请检查生成内容后重试/)
    assert.equal(wrapper.findComponent(MenuStub).exists(), false)

    await wrapper.get('.summary-task-card').trigger('click')
    assert.deepEqual(wrapper.emitted('select'), [['failed-report']])
    await wrapper.get('[aria-label="重试生成总结"]').trigger('keydown', { key: 'Enter' })
    assert.equal(wrapper.emitted('select').length, 1)
    await wrapper.get('[aria-label="重试生成总结"]').trigger('click')
    assert.deepEqual(wrapper.emitted('retry'), [[report]])
    await wrapper.get('[aria-label="更多操作"]').trigger('keydown', { key: 'Enter' })
    assert.equal(wrapper.emitted('select').length, 1)
    await wrapper.get('[aria-label="更多操作"]').trigger('click')
    assert.equal(wrapper.emitted('select').length, 1)
    assert.equal(wrapper.findComponent(MenuStub).exists(), true)

    await wrapper.findComponent(MenuStub).vm.$emit('click', { key: 'edit' })
    assert.deepEqual(wrapper.emitted('edit'), [[report]])
    await wrapper.findComponent(MenuStub).vm.$emit('click', { key: 'conversation' })
    assert.deepEqual(wrapper.emitted('open-conversation'), [[report]])
    await wrapper.findComponent(MenuStub).vm.$emit('click', { key: 'delete' })
    await flushPromises()
    assert.match(wrapper.get('[data-testid="delete-confirm"]').text(), /删除这个总结任务？/)
    await wrapper.get('[data-testid="delete-confirm"] button').trigger('click')
    await flushPromises()
    assert.deepEqual(wrapper.emitted('delete-report'), [['failed-report']])
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), false)

    await wrapper.setProps({
      report: { ...report, status: 'running', runPhase: 'starting' },
      progress: { reportId: report.id, status: 'running', phase: 'starting', completed: 0, total: 1, text: '正在启动 AI CLI' },
      selected: true
    })
    assert.equal(wrapper.get('.summary-task-card').attributes('aria-current'), 'true')
    assert.match(wrapper.get('.summary-task-card__detail').text(), /正在启动 AI CLI/)
    await wrapper.get('.summary-task-card').trigger('keydown', { key: ' ' })
    assert.deepEqual(wrapper.emitted('select'), [['failed-report'], ['failed-report']])
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('summary task card keeps deletion confirmation open while deletion is pending or fails', async () => {
  Vue = await import('vue')
  ;({ defineComponent } = Vue)
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ flushPromises, mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    const report = { id: 'deleting-report', title: '删除任务', taskNote: '', version: 1, status: 'completed', createdAt: Date.UTC(2026, 7, 25), periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai' }
    let rejectDelete
    let deleteAttempt = 0
    const deleteCalls = []
    const MenuStub = defineComponent({ name: 'PendingDeleteMenuStub', emits: ['click'], template: '<div><slot /></div>' })
    const ModalStub = defineComponent({
      name: 'PendingDeleteModalStub',
      props: ['open', 'confirmLoading', 'maskClosable', 'keyboard', 'closable', 'cancelButtonProps'],
      emits: ['ok', 'cancel'],
      template: '<section v-if="open" data-testid="delete-confirm"><button @click="$emit(\'ok\')">确认删除</button></section>'
    })
    wrapper = mount(await loadMountedListItem(vite), {
      props: { report, progress: null, selected: false, deleteReport: reportId => {
        deleteCalls.push(reportId)
        deleteAttempt += 1
        if (deleteAttempt === 2) return false
        if (deleteAttempt === 3) return undefined
        return new Promise((resolve, reject) => { rejectDelete = reject })
      } },
      global: { stubs: {
        'a-list-item': { template: '<section><slot /></section>' }, 'a-tag': { template: '<span><slot /></span>' },
        'a-button': { template: '<button v-bind="$attrs"><slot /></button>' },
        'a-dropdown': defineComponent({ setup: () => ({ open: Vue.ref(false) }), template: '<div @click.capture="open = true"><slot /><div v-if="open"><slot name="overlay" /></div></div>' }),
        'a-menu': MenuStub, 'a-menu-item': { template: '<button><slot /></button>' }, 'a-menu-divider': { template: '<hr />' },
        'a-modal': ModalStub
      } }
    })
    await wrapper.get('[aria-label="更多操作"]').trigger('click')
    await wrapper.findComponent(MenuStub).vm.$emit('click', { key: 'delete' })
    await wrapper.get('[data-testid="delete-confirm"] button').trigger('click')
    await flushPromises()
    assert.deepEqual(deleteCalls, ['deleting-report'])
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), true)
    const modal = wrapper.findComponent(ModalStub)
    assert.equal(modal.props('confirmLoading'), true)
    assert.equal(modal.props('maskClosable'), false)
    assert.equal(modal.props('keyboard'), false)
    assert.equal(modal.props('closable'), false)
    assert.deepEqual(modal.props('cancelButtonProps'), { disabled: true })
    await modal.vm.$emit('cancel')
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), true)

    rejectDelete(new Error('delete failed'))
    await flushPromises()
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), true)

    await wrapper.setProps({ deleting: true })
    assert.equal(modal.props('confirmLoading'), true)
    await modal.vm.$emit('cancel')
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), true)
    await wrapper.setProps({ deleting: false })

    await wrapper.get('[data-testid="delete-confirm"] button').trigger('click')
    await flushPromises()
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), true)
    await wrapper.get('[data-testid="delete-confirm"] button').trigger('click')
    await flushPromises()
    assert.equal(wrapper.find('[data-testid="delete-confirm"]').exists(), false)
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('mounted failed task presents mapped safe reason without persisted raw error text', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  const report = {
    id: 'failed-report', title: '工作总结（每周）2026-08-25 09:50', taskNote: '',
    version: 1, status: 'failed', errorText: 'SUMMARY_ARTIFACT_INVALID',
    periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai',
    markdown: null
  }
  let listItem
  let detail
  try {
    listItem = mount(await loadMountedListItem(vite), {
      props: { report, progress: null, selected: false },
      global: { stubs: {
        'a-list-item': { template: '<section><slot /></section>' },
        'a-tag': { template: '<span><slot /></span>' }, 'a-button': true,
        'a-dropdown': true, 'a-menu': true, 'a-menu-item': true, 'a-menu-divider': true, 'a-modal': true
      } }
    })
    detail = mount(await loadMountedReport(vite), {
      props: { report: { ...report, errorText: 'SUMMARY_ARTIFACT_INVALID C:\\private\\secret' }, progress: null },
      global: { stubs: {
        'a-card': { template: '<section><slot /><slot name="extra" /></section>' }, 'a-tag': true,
        'a-descriptions': { template: '<div><slot /></div>' }, 'a-descriptions-item': { template: '<div><slot /></div>' },
        'a-alert': { props: ['message', 'description'], template: '<div>{{ message }} {{ description }}</div>' },
        'a-progress': true, 'a-button': true, 'a-popconfirm': true, 'a-empty': true
      } }
    })
    assert.match(listItem.text(), /报告已生成，但内容结构或安全校验未通过。/)
    assert.match(detail.text(), /工作总结生成失败。/)
    assert.match(detail.text(), /请重试生成总结。/)
    assert.match(detail.text(), /SUMMARY_RUN_FAILED/)
    assert.doesNotMatch(`${listItem.text()} ${detail.text()}`, /C:\\private\\secret/)
  } finally {
    listItem?.unmount()
    detail?.unmount()
    await vite.close()
  }
})

test('mounted panel keeps a newer edit dialog open after an older save resolves and deduplicates deletion', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const first = { id: 'first', title: '第一份', taskNote: '', status: 'completed', version: 1, periodType: 'day', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai' }
  const second = { ...first, id: 'second', title: '第二份' }
  let resolveUpdate
  let resolveDelete
  const updateCalls = []
  const deleteCalls = []
  const stubs = createStubs()
  const api = window.ucli || {}
  window.ucli = api
  const originalApi = { ...api }
  Object.assign(api, {
    listSummaryReports: async () => [first, second], getSummaryReport: async reportId => reportId === first.id ? first : second,
    updateSummaryTask: value => { updateCalls.push(value); return new Promise(resolve => { resolveUpdate = resolve }) },
    deleteSummaryReport: reportId => { deleteCalls.push(reportId); return new Promise(resolve => { resolveDelete = resolve }) },
    onSummaryProgress: () => () => {}
  })
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = shallowMount(await loadMountedPanel(vite, stubs), {
      global: { plugins: [createPinia()], stubs: {
        SummaryGenerateDialog: stubs.GenerateDialogStub, SummaryReportView: stubs.ReportViewStub, SummaryHistory: stubs.HistoryStub,
        SummaryConversationDrawer: stubs.ConversationStub, SummaryHtmlStyleDialog: stubs.HtmlStyleDialogStub,
        'a-button': { template: '<button><slot /></button>' }, 'a-alert': true, 'a-list': { template: '<div><slot /></div>' },
        'a-row': { template: '<div><slot /></div>' }, 'a-col': { template: '<div><slot /></div>' }, 'a-spin': { template: '<div><slot /></div>' }
      } }
    })
    await flushPromises()

    wrapper.vm.openEdit(first)
    const saving = wrapper.vm.saveEdit({ title: '第一份已编辑', taskNote: '备注' })
    await flushPromises()
    assert.deepEqual(updateCalls, [{ reportId: 'first', title: '第一份已编辑', taskNote: '备注' }])
    wrapper.vm.openEdit(second)
    resolveUpdate({ ...first, title: '第一份已编辑', taskNote: '备注' })
    await saving
    assert.equal(wrapper.vm.editDialogOpen, true)
    assert.equal(wrapper.vm.editReport.id, 'second')

    const deleting = wrapper.vm.remove('first')
    const duplicate = wrapper.vm.remove('first')
    assert.deepEqual(deleteCalls, ['first'])
    resolveDelete({ deletedReportId: 'first', currentReportId: null })
    await Promise.all([deleting, duplicate])
  } finally {
    wrapper?.unmount()
    await vite.close()
    Object.assign(api, originalApi)
  }
})

test('mounted panel keeps the real task-card deletion confirmation open when deletion fails', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const report = { id: 'undeletable-report', title: '无法删除的任务', taskNote: '', status: 'completed', version: 1, periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai' }
  const api = window.ucli || {}
  const originalApi = { ...api }
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  let history
  let detail
  let remove
  try {
    Object.assign(api, {
      listSummaryReports: async () => [report], getSummaryReport: async () => report,
      deleteSummaryReport: async () => { throw new Error('delete failed') },
      onSummaryProgress: () => () => {}
    })
    window.ucli = api
    const stubs = createStubs()
    stubs.ReportListItemStub = await loadMountedListItem(vite)
    const MenuStub = defineComponent({ name: 'PanelDeleteMenuStub', emits: ['click'], template: '<div><slot /></div>' })
    wrapper = mount(await loadMountedPanel(vite, stubs), {
      global: { plugins: [createPinia()], stubs: {
        SummaryGenerateDialog: stubs.GenerateDialogStub, SummaryReportView: stubs.ReportViewStub, SummaryHistory: stubs.HistoryStub,
        SummaryConversationDrawer: stubs.ConversationStub, SummaryHtmlStyleDialog: stubs.HtmlStyleDialogStub,
        'a-button': { template: '<button v-bind="$attrs"><slot /></button>' }, 'a-alert': true,
        'a-list': { props: ['dataSource'], template: '<div><slot v-for="item in dataSource" name="renderItem" :item="item" /></div>' },
        'a-list-item': { template: '<section><slot /></section>' }, 'a-tag': { template: '<span><slot /></span>' },
        'a-dropdown': defineComponent({ setup: () => ({ open: Vue.ref(false) }), template: '<div @click.capture="open = true"><slot /><div v-if="open"><slot name="overlay" /></div></div>' }),
        'a-menu': MenuStub, 'a-menu-item': { template: '<button><slot /></button>' }, 'a-menu-divider': { template: '<hr />' },
        'a-modal': { props: ['open'], emits: ['ok'], template: '<section v-if="open" data-testid="delete-confirm"><button @click="$emit(\'ok\')">确认删除</button></section>' },
        'a-row': { template: '<div><slot /></div>' }, 'a-col': { template: '<div><slot /></div>' }, 'a-spin': { template: '<div><slot /></div>' }
      } }
    })
    await flushPromises()
    const card = wrapper.findComponent(stubs.ReportListItemStub)
    await card.get('[aria-label="更多操作"]').trigger('click')
    await card.findComponent(MenuStub).vm.$emit('click', { key: 'delete' })
    await card.get('[data-testid="delete-confirm"] button').trigger('click')
    await flushPromises()
    assert.equal(card.find('[data-testid="delete-confirm"]').exists(), true)
    assert.equal(wrapper.vm.summaries.error.message, '无法删除总结任务')
    remove = wrapper.vm.remove
    assert.equal(await remove(report.id), false)
    wrapper.unmount()
    wrapper = null

    history = mount(await loadMountedHistory(vite), {
      props: { versions: [report], progress: {}, deletingReportIds: new Set(), deleteReport: remove },
      global: { stubs: {
        'a-card': { template: '<section><slot /></section>' }, 'a-list': { props: ['dataSource'], template: '<div><slot v-for="item in dataSource" name="renderItem" :item="item" /></div>' },
        'a-list-item': { template: '<section><slot /><slot name="actions" /></section>' }, 'a-list-item-meta': true,
        'a-button': { template: '<button><slot /></button>' }, 'a-popconfirm': true
      } }
    })
    detail = mount(await loadMountedReport(vite), {
      props: { report, progress: null, deleting: false, deleteReport: remove },
      global: { stubs: {
        'a-card': { template: '<section><slot /><slot name="extra" /></section>' }, 'a-tag': true,
        'a-descriptions': { template: '<div><slot /></div>' }, 'a-descriptions-item': { template: '<div><slot /></div>' },
        'a-alert': true, 'a-progress': true, 'a-button': { template: '<button><slot /></button>' }, 'a-popconfirm': true, 'a-empty': true
      } }
    })
    assert.equal(await history.vm.confirmDelete(report), false)
    assert.equal(await detail.vm.confirmDelete(), false)
  } finally {
    history?.unmount()
    detail?.unmount()
    wrapper?.unmount()
    await vite.close()
    Object.assign(api, originalApi)
  }
})

test('summary task edit dialog emits normalized title and note', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = mount(await loadMountedTaskEditDialog(vite), {
      props: { open: true, report: { id: 'legacy-completed', title: '旧标题', taskNote: '' }, confirmLoading: false },
      global: { stubs: {
        'a-modal': { template: '<section><slot /></section>' }, 'a-form': { template: '<form><slot /></form>' },
        'a-form-item': { template: '<label><slot /></label>' }, 'a-input': { props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
        'a-textarea': { props: ['value'], emits: ['update:value'], template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />' }
      } }
    })
    await wrapper.get('[data-testid="summary-task-title"]').setValue('  8 月 19 日总结  ')
    await wrapper.get('[data-testid="summary-task-note"]').setValue('已复核\r\n第二行')
    await wrapper.get('[data-testid="summary-task-edit-submit"]').trigger('click')
    assert.deepEqual(wrapper.emitted('submit'), [[{ title: '8 月 19 日总结', taskNote: '已复核\n第二行' }]])
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('history delete keeps its documented event fallback when no panel handler is provided', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = mount(await loadMountedHistory(vite), {
      props: { versions: [{ id: 'history-report', title: '历史', status: 'completed', version: 1 }], progress: {} },
      global: { stubs: {
        'a-card': { template: '<section><slot /></section>' }, 'a-list': { props: ['dataSource'], template: '<div><slot v-for="item in dataSource" name="renderItem" :item="item" /></div>' },
        'a-list-item': { template: '<div><slot /><slot name="actions" /></div>' }, 'a-list-item-meta': true, 'a-button': { template: '<button><slot /></button>' },
        'a-popconfirm': { emits: ['confirm'], template: '<button data-testid="history-confirm-delete" @click="$emit(\'confirm\')"><slot /></button>' }
      } }
    })
    await wrapper.get('[data-testid="history-confirm-delete"]').trigger('click')
    assert.deepEqual(wrapper.emitted('delete-report'), [['history-report']])
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('mounted work summary panel uses canonical reports for generation, progress, versions, retry, cancel, and conversations', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ setActivePinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, mount, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const { GenerateDialogStub, ReportViewStub, HistoryStub, ConversationStub, HtmlStyleDialogStub } = createStubs()
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
  Object.assign(window.ucli, {
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
  })

  const vite = await createServer({
    plugins: [vuePlugin()],
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-fit'] },
    server: { middlewareMode: true },
    appType: 'custom'
  })
  let wrapper
  try {
    wrapper = shallowMount(await loadMountedPanel(vite, { GenerateDialogStub, ReportViewStub, HistoryStub, ConversationStub, HtmlStyleDialogStub }), {
      global: {
        plugins: [createPinia()],
        stubs: {
          SummaryGenerateDialog: GenerateDialogStub,
          SummaryReportView: ReportViewStub,
          SummaryHistory: HistoryStub,
          SummaryConversationDrawer: ConversationStub,
          SummaryHtmlStyleDialog: HtmlStyleDialogStub,
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

test('mounted completed report enables export while queued and failed reports cannot emit it', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ mount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  const report = { id: 'report', version: 1, periodStart: 1, periodEndExclusive: 2, markdown: '# 仅完成报告可导出' }
  let wrapper
  try {
    const component = await loadMountedReport(vite)
    for (const status of ['queued', 'failed']) {
      wrapper = mount(component, {
        props: { report: { ...report, status }, progress: null },
        global: { stubs: {
          'a-card': { template: '<section><slot /><slot name="extra" /></section>' }, 'a-tag': true, 'a-descriptions': { template: '<div><slot /></div>' }, 'a-descriptions-item': { template: '<div><slot /></div>' },
          'a-alert': true, 'a-progress': true, 'a-button': { template: '<button><slot /></button>' }, 'a-popconfirm': { template: '<div><slot /></div>' }, 'a-empty': true
        } }
      })
      const exportButtons = wrapper.findAll('button').filter(button => /导出 (?:Markdown|HTML)/.test(button.text()))
      assert.equal(exportButtons.length, 2)
      for (const button of exportButtons) {
        assert.notEqual(button.attributes('disabled'), undefined, `${status} export must be disabled`)
        await button.trigger('click')
      }
      assert.equal(wrapper.emitted('export-markdown'), undefined)
      assert.equal(wrapper.emitted('export-html'), undefined)
      wrapper.unmount()
      wrapper = null
    }
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('terminal reports ignore stale progress and awaiting-confirmation phases', async () => {
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
        report: { id: 'completed', version: 1, status: 'completed', periodStart: Date.UTC(2026, 7, 19), periodEndExclusive: Date.UTC(2026, 7, 19, 3, 28), timezone: 'Asia/Shanghai', markdown: '# 已完成' },
        progress: { phase: 'awaiting_confirmation', completed: 0, total: 1, text: '陈旧进度' }
      },
      global: { stubs: {
        'a-card': { template: '<section>{{ $attrs.title }}<slot /><slot name="extra" /></section>' }, 'a-tag': { template: '<span><slot /></span>' }, 'a-descriptions': { template: '<div><slot /></div>' }, 'a-descriptions-item': { template: '<div><slot /></div>' },
        'a-alert': { props: ['message', 'description'], template: '<div>{{ message }} {{ description }}</div>' }, 'a-progress': true, 'a-button': { template: '<button><slot /></button>' }, 'a-popconfirm': { template: '<div><slot /></div>' }, 'a-empty': true
      } }
    })
    assert.match(wrapper.text(), /已完成/)
    assert.doesNotMatch(wrapper.text(), /陈旧进度|旧版报告等待确认/)
    assert.match(wrapper.text(), /2026\/8\/19 — 2026\/8\/19/)
    await wrapper.setProps({ report: { ...wrapper.props('report'), partial: true, periodEndExclusive: Date.UTC(2026, 7, 20) } })
    assert.match(wrapper.text(), /2026\/8\/19 — 2026\/8\/20/)
  } finally {
    wrapper?.unmount()
    await vite.close()
  }
})

test('mounted panel submits selected HTML style for the completed report without renderer-owned data', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const report = {
    id: 'completed-report', version: 2, status: 'completed', runPhase: 'completed', markdown: '# private markdown',
    periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai', isCurrent: true,
    executorId: 'claude', profileId: 'private-profile', model: 'private-model'
  }
  const exportCalls = []
  const stubs = createStubs()
  stubs.ReportViewStub = defineComponent({
    name: 'SummaryReportView', props: { report: Object }, emits: ['export-html'],
    template: '<button data-testid="summary-open-html-export" @click="$emit(\'export-html\', report.id)">导出 HTML</button>'
  })
  const api = window.ucli
  const originalApi = { ...api }
  Object.assign(api, {
    listSummaryReports: async () => [report], getSummaryReport: async () => report,
    exportSummaryHtml: async value => { exportCalls.push(value); return { canceled: false } },
    exportSummaryMarkdown: async () => ({ canceled: false }), onSummaryProgress: () => () => {}
  })
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = shallowMount(await loadMountedPanel(vite, stubs), {
      global: { plugins: [createPinia()], stubs: {
        SummaryGenerateDialog: stubs.GenerateDialogStub, SummaryReportView: stubs.ReportViewStub, SummaryHistory: stubs.HistoryStub,
        SummaryConversationDrawer: stubs.ConversationStub, SummaryHtmlStyleDialog: stubs.HtmlStyleDialogStub,
        'a-button': { template: '<button><slot /></button>' }, 'a-alert': true, 'a-list': { template: '<div><slot /></div>' },
        'a-list-item': { template: '<div><slot /></div>' }, 'a-list-item-meta': true, 'a-row': { template: '<div><slot /></div>' },
        'a-col': { template: '<div><slot /></div>' }, 'a-spin': { template: '<div><slot /></div>' }
      } }
    })
    await flushPromises()
    await wrapper.get('[data-testid="summary-open-html-export"]').trigger('click')
    assert.deepEqual(exportCalls, [])
    await wrapper.get('[data-testid="summary-export-print"]').trigger('click')
    assert.deepEqual(exportCalls, [{ reportId: 'completed-report', style: { mode: 'theme', themeId: 'print' } }])
    assert.doesNotMatch(JSON.stringify(exportCalls), /private markdown|private-profile|private-model/)
  } finally {
    wrapper?.unmount()
    await vite.close()
    Object.assign(api, originalApi)
  }
})

test('mounted panel maps Markdown export failures to a safe error without leaking the save error', async () => {
  Vue = await import('vue')
  ;({ createServer } = await import('vite'))
  ;({ default: vuePlugin } = await import('@vitejs/plugin-vue'))
  ;({ createPinia } = await import('pinia'))
  ;({ defineComponent } = Vue)
  ;({ flushPromises, shallowMount } = await import('@vue/test-utils'))
  ;({ compileScript, compileTemplate, parse: parseSfc } = await import('@vue/compiler-sfc'))
  const report = {
    id: 'completed-markdown', version: 1, status: 'completed', runPhase: 'completed', markdown: '# 已完成',
    periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai', isCurrent: true
  }
  const stubs = createStubs()
  stubs.ReportViewStub = defineComponent({
    name: 'SummaryReportView', props: { report: Object }, emits: ['export-markdown'],
    template: '<button data-testid="summary-export-markdown" @click="$emit(\'export-markdown\', report.id)">导出 Markdown</button>'
  })
  const api = window.ucli
  const originalApi = { ...api }
  Object.assign(api, {
    listSummaryReports: async () => [report], getSummaryReport: async () => report,
    exportSummaryMarkdown: async () => { throw new Error('C:\\private\\save\密钥.md provider failure') },
    exportSummaryHtml: async () => ({ canceled: false }), onSummaryProgress: () => () => {}
  })
  const vite = await createServer({ plugins: [vuePlugin()], optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' })
  let wrapper
  try {
    wrapper = shallowMount(await loadMountedPanel(vite, stubs), {
      global: { plugins: [createPinia()], stubs: {
        SummaryGenerateDialog: stubs.GenerateDialogStub, SummaryReportView: stubs.ReportViewStub, SummaryHistory: stubs.HistoryStub,
        SummaryConversationDrawer: stubs.ConversationStub, SummaryHtmlStyleDialog: stubs.HtmlStyleDialogStub,
        'a-button': { template: '<button><slot /></button>' }, 'a-alert': { props: ['message'], template: '<p>{{ message }}</p>' },
        'a-list': { template: '<div><slot /></div>' }, 'a-list-item': { template: '<div><slot /></div>' }, 'a-list-item-meta': true,
        'a-row': { template: '<div><slot /></div>' }, 'a-col': { template: '<div><slot /></div>' }, 'a-spin': { template: '<div><slot /></div>' }
      } }
    })
    await flushPromises()
    await wrapper.get('[data-testid="summary-export-markdown"]').trigger('click').catch(() => {})
    await flushPromises()
    assert.equal(wrapper.vm.summaries.error?.message, '无法导出总结报告')
    assert.match(wrapper.text(), /无法完成总结操作/)
    assert.doesNotMatch(wrapper.text(), /private|provider|密钥/i)
  } finally {
    wrapper?.unmount()
    await vite.close()
    Object.assign(api, originalApi)
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
