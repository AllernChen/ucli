import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const installerScript = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')

function extractOwnedExecutable(value, suffix) {
  if (!value.startsWith('"') || !value.endsWith(suffix)) return null
  const executable = value.slice(1, -suffix.length)
  return /^[A-Za-z]:\\/.test(executable) ? executable : null
}

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

test('NSIS overwrites this install registration and only removes both normalized owned values on uninstall', () => {
  const uninstall = installerScript.match(/!macro customUnInstall\r?\n([\s\S]*?)!macroend/)
  assert.ok(uninstall, 'customUnInstall macro must exist')
  assert.match(uninstall[1], /ReadRegStr \$R0 HKCU "Software\\Classes\\ucli\\shell\\open\\command" ""/)
  assert.match(uninstall[1], /ReadRegStr \$R1 HKCU "Software\\Classes\\ucli\\DefaultIcon" ""/)
  assert.match(uninstall[1], /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/)
  assert.match(uninstall[1], /Call un\.UcliProtocolCommandPath/)
  assert.match(uninstall[1], /Call un\.UcliProtocolIconPath/)
  assert.match(uninstall[1], /Call un\.UcliProtocolPathsMatch/)
  assert.match(uninstall[1], /DeleteRegKey HKCU "Software\\Classes\\ucli"/)
  const commandPath = installerScript.match(/Function un\.UcliProtocolCommandPath\r?\n([\s\S]*?)FunctionEnd/)
  const iconPath = installerScript.match(/Function un\.UcliProtocolIconPath\r?\n([\s\S]*?)FunctionEnd/)
  assert.ok(commandPath && iconPath, 'uninstaller path extraction helpers must exist')
  assert.match(installerScript, /!ifdef BUILD_UNINSTALLER[\s\S]*?Function un\.UcliProtocolCommandPath/)
  assert.match(commandPath[1], /StrCmp \$R3.*%1/)
  assert.match(commandPath[1], /GetFullPathName/)
  assert.match(iconPath[1], /StrCmp \$R3.*,0/)
  assert.match(iconPath[1], /GetFullPathName/)
  assert.match(installerScript, /Function un\.UcliProtocolPathsMatch[\s\S]*?lstrcmpi[\s\S]*?FunctionEnd/)
  assert.doesNotMatch(installerScript, /Function UcliProtocolValueMatches|Call UcliProtocolValueMatches/)
})

test('protocol ownership normalization accepts only a quoted absolute executable with its exact suffix', () => {
  assert.equal(
    extractOwnedExecutable('"C:\\Program Files\\UCLI\\UCLI.exe" "%1"', '" "%1"'),
    'C:\\Program Files\\UCLI\\UCLI.exe'
  )
  assert.equal(
    extractOwnedExecutable('"C:\\Program Files\\UCLI\\UCLI.exe",0', '",0'),
    'C:\\Program Files\\UCLI\\UCLI.exe'
  )
  for (const [value, suffix] of [
    ['C:\\Program Files\\UCLI\\UCLI.exe" "%1"', '" "%1"'],
    ['"relative\\UCLI.exe" "%1"', '" "%1"'],
    ['"C:\\Program Files\\UCLI\\UCLI.exe" --open "%1"', '" "%1"'],
    ['"C:\\Program Files\\UCLI\\UCLI.exe",1', '",0']
  ]) assert.equal(extractOwnedExecutable(value, suffix), null)
})

test('portable packaging and runtime leave installed protocol ownership untouched', () => {
  const portableIndex = builderConfig.search(/^portable:\r?\n/m)
  assert.notEqual(portableIndex, -1, 'portable target must remain configured')
  assert.doesNotMatch(builderConfig.slice(portableIndex), /registry|protocol/i)
  assert.doesNotMatch(installerScript, /!macro customPortable/i)
  assert.doesNotMatch(mainSource, /setAsDefaultProtocolClient|removeAsDefaultProtocolClient|setDefaultProtocolClient|removeDefaultProtocolClient/)
})
