import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDiagnosticReport,
  diagnosticReportFileName,
  serializeDiagnosticReport
} from '../electron/diagnostics.js'

const runtime = {
  generatedAt: '2026-07-28T01:02:03.000Z',
  appVersion: '0.4.7',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '32.3.3',
  nodeVersion: '20.19.0'
}

test('diagnostic report keeps only approved runtime and CLI fields', () => {
  const report = buildDiagnosticReport({
    ...runtime,
    cliTools: [{
      id: 'codex',
      installed: true,
      version: '0.83.0',
      path: 'C:\\Users\\Ada\\bin\\codex.cmd',
      error: 'token abc',
      installCommand: 'npm install -g @openai/codex'
    }],
    persistence: { available: true, recoveryInfo: null }
  })

  assert.deepEqual(report, {
    schemaVersion: 1,
    generatedAt: runtime.generatedAt,
    application: {
      name: 'UCLI',
      version: '0.4.7',
      platform: 'win32',
      arch: 'x64',
      electron: '32.3.3',
      node: '20.19.0'
    },
    cliTools: [{ id: 'codex', installed: true, version: '0.83.0' }],
    persistence: { status: 'ready' }
  })
  const serialized = serializeDiagnosticReport(report)
  assert.doesNotMatch(serialized, /Ada|abc|codex\.cmd|npm install/)
  assert.equal(diagnosticReportFileName(report), 'ucli-diagnostics-20260728-010203.json')
  assert.match(serialized, /\n$/)
})

test('diagnostic report represents recovered and unavailable storage without paths', () => {
  const recovered = buildDiagnosticReport({
    ...runtime,
    cliTools: [],
    persistence: { available: true, recoveryInfo: { backupPath: 'C:\\secret\\ucli.db.bak' } }
  })
  const unavailable = buildDiagnosticReport({
    ...runtime,
    cliTools: [],
    persistence: { available: false }
  })

  assert.equal(recovered.persistence.status, 'recovered')
  assert.equal(unavailable.persistence.status, 'unavailable')
  assert.doesNotMatch(serializeDiagnosticReport(recovered), /secret|ucli\.db/)
})
