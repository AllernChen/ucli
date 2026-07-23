[CmdletBinding()]
param(
  [string]$DatabasePath = (Join-Path $env:APPDATA 'ucli\ucli.db'),
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $reportDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutputPath = Join-Path $reportDirectory "ucli-db-diagnosis-$timestamp.txt"
}

$report = New-Object 'System.Collections.Generic.List[string]'
$exitCode = 0

function Add-ReportLine {
  param([string]$Text)
  $script:report.Add($Text)
  Write-Host $Text
}

function Convert-ToHex {
  param(
    [byte[]]$Bytes,
    [int]$Count
  )
  if ($Count -le 0) { return '' }
  return (($Bytes[0..($Count - 1)] | ForEach-Object { $_.ToString('X2') }) -join '')
}

Add-ReportLine 'UCLI database diagnostic report'
Add-ReportLine ('GeneratedAt=' + (Get-Date).ToString('o'))
Add-ReportLine ('ComputerName=' + $env:COMPUTERNAME)
Add-ReportLine ('DatabasePath=' + $DatabasePath)

try {
  $ucliProcesses = @(Get-Process -Name 'UCLI' -ErrorAction SilentlyContinue)
  Add-ReportLine ('UCLIProcessCount=' + $ucliProcesses.Count)
  if ($ucliProcesses.Count -gt 0) {
    Add-ReportLine 'ProcessWarning=UCLI is running; exit it from the tray before any recovery operation.'
  }

  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    Add-ReportLine 'Result=database file is missing'
    $exitCode = 2
  } else {
    $item = Get-Item -LiteralPath $DatabasePath
    Add-ReportLine ('Size=' + $item.Length)
    Add-ReportLine ('CreatedAt=' + $item.CreationTime.ToString('o'))
    Add-ReportLine ('LastWriteAt=' + $item.LastWriteTime.ToString('o'))

    $buffer = New-Object byte[] 100
    $stream = [System.IO.File]::Open(
      $DatabasePath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    try {
      $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
    } finally {
      $stream.Dispose()
    }

    $headerLength = [Math]::Min(16, $bytesRead)
    $headerText = [Text.Encoding]::ASCII.GetString($buffer, 0, $headerLength)
    $headerHex = Convert-ToHex -Bytes $buffer -Count $headerLength
    $expectedHeader = 'SQLite format 3' + [char]0
    $headerValid = $bytesRead -ge 16 -and $headerText -eq $expectedHeader

    Add-ReportLine ('HeaderText=' + $headerText.Replace([string][char]0, '<NUL>'))
    Add-ReportLine ('HeaderHex=' + $headerHex)
    Add-ReportLine ('HeaderValid=' + $headerValid)

    if ($headerValid -and $bytesRead -ge 32) {
      $pageSize = (([int]$buffer[16]) -shl 8) -bor [int]$buffer[17]
      if ($pageSize -eq 1) { $pageSize = 65536 }
      $declaredPageCount =
        (([uint32]$buffer[28]) -shl 24) -bor
        (([uint32]$buffer[29]) -shl 16) -bor
        (([uint32]$buffer[30]) -shl 8) -bor
        ([uint32]$buffer[31])
      $declaredSize = [int64]$declaredPageCount * [int64]$pageSize
      $sizeAligned = $pageSize -gt 0 -and ($item.Length % $pageSize) -eq 0
      $declaredSizeMatches = $declaredPageCount -eq 0 -or $declaredSize -eq $item.Length

      Add-ReportLine ('PageSize=' + $pageSize)
      Add-ReportLine ('DeclaredPageCount=' + $declaredPageCount)
      Add-ReportLine ('DeclaredSize=' + $declaredSize)
      Add-ReportLine ('SizeAlignedToPage=' + $sizeAligned)
      Add-ReportLine ('DeclaredSizeMatches=' + $declaredSizeMatches)

      if (-not $sizeAligned -or -not $declaredSizeMatches) {
        Add-ReportLine 'GeometryWarning=database length is inconsistent with its SQLite header.'
        $exitCode = 3
      }
    } elseif (-not $headerValid) {
      Add-ReportLine 'HeaderWarning=file is not a valid SQLite 3 database.'
      $exitCode = 3
    }

    try {
      $hash = Get-FileHash -LiteralPath $DatabasePath -Algorithm SHA256
      Add-ReportLine ('SHA256=' + $hash.Hash)
    } catch {
      Add-ReportLine ('SHA256Error=' + $_.Exception.Message)
    }

    $sqlite = Get-Command 'sqlite3.exe' -ErrorAction SilentlyContinue
    if ($null -ne $sqlite) {
      try {
        $quickCheck = @(& $sqlite.Source -readonly $DatabasePath 'PRAGMA quick_check;' 2>&1)
        Add-ReportLine ('SQLiteQuickCheck=' + ($quickCheck -join ' | '))
        if ($quickCheck.Count -ne 1 -or [string]$quickCheck[0] -ne 'ok') {
          $exitCode = 3
        }
      } catch {
        Add-ReportLine ('SQLiteQuickCheckError=' + $_.Exception.Message)
        $exitCode = 3
      }
    } else {
      Add-ReportLine 'SQLiteQuickCheck=skipped (sqlite3.exe is not installed)'
    }

    if ($exitCode -eq 0) {
      Add-ReportLine 'Result=basic file checks passed'
      Add-ReportLine 'Note=without sqlite3.exe, this does not prove that every internal database page is healthy.'
    } else {
      Add-ReportLine 'Result=database file is invalid or suspicious'
    }
  }
} catch {
  Add-ReportLine ('DiagnosticError=' + $_.Exception.Message)
  Add-ReportLine 'Result=diagnostic script failed'
  $exitCode = 4
} finally {
  Write-Host ''
  try {
    $report | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    Write-Host ('Report saved to: ' + $OutputPath)
  } catch {
    Write-Warning ('Could not save the report file: ' + $_.Exception.Message)
    Write-Host 'Copy the diagnostic output directly from this window.'
    if ($exitCode -eq 0) { $exitCode = 5 }
  }
  Write-Host 'This script did not modify, rename, delete, or upload the UCLI database.'
}

exit $exitCode
