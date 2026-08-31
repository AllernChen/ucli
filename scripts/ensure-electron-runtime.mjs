import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..')

function runtimeRelativePath(platform) {
  if (platform === 'win32') return 'electron.exe'
  if (platform === 'darwin') return path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
  return 'electron'
}

export function ensureElectronRuntime({
  electronDir = path.join(repoRoot, 'node_modules', 'electron'),
  platform = process.platform,
} = {}) {
  const runtimePath = path.join(electronDir, 'dist', runtimeRelativePath(platform))
  if (existsSync(runtimePath)) return

  const installerPath = path.join(electronDir, 'install.js')
  if (!existsSync(installerPath)) throw new Error('Electron installer is unavailable')

  const result = spawnSync(process.execPath, [installerPath], { stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error('Electron runtime installation failed')
  if (!existsSync(runtimePath)) throw new Error('Electron runtime is unavailable after installation')
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    ensureElectronRuntime()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Electron runtime installation failed')
    process.exitCode = 1
  }
}
