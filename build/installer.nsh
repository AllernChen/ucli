; electron-builder's default check matches every UCLI.exe owned by the user.
; Scope modern installs by executable path. Legacy uninstallers still perform
; the global name check, so one upgrade must close all same-name processes.

!define UCLI_PROCESS_MARKER ".ucli-scoped-process-check"
!define UCLI_PROCESS_SCRIPT "ucli-installer-process.ps1"

; Compare registry values case-insensitively, matching Windows path semantics
; while retaining the canonical command and icon forms written by this installer.
Function UcliProtocolValueMatches
  Pop $R1
  Pop $R0
  System::Call 'kernel32::lstrcmpi(t r0, t r1) i.r2'
  StrCmp $R2 0 ucliProtocolValueMatchesYes ucliProtocolValueMatchesNo

  ucliProtocolValueMatchesYes:
    Push 1
    Goto ucliProtocolValueMatchesDone

  ucliProtocolValueMatchesNo:
    Push 0

  ucliProtocolValueMatchesDone:
FunctionEnd

!macro stageUcliProcessScript
  InitPluginsDir
  File /oname=$PLUGINSDIR\${UCLI_PROCESS_SCRIPT} "${BUILD_RESOURCES_DIR}\installer-process.ps1"
!macroend

!macro customCheckAppRunning
  !insertmacro stageUcliProcessScript
  StrCpy $R0 `$INSTDIR\${APP_EXECUTABLE_FILENAME}`
  StrCpy $R3 ""
  ${if} ${FileExists} "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"
  ${andIfNot} ${FileExists} "$INSTDIR\${UCLI_PROCESS_MARKER}"
    StrCpy $R3 "-Legacy"
  ${endIf}

  checkUcliProcess:
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\${UCLI_PROCESS_SCRIPT}" -Action Find -TargetPath "$R0" $R3`
  Pop $R1
  Pop $R2
  ${if} $R1 != 0
    Goto ucliNotRunning
  ${endIf}

  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK stopUcliProcess
  Quit

  stopUcliProcess:
  DetailPrint `Closing running "${PRODUCT_NAME}" from "$R0"...`
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\${UCLI_PROCESS_SCRIPT}" -Action Stop -TargetPath "$R0" $R3`
  Pop $R1
  Pop $R2

  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\${UCLI_PROCESS_SCRIPT}" -Action Find -TargetPath "$R0" $R3`
  Pop $R1
  Pop $R2
  ${if} $R1 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY checkUcliProcess
    Quit
  ${endIf}

  ucliNotRunning:
!macroend

!macro customInstall
  FileOpen $R4 "$INSTDIR\${UCLI_PROCESS_MARKER}" w
  FileWrite $R4 "scoped-process-check-v1"
  FileClose $R4

  ; Installer-only registration: portable builds do not include this macro.
  WriteRegStr HKCU "Software\Classes\ucli" "" "URL:UCLI Connection"
  WriteRegStr HKCU "Software\Classes\ucli" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\ucli\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Classes\ucli\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

!macro customUnInstall
  ReadRegStr $R0 HKCU "Software\Classes\ucli\shell\open\command" ""
  ReadRegStr $R1 HKCU "Software\Classes\ucli\DefaultIcon" ""
  StrCpy $R2 "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
  StrCpy $R3 "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"

  Push $R0
  Push $R2
  Call UcliProtocolValueMatches
  Pop $R4
  ${if} $R4 != 1
    Goto ucliProtocolNotOwned
  ${endIf}

  Push $R1
  Push $R3
  Call UcliProtocolValueMatches
  Pop $R4
  ${if} $R4 != 1
    Goto ucliProtocolNotOwned
  ${endIf}

  DeleteRegKey HKCU "Software\Classes\ucli"

  ucliProtocolNotOwned:
!macroend
