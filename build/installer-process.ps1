[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Find', 'Stop')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [switch]$Legacy
)

$targetFullPath = [IO.Path]::GetFullPath($TargetPath)
$processFileName = [IO.Path]::GetFileName($targetFullPath)
$escapedProcessFileName = $processFileName.Replace("'", "''")

function Get-UcliInstallerProcess {
  $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$escapedProcessFileName'" -ErrorAction SilentlyContinue)
  if ($Legacy) { return $processes }

  return @($processes | Where-Object {
    try {
      $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $targetFullPath
    } catch {
      $false
    }
  })
}

$matches = @(Get-UcliInstallerProcess)
if ($Action -eq 'Find') {
  if ($matches.Count -gt 0) { exit 0 }
  exit 1
}

$stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
$emptySince = $null

# Electron can replace a child process while the original process set is stopping.
# Require a stable empty window before the legacy uninstaller can remove files.
while ([DateTime]::UtcNow -lt $stopDeadline) {
  $matches = @(Get-UcliInstallerProcess)
  if ($matches.Count -eq 0) {
    if ($null -eq $emptySince) {
      $emptySince = [DateTime]::UtcNow
    } elseif (([DateTime]::UtcNow - $emptySince).TotalMilliseconds -ge 1000) {
      exit 0
    }
  } else {
    $emptySince = $null
    foreach ($process in $matches) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

  Start-Sleep -Milliseconds 100
}

exit 2
