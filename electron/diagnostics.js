/**
 * Build a support report from an explicit allowlist. Keep this module free of
 * Electron APIs so it can be tested without loading the desktop runtime.
 */
export function buildDiagnosticReport({
  generatedAt,
  appVersion,
  platform,
  arch,
  electronVersion,
  nodeVersion,
  cliTools = [],
  persistence,
  gateway
}) {
  return {
    schemaVersion: 1,
    generatedAt,
    application: {
      name: 'UCLI',
      version: appVersion,
      platform,
      arch,
      electron: electronVersion,
      node: nodeVersion
    },
    cliTools: cliTools.map(({ id, installed, version }) => ({
      id,
      installed: Boolean(installed),
      version: installed ? String(version || '') : ''
    })),
    persistence: {
      status: persistence?.available
        ? (persistence.recoveryInfo ? 'recovered' : 'ready')
        : 'unavailable'
    },
    ...(gateway ? { gateway } : {})
  }
}

export function diagnosticReportFileName(report) {
  const [date = '', time = ''] = String(report.generatedAt || '').split('T')
  const timestamp = date && time
    ? `${date.replace(/\D/g, '')}-${time.replace(/\.\d+Z?$/, '').replace(/\D/g, '')}`
    : ''
  return `ucli-diagnostics-${timestamp || 'unknown'}.json`
}

export function serializeDiagnosticReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}
