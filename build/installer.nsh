; electron-builder's default check matches every UCLI.exe owned by the user.
; That incorrectly blocks an upgrade when a portable or another installation is
; open. Match the executable in this installation directory instead.

!macro customCheckAppRunning
  StrCpy $R0 `$INSTDIR\${APP_EXECUTABLE_FILENAME}`

  checkUcliProcess:
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target=[IO.Path]::GetFullPath('$R0'); $$matches=Get-Process -Name '${APP_EXECUTABLE_FILENAME}' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and [IO.Path]::GetFullPath($$_.Path) -ieq $$target }; if ($$matches) { exit 0 }; exit 1"`
  Pop $R1
  Pop $R2
  ${if} $R1 != 0
    Goto ucliNotRunning
  ${endIf}

  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK stopUcliProcess
  Quit

  stopUcliProcess:
  DetailPrint `Closing running "${PRODUCT_NAME}" from "$R0"...`
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target=[IO.Path]::GetFullPath('$R0'); Get-Process -Name '${APP_EXECUTABLE_FILENAME}' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and [IO.Path]::GetFullPath($$_.Path) -ieq $$target } | Stop-Process -Force -ErrorAction Stop"`
  Sleep 1000

  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target=[IO.Path]::GetFullPath('$R0'); $$matches=Get-Process -Name '${APP_EXECUTABLE_FILENAME}' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and [IO.Path]::GetFullPath($$_.Path) -ieq $$target }; if ($$matches) { exit 0 }; exit 1"`
  Pop $R1
  Pop $R2
  ${if} $R1 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY checkUcliProcess
    Quit
  ${endIf}

  ucliNotRunning:
!macroend
