import {
  buildDiagnosticReport,
  diagnosticReportFileName,
  serializeDiagnosticReport
} from './diagnostics.js'

export function createDiagnosticsService({
  getRuntime,
  inspectCliTools,
  getPersistence,
  showSaveDialog,
  writeFile
}) {
  async function getReport() {
    return buildDiagnosticReport({
      ...getRuntime(),
      cliTools: await inspectCliTools(),
      persistence: getPersistence()
    })
  }

  async function exportReport() {
    const report = await getReport()
    const result = await showSaveDialog({
      title: 'Export UCLI diagnostics',
      defaultPath: diagnosticReportFileName(report),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    writeFile(result.filePath, serializeDiagnosticReport(report), 'utf8')
    return { canceled: false, filePath: result.filePath }
  }

  return { getReport, exportReport }
}
