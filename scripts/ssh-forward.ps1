param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Remote,

  [string]$LocalishHost = '127.0.0.1',
  [int]$LocalishPort = 8080
)

if (-not $PSBoundParameters.ContainsKey('LocalishHost') -and $env:LOCALISH_HOST) {
  $LocalishHost = $env:LOCALISH_HOST
}
if (-not $PSBoundParameters.ContainsKey('LocalishPort') -and $env:LOCALISH_PORT) {
  $LocalishPort = [int]$env:LOCALISH_PORT
}
if ($LocalishPort -lt 1 -or $LocalishPort -gt 65535) {
  throw 'LocalishPort must be between 1 and 65535.'
}

function Test-LocalishHealth {
  param([Parameter(Mandatory = $true)][string]$Uri)

  try {
    $response = Invoke-WebRequest -Uri $Uri -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -ne 200) { return $false }
    $health = $response.Content | ConvertFrom-Json -ErrorAction Stop
    return ($health.service -eq 'localish' -and $health.status -eq 'ok')
  } catch {
    return $false
  }
}

$healthHost = $LocalishHost
if ($healthHost -in @('0.0.0.0', '::', '[::]')) { $healthHost = '127.0.0.1' }
if ($healthHost.Contains(':') -and -not $healthHost.StartsWith('[')) { $healthHost = "[$healthHost]" }
$healthUri = "http://${healthHost}:${LocalishPort}/healthz"

if (Test-LocalishHealth -Uri $healthUri) {
  Write-Host "localish is already running at $healthUri"
} else {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $localishCli = Join-Path $repoRoot 'apps/localish/src/cli.js'
  if (-not (Test-Path -LiteralPath $localishCli -PathType Leaf)) {
    throw "Could not find the localish entry point at $localishCli. Run this helper from the repository checkout."
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $nodeCommand) { throw 'Node.js was not found on PATH; install Node.js 20.19 or later.' }
  $nodeExecutable = $nodeCommand.Source
  if (-not $nodeExecutable) { $nodeExecutable = $nodeCommand.Path }
  if (-not $nodeExecutable) { throw 'Could not determine the Node.js executable path.' }

  if ($env:LOCALAPPDATA) { $logDirectory = Join-Path $env:LOCALAPPDATA 'localish' }
  elseif ($env:TEMP) { $logDirectory = Join-Path $env:TEMP 'localish' }
  else { $logDirectory = Join-Path $repoRoot '.localish-logs' }
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $logSuffix = [guid]::NewGuid().ToString('N')
  $stdoutLog = Join-Path $logDirectory "localish-$logSuffix.out.log"
  $stderrLog = Join-Path $logDirectory "localish-$logSuffix.err.log"

  Write-Host "localish is not running; starting it in the background on port $LocalishPort..."
  $originalLocalishHost = [Environment]::GetEnvironmentVariable('LOCALISH_HOST', 'Process')
  $originalLocalishPort = [Environment]::GetEnvironmentVariable('LOCALISH_PORT', 'Process')
  try {
    $env:LOCALISH_HOST = $LocalishHost
    $env:LOCALISH_PORT = [string]$LocalishPort
    $nodeArguments = '"' + $localishCli + '"'
    $localishProcess = Start-Process -FilePath $nodeExecutable -ArgumentList $nodeArguments `
      -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -ErrorAction Stop
  } catch {
    throw "Could not start localish in the background: $($_.Exception.Message)"
  } finally {
    if ($null -eq $originalLocalishHost) { Remove-Item Env:LOCALISH_HOST -ErrorAction SilentlyContinue }
    else { $env:LOCALISH_HOST = $originalLocalishHost }
    if ($null -eq $originalLocalishPort) { Remove-Item Env:LOCALISH_PORT -ErrorAction SilentlyContinue }
    else { $env:LOCALISH_PORT = $originalLocalishPort }
  }

  $startupDeadline = [DateTime]::UtcNow.AddSeconds(30)
  $localishReady = $false
  while ([DateTime]::UtcNow -lt $startupDeadline) {
    if (Test-LocalishHealth -Uri $healthUri) {
      $localishReady = $true
      break
    }
    if ($localishProcess.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $localishReady) {
    $stderrTail = ''
    if (Test-Path -LiteralPath $stderrLog) {
      $stderrTail = (Get-Content -LiteralPath $stderrLog -Tail 20 -ErrorAction SilentlyContinue | Out-String).Trim()
    }
    throw "localish did not become healthy at $healthUri. Logs: $stdoutLog and $stderrLog. $stderrTail"
  }
  Write-Host "localish started in the background (PID $($localishProcess.Id)). Logs: $logDirectory"
}

$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$suffix = [guid]::NewGuid().ToString('N')
$safeUser = $env:USERNAME -replace '[^A-Za-z0-9_.-]', '_'
$safeHost = $env:COMPUTERNAME -replace '[^A-Za-z0-9_.-]', '_'
if ([string]::IsNullOrWhiteSpace($safeUser)) { $safeUser = 'user' }
if ([string]::IsNullOrWhiteSpace($safeHost)) { $safeHost = 'desktop' }
$safeUser = $safeUser.Substring(0, [Math]::Min(16, $safeUser.Length))
$safeHost = $safeHost.Substring(0, [Math]::Min(16, $safeHost.Length))
$remoteSocket = "/tmp/fwd_${safeUser}_${safeHost}_${timestamp}_${suffix}.sock"
$remoteForward = "${remoteSocket}:${LocalishHost}:${LocalishPort}"
$remoteCommand = 'export LOCALISH_REMOTE_SOCKET="{0}"; exec "$SHELL" -l' -f $remoteSocket

Write-Host "Forwarding remote socket: $remoteSocket"
Write-Host "Command: $remoteCommand"
Write-Host "Starting SSH session to $Remote; keep localish running on port $LocalishPort."

& ssh -t -o ExitOnForwardFailure=yes -l bench -R $remoteForward $Remote $remoteCommand
exit $LASTEXITCODE
