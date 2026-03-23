param(
  [switch]$CleanupOnly
)

$ErrorActionPreference = 'Stop'

function Stop-NodeOnPorts {
  param(
    [int[]]$Ports
  )

  foreach ($port in $Ports) {
    $connections = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if (-not $connections) {
      continue
    }

    $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $pids) {
      try {
        $process = Get-Process -Id $processId -ErrorAction Stop
        Write-Host "Stopping process $($process.ProcessName) (PID $processId) on port $port"
        Stop-Process -Id $processId -Force -ErrorAction Stop
      }
      catch {
        Write-Host "Skipping PID $processId on port ${port}: $($_.Exception.Message)"
      }
    }
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

Write-Host 'Cleaning stale local server state for e2e runs...'
Stop-NodeOnPorts -Ports @(3000, 3100, 3200)

if ($CleanupOnly) {
  Write-Host 'Cleanup complete.'
  exit 0
}

Push-Location $repoRoot
try {
  Write-Host 'Running e2e suite...'
  & npm.cmd run test:e2e -- --workers=1
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
