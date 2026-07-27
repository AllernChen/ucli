const { chmodSync, existsSync } = require('fs')
const path = require('path')

function ensureNodePtySpawnHelpersExecutable({
  appRoot = process.cwd(),
  platform = process.platform
} = {}) {
  if (platform !== 'darwin') return []

  const changed = []
  for (const arch of ['x64', 'arm64']) {
    const helper = path.join(
      appRoot,
      'node_modules',
      'node-pty',
      'prebuilds',
      `darwin-${arch}`,
      'spawn-helper'
    )
    if (!existsSync(helper)) continue
    chmodSync(helper, 0o755)
    changed.push(helper)
  }
  return changed
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appRoot = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app'
  )
  const changed = ensureNodePtySpawnHelpersExecutable({ appRoot, platform: 'darwin' })
  if (!changed.length) throw new Error('node-pty macOS spawn-helper was not packaged')
}

module.exports = afterPack
module.exports.ensureNodePtySpawnHelpersExecutable = ensureNodePtySpawnHelpersExecutable

if (require.main === module) {
  const changed = ensureNodePtySpawnHelpersExecutable()
  if (process.platform === 'darwin' && !changed.length) {
    throw new Error('node-pty macOS spawn-helper was not installed')
  }
}
