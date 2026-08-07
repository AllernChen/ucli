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
  gateway,
  aiCliProfiles
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
    ...(aiCliProfiles ? {
      aiCliProfiles: {
        total: safeCount(aiCliProfiles.total),
        ready: safeCount(aiCliProfiles.ready),
        drifted: safeCount(aiCliProfiles.drifted),
        missing: safeCount(aiCliProfiles.missing),
        codexHomeWritable: aiCliProfiles.codexHomeWritable === true,
        lastReconcileAt: Number.isFinite(aiCliProfiles.lastReconcileAt)
          ? aiCliProfiles.lastReconcileAt
          : null,
        ...(aiCliProfiles.claude && typeof aiCliProfiles.claude === 'object' ? {
          claude: {
            total: safeCount(aiCliProfiles.claude.total),
            connectionModes: {
              subscription: safeCount(aiCliProfiles.claude.connectionModes?.subscription),
              apiKey: safeCount(aiCliProfiles.claude.connectionModes?.apiKey),
              bearer: safeCount(aiCliProfiles.claude.connectionModes?.bearer)
            },
            missingSecret: safeCount(aiCliProfiles.claude.missingSecret),
            modelSubstitutions: safeCount(aiCliProfiles.claude.modelSubstitutions)
          }
        } : {})
      }
    } : {}),
    ...(gateway ? { gateway } : {})
  }
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
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
