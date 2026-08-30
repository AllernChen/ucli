import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const installerScript = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')

function extractOwnedExecutable(value, suffix) {
  if (!value.startsWith('"') || !value.endsWith(suffix)) return null
  const executable = value.slice(1, -suffix.length)
  return /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(executable) ? executable : null
}

function nsisStrCpy(value, length, startOffset) {
  return value.slice(startOffset, startOffset + length)
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

test('NSIS removes only both exact owned values after the installed executable is gone', () => {
  const uninstall = installerScript.match(/!macro customUnInstall\r?\n([\s\S]*?)!macroend/)
  assert.ok(uninstall, 'customUnInstall macro must exist')
  assert.match(uninstall[1], /ReadRegStr \$R0 HKCU "Software\\Classes\\ucli\\shell\\open\\command" ""/)
  assert.match(uninstall[1], /ReadRegStr \$R1 HKCU "Software\\Classes\\ucli\\DefaultIcon" ""/)
  assert.match(uninstall[1], /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/)
  assert.match(uninstall[1], /Call un\.UcliProtocolCommandPath/)
  assert.match(uninstall[1], /Call un\.UcliProtocolIconPath/)
  assert.match(uninstall[1], /Call un\.UcliProtocolPathsMatch/)
  assert.match(uninstall[1], /DeleteRegKey HKCU "Software\\Classes\\ucli"/)
  assert.doesNotMatch(uninstall[1], /GetFullPathName/, 'ownership comparison must survive post-delete uninstall hooks')
  const commandPath = installerScript.match(/Function un\.UcliProtocolCommandPath\r?\n([\s\S]*?)FunctionEnd/)
  const iconPath = installerScript.match(/Function un\.UcliProtocolIconPath\r?\n([\s\S]*?)FunctionEnd/)
  assert.ok(commandPath && iconPath, 'uninstaller path extraction helpers must exist')
  const pathsMatch = installerScript.match(/Function un\.UcliProtocolPathsMatch\r?\n([\s\S]*?)FunctionEnd/)
  assert.ok(pathsMatch, 'uninstaller path comparison helper must exist')
  assert.match(installerScript, /!ifdef BUILD_UNINSTALLER[\s\S]*?Function un\.UcliProtocolCommandPath/)
  assert.match(commandPath[1], /StrCmp \$R3.*%1/)
  assert.match(commandPath[1], /IntOp \$R4 \$R2 - 1/)
  assert.match(commandPath[1], /StrCpy \$R1 \$R0 \$R4 1/)
  assert.match(commandPath[1], /unUcliProtocolCommandPathCheckUnc/)
  assert.ok(commandPath[1].includes('StrCmp $R3 "\\" unUcliProtocolCommandPathCheckUnc'))
  assert.doesNotMatch(commandPath[1], /GetFullPathName/, 'ownership parsing must not require the deleted executable to exist')
  assert.match(iconPath[1], /StrCmp \$R3.*,0/)
  assert.match(iconPath[1], /IntOp \$R4 \$R2 - 1/)
  assert.match(iconPath[1], /StrCpy \$R1 \$R0 \$R4 1/)
  assert.match(iconPath[1], /unUcliProtocolIconPathCheckUnc/)
  assert.ok(iconPath[1].includes('StrCmp $R3 "\\" unUcliProtocolIconPathCheckUnc'))
  assert.doesNotMatch(iconPath[1], /GetFullPathName/, 'ownership parsing must not require the deleted executable to exist')
  assert.match(pathsMatch[1], /lstrcmpi\(t R0, t R1\) i\.R2/)
  assert.doesNotMatch(pathsMatch[1], /lstrcmpi\(t r0, t r1\)/, 'the comparison must read the popped $R0 and $R1 paths')
  assert.doesNotMatch(pathsMatch[1], /i\.r2/, 'the comparison must not overwrite caller register $2')
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
  assert.equal(
    extractOwnedExecutable('"\\\\server\\share\\UCLI\\UCLI.exe" "%1"', '" "%1"'),
    '\\\\server\\share\\UCLI\\UCLI.exe'
  )
  for (const [value, suffix] of [
    ['C:\\Program Files\\UCLI\\UCLI.exe" "%1"', '" "%1"'],
    ['"relative\\UCLI.exe" "%1"', '" "%1"'],
    ['"\\\\server" "%1"', '" "%1"'],
    ['"C:\\Program Files\\UCLI\\UCLI.exe" --open "%1"', '" "%1"'],
    ['"C:\\Program Files\\UCLI\\UCLI.exe",1', '",0']
  ]) assert.equal(extractOwnedExecutable(value, suffix), null)
})

test('NSIS path extraction excludes the closing quote at its discovered index', () => {
  const value = '"C:\\Program Files\\UCLI\\UCLI.exe" "%1"'
  const closingQuoteIndex = value.indexOf('"', 1)

  assert.equal(
    nsisStrCpy(value, closingQuoteIndex, 1),
    'C:\\Program Files\\UCLI\\UCLI.exe"',
    'using the quote index as NSIS length retains the closing quote'
  )
  assert.equal(
    nsisStrCpy(value, closingQuoteIndex - 1, 1),
    'C:\\Program Files\\UCLI\\UCLI.exe'
  )
})

test('portable packaging and runtime leave installed protocol ownership untouched', () => {
  const portableIndex = builderConfig.search(/^portable:\r?\n/m)
  assert.notEqual(portableIndex, -1, 'portable target must remain configured')
  assert.doesNotMatch(builderConfig.slice(portableIndex), /registry|protocol/i)
  assert.doesNotMatch(installerScript, /!macro customPortable/i)
  assert.doesNotMatch(mainSource, /setAsDefaultProtocolClient|removeAsDefaultProtocolClient|setDefaultProtocolClient|removeDefaultProtocolClient/)
})

test('assisted and silent upgrades stop the installed app before invoking the old uninstaller', () => {
  const header = installerScript.match(/!macro customHeader\r?\n([\s\S]*?)!macroend/)
  const preInstallHook = installerScript.match(/!macro customPageAfterChangeDir\r?\n([\s\S]*?)!macroend/)
  const silentInit = installerScript.match(/!macro customInit\r?\n([\s\S]*?)!macroend/)
  const stopFunction = installerScript.match(/Function UcliStopBeforeInstall\r?\n([\s\S]*?)FunctionEnd/)

  assert.ok(header, 'pre-install callback must be declared after the shared NSIS includes')
  assert.match(header[1], /Function UcliStopBeforeInstall/)
  assert.ok(preInstallHook, 'assisted installs need a pre-install process-stop hook')
  assert.match(preInstallHook[1], /!undef MUI_PAGE_CUSTOMFUNCTION_PRE[\s\S]*!define MUI_PAGE_CUSTOMFUNCTION_PRE UcliStopBeforeInstall/)
  assert.match(preInstallHook[1], /!define MUI_PAGE_CUSTOMFUNCTION_PRE UcliStopBeforeInstall/)
  assert.doesNotMatch(preInstallHook[1], /Page custom/)
  assert.ok(silentInit, 'silent installs need an initialization process-stop hook')
  assert.match(silentInit[1], /\$\{If\} \$\{Silent\}/)
  assert.match(silentInit[1], /!insertmacro stopUcliBeforeInstall/)
  assert.ok(stopFunction, 'the pre-install callback must exist')
  assert.match(stopFunction[1], /Call instFilesPre[\s\S]*!insertmacro stopUcliBeforeInstall/)
  assert.match(stopFunction[1], /!insertmacro stopUcliBeforeInstall/)
  assert.doesNotMatch(stopFunction[1], /Abort/)
})
