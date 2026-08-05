; electron-builder's default check matches every UCLI.exe owned by the user.
; Scope modern installs by executable path. Legacy uninstallers still perform
; the global name check, so one upgrade must close all same-name processes.

!define UCLI_PROCESS_MARKER ".ucli-scoped-process-check"
!define UCLI_PROCESS_SCRIPT "ucli-installer-process.ps1"

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
!macroend
