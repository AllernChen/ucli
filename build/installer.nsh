; electron-builder's default check matches every UCLI.exe owned by the user.
; Scope modern installs by executable path. Legacy uninstallers still perform
; the global name check, so one upgrade must close all same-name processes.

!define UCLI_PROCESS_MARKER ".ucli-scoped-process-check"
!define UCLI_PROCESS_SCRIPT "ucli-installer-process.ps1"

!ifdef BUILD_UNINSTALLER
; The installer and uninstaller are compiled separately. Keep these helpers in
; the uninstaller namespace and accept only the exact forms written above.
Function un.UcliProtocolCommandPath
  Pop $R0
  StrCpy $R1 $R0 1
  StrCmp $R1 "$\"" 0 unUcliProtocolCommandPathInvalid
  StrCpy $R2 1

  unUcliProtocolCommandPathFindQuote:
    StrCpy $R3 $R0 1 $R2
    StrCmp $R3 "" unUcliProtocolCommandPathInvalid
    StrCmp $R3 "$\"" unUcliProtocolCommandPathValidate unUcliProtocolCommandPathNext

  unUcliProtocolCommandPathNext:
    IntOp $R2 $R2 + 1
    Goto unUcliProtocolCommandPathFindQuote

  unUcliProtocolCommandPathValidate:
    IntOp $R4 $R2 - 1
    StrCpy $R1 $R0 $R4 1
    StrCpy $R3 $R0 "" $R2
    StrCmp $R3 "$\" $\"%1$\"" 0 unUcliProtocolCommandPathInvalid
    StrCpy $R3 $R1 1
    StrCmp $R3 "\" unUcliProtocolCommandPathCheckUnc unUcliProtocolCommandPathCheckDrive

  unUcliProtocolCommandPathCheckUnc:
    StrCpy $R3 $R1 1 1
    StrCmp $R3 "\" unUcliProtocolCommandPathCanonical unUcliProtocolCommandPathInvalid

  unUcliProtocolCommandPathCheckDrive:
    StrCpy $R3 $R1 1 1
    StrCmp $R3 ":" 0 unUcliProtocolCommandPathInvalid
    StrCpy $R3 $R1 1 2
    StrCmp $R3 "\" 0 unUcliProtocolCommandPathInvalid

  unUcliProtocolCommandPathCanonical:
    GetFullPathName $R1 "$R1"
    Push $R1
    Return

  unUcliProtocolCommandPathInvalid:
    Push ""
FunctionEnd

Function un.UcliProtocolIconPath
  Pop $R0
  StrCpy $R1 $R0 1
  StrCmp $R1 "$\"" 0 unUcliProtocolIconPathInvalid
  StrCpy $R2 1

  unUcliProtocolIconPathFindQuote:
    StrCpy $R3 $R0 1 $R2
    StrCmp $R3 "" unUcliProtocolIconPathInvalid
    StrCmp $R3 "$\"" unUcliProtocolIconPathValidate unUcliProtocolIconPathNext

  unUcliProtocolIconPathNext:
    IntOp $R2 $R2 + 1
    Goto unUcliProtocolIconPathFindQuote

  unUcliProtocolIconPathValidate:
    IntOp $R4 $R2 - 1
    StrCpy $R1 $R0 $R4 1
    StrCpy $R3 $R0 "" $R2
    StrCmp $R3 "$\",0" 0 unUcliProtocolIconPathInvalid
    StrCpy $R3 $R1 1
    StrCmp $R3 "\" unUcliProtocolIconPathCheckUnc unUcliProtocolIconPathCheckDrive

  unUcliProtocolIconPathCheckUnc:
    StrCpy $R3 $R1 1 1
    StrCmp $R3 "\" unUcliProtocolIconPathCanonical unUcliProtocolIconPathInvalid

  unUcliProtocolIconPathCheckDrive:
    StrCpy $R3 $R1 1 1
    StrCmp $R3 ":" 0 unUcliProtocolIconPathInvalid
    StrCpy $R3 $R1 1 2
    StrCmp $R3 "\" 0 unUcliProtocolIconPathInvalid

  unUcliProtocolIconPathCanonical:
    GetFullPathName $R1 "$R1"
    Push $R1
    Return

  unUcliProtocolIconPathInvalid:
    Push ""
FunctionEnd

Function un.UcliProtocolPathsMatch
  Pop $R1
  Pop $R0
  System::Call 'kernel32::lstrcmpi(t r0, t r1) i.r2'
  StrCmp $R2 0 unUcliProtocolPathsMatchYes unUcliProtocolPathsMatchNo

  unUcliProtocolPathsMatchYes:
    Push 1
    Goto unUcliProtocolPathsMatchDone

  unUcliProtocolPathsMatchNo:
    Push 0

  unUcliProtocolPathsMatchDone:
FunctionEnd
!endif

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
  StrCpy $0 $R0
  StrCpy $1 $R1
  StrCpy $2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  GetFullPathName $2 "$2"

  Push $0
  Call un.UcliProtocolCommandPath
  Pop $3
  ${if} $3 == ""
    Goto ucliProtocolNotOwned
  ${endIf}

  Push $3
  Push $2
  Call un.UcliProtocolPathsMatch
  Pop $4
  ${if} $4 != 1
    Goto ucliProtocolNotOwned
  ${endIf}

  Push $1
  Call un.UcliProtocolIconPath
  Pop $3
  ${if} $3 == ""
    Goto ucliProtocolNotOwned
  ${endIf}

  Push $3
  Push $2
  Call un.UcliProtocolPathsMatch
  Pop $4
  ${if} $4 != 1
    Goto ucliProtocolNotOwned
  ${endIf}

  DeleteRegKey HKCU "Software\Classes\ucli"

  ucliProtocolNotOwned:
!macroend
