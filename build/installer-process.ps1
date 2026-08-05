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
$processName = [IO.Path]::GetFileNameWithoutExtension($targetFullPath)

function Get-UcliInstallerProcess {
  $processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
  if ($Legacy) { return $processes }

  return @($processes | Where-Object {
    try {
      $_.Path -and [IO.Path]::GetFullPath($_.Path) -ieq $targetFullPath
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

foreach ($process in $matches) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 300
if (@(Get-UcliInstallerProcess).Count -eq 0) { exit 0 }
exit 2
