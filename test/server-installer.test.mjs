import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const installerScript = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')

test('builder declares the UCLI Connection URL scheme for installed macOS metadata', () => {
  assert.match(builderConfig, /^protocols:\s*\r?\n\s*- name: UCLI Connection\s*\r?\n\s+schemes:\s*\r?\n\s+- ucli\s*$/m)
  assert.match(builderConfig, /^mac:\s*[\s\S]*?^  target:\s*\r?\n\s+- dmg\s*\r?\n\s+- zip\s*$/m)
})

test('NSIS installer owns ucli under HKCU with a quoted executable and URL argument', () => {
  const install = installerScript.match(/!macro customInstall\r?\n([\s\S]*?)!macroend/)
  assert.ok(install, 'customInstall macro must exist')
  assert.match(install[1], /WriteRegStr HKCU "Software\\Classes\\ucli" "" "URL:UCLI Connection"/)
  assert.match(install[1], /WriteRegStr HKCU "Software\\Classes\\ucli" "URL Protocol" ""/)
  assert.match(install[1], /WriteRegStr HKCU "Software\\Classes\\ucli\\DefaultIcon" "" "\$\\\"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}\$\\\",0"/)
  assert.match(install[1], /WriteRegStr HKCU "Software\\Classes\\ucli\\shell\\open\\command" "" "\$\\\"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}\$\\\" \$\\\"%1\$\\\""/)
  assert.doesNotMatch(install[1], /HKCR|HKEY_CLASSES_ROOT/)
})

test('NSIS overwrites this install registration and only removes both owned values on uninstall', () => {
  const uninstall = installerScript.match(/!macro customUnInstall\r?\n([\s\S]*?)!macroend/)
  assert.ok(uninstall, 'customUnInstall macro must exist')
  assert.match(uninstall[1], /ReadRegStr \$R0 HKCU "Software\\Classes\\ucli\\shell\\open\\command" ""/)
  assert.match(uninstall[1], /ReadRegStr \$R1 HKCU "Software\\Classes\\ucli\\DefaultIcon" ""/)
  assert.match(uninstall[1], /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/)
  assert.match(uninstall[1], /Call UcliProtocolValueMatches/)
  assert.match(uninstall[1], /DeleteRegKey HKCU "Software\\Classes\\ucli"/)
  assert.match(installerScript, /Function UcliProtocolValueMatches[\s\S]*?lstrcmpi[\s\S]*?FunctionEnd/)
})

test('portable packaging and runtime leave installed protocol ownership untouched', () => {
  const portableIndex = builderConfig.indexOf('portable:\r\n')
  assert.notEqual(portableIndex, -1, 'portable target must remain configured')
  assert.doesNotMatch(builderConfig.slice(portableIndex), /registry|protocol/i)
  assert.doesNotMatch(installerScript, /!macro customPortable/i)
  assert.doesNotMatch(mainSource, /setAsDefaultProtocolClient|removeAsDefaultProtocolClient|setDefaultProtocolClient|removeDefaultProtocolClient/)
})
