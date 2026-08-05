import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('NSIS only checks UCLI running from the selected install directory', () => {
  const config = read('electron-builder.yml')
  const script = read('build/installer.nsh')

  assert.match(config, /nsis:[\s\S]*include:\s*build\/installer\.nsh/)
  assert.match(script, /!macro customCheckAppRunning/)
  assert.match(script, /Get-Process -Name '\$\{APP_EXECUTABLE_FILENAME\}'/)
  assert.match(script, /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/)
  assert.doesNotMatch(script, /taskkill \/im "\$\{APP_EXECUTABLE_FILENAME\}"/)
})
