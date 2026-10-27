param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Remote,

  [string]$LocalishHost = '127.0.0.1',
  [int]$LocalishPort = 8080
)

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
Write-Host "Starting SSH session to $Remote; keep localish running on port $LocalishPort."

& ssh -t -o ExitOnForwardFailure=yes -R $remoteForward $Remote $remoteCommand
exit $LASTEXITCODE
