import test from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnosticsService } from '../electron/diagnosticsService.js'

const runtime = {
  generatedAt: '2026-07-28T01:02:03.000Z',
  appVersion: '0.4.7',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '32.3.3',
  nodeVersion: '20.19.0'
}

test('diagnostics export writes a freshly collected safe report only after save confirmation', async () => {
  const writes = []
  const service = createDiagnosticsService({
    getRuntime: () => runtime,
    inspectCliTools: async () => [{
      id: 'claude',
      installed: true,
      version: '1.0.0',
      path: 'C:\\Users\\Ada\\bin\\claude.cmd',
      error: 'token abc'
    }],
    getPersistence: () => ({ available: true, recoveryInfo: null }),
    showSaveDialog: async (options) => {
      assert.equal(options.defaultPath, 'ucli-diagnostics-20260728-010203.json')
      return { canceled: false, filePath: 'C:\\Temp\\report.json' }
    },
    writeFile: (path, content, encoding) => writes.push({ path, content, encoding })
  })

  const result = await service.exportReport()

  assert.deepEqual(result, { canceled: false, filePath: 'C:\\Temp\\report.json' })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, 'C:\\Temp\\report.json')
  assert.equal(writes[0].encoding, 'utf8')
  assert.doesNotMatch(writes[0].content, /Ada|abc|claude\.cmd/)
})

test('diagnostics export does not write when the user cancels the save dialog', async () => {
  let writeCount = 0
  const service = createDiagnosticsService({
    getRuntime: () => runtime,
    inspectCliTools: async () => [],
    getPersistence: () => ({ available: false }),
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: () => { writeCount += 1 }
  })

  assert.deepEqual(await service.exportReport(), { canceled: true })
  assert.equal(writeCount, 0)
})

test('diagnostics service tolerates unavailable profile health without leaking errors', async () => {
  const service = createDiagnosticsService({
    getRuntime: () => runtime,
    inspectCliTools: async () => [],
    getPersistence: () => ({ available: true }),
    getAiCliProfiles: () => {
      throw new Error('https://secret.example.com key-1234')
    },
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: () => {}
  })
  const report = await service.getReport()
  assert.deepEqual(report.aiCliProfiles, {
    total: 0, ready: 0, drifted: 0, missing: 0,
    codexHomeWritable: false, lastReconcileAt: null,
    claude: {
      total: 0,
      connectionModes: { subscription: 0, apiKey: 0, bearer: 0 },
      missingSecret: 0,
      modelSubstitutions: 0
    }
  })
  assert.doesNotMatch(JSON.stringify(report), /secret\.example|key-1234/)
})
