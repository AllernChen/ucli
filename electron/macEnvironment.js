import { spawnSync } from 'child_process'

const PATH_MARKER = '__UCLI_PATH__'
const PATH_COMMAND = `printf "${PATH_MARKER}%s\\n" "$PATH"`

export function applyMacLoginPath({
  platform = process.platform,
  env = process.env,
  run = spawnSync
} = {}) {
  if (platform !== 'darwin') return env.PATH || ''

  const currentPath = env.PATH || ''
  const shell = env.SHELL || '/bin/zsh'
  const result = run(shell, ['-ilc', PATH_COMMAND], {
    encoding: 'utf8',
    env,
    timeout: 5000,
    windowsHide: true
  })
  if (result.status !== 0) return currentPath

  const pathLine = String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(PATH_MARKER))
    .at(-1)
  const loginPath = pathLine?.slice(PATH_MARKER.length).trim()
  if (!loginPath) return currentPath

  env.PATH = loginPath
  return loginPath
}
