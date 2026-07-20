<#
  start-daemon-windows.ps1 — the no-admin start wrapper the Task Scheduler task
  targets. The Windows sibling of what launchd invokes on the Mac mini: it brings up
  the local queue Postgres, ensures the dedicated queue database exists, and launches
  the daemon composition root (daemon/src/main.mjs) with rotating logs.

  Runs entirely under the interactive user — no admin, no service account, no docker.

  What it does NOT do: it never prints the config file (the front token lives there);
  anything it needs to say about config goes through the daemon's secretsView posture,
  so nothing secret is ever echoed. It never talks to origin — this daemon holds no
  path to the push verb; approved work travels back by the founder pulling this host
  as a git remote, exactly as the loop's founder-push law requires.

  Usage (the task supplies -SmaHome; run standalone for a manual boot):
    powershell -NoProfile -ExecutionPolicy Bypass -File start-daemon-windows.ps1 -SmaHome C:\path\to\sma
#>
[CmdletBinding()]
param(
  # Absolute path of the SMA product clone. Defaults to this script's parent's parent.
  [string]$SmaHome = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  # The embedded-postgres sandbox that owns the local queue Postgres on :5433.
  [string]$PgSandbox = (Join-Path $HOME 'pg-sandbox'),
  [int]$QueuePort = 5433,
  [string]$QueueDb = 'sma_queue'
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $HOME '.sma-daemon\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("daemon-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Write-Log([string]$msg) {
  $line = "{0} {1}" -f (Get-Date -Format 's'), $msg
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

# (a) Bring up the local queue Postgres on :5433 if the port is closed. start.mjs
#     daemonizes PG18 and tolerates an already-running instance (embedded-postgres).
function Test-Port([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port); $c.Close(); return $true
  } catch { return $false }
}

if (-not (Test-Port $QueuePort)) {
  Write-Log "queue Postgres :$QueuePort closed — starting the sandbox at $PgSandbox"
  Push-Location $PgSandbox
  try {
    # start.mjs daemonizes and returns; run it detached so the wrapper continues.
    Start-Process -FilePath 'node' -ArgumentList 'start.mjs' -WorkingDirectory $PgSandbox -WindowStyle Hidden
  } finally { Pop-Location }
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Port $QueuePort) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (-not (Test-Port $QueuePort)) { Write-Log "FATAL: queue Postgres never came up on :$QueuePort"; exit 1 }
}
Write-Log "queue Postgres reachable on :$QueuePort"

# (b) Ensure the dedicated queue database exists. Connect to the sandbox's `postgres`
#     DB and CREATE DATABASE sma_queue, tolerating 42P04 (duplicate_database). The
#     ONLY statement ever run against `postgres` is this CREATE DATABASE — pg-boss owns
#     its schema INSIDE sma_queue only; no queue table is ever created in `postgres`,
#     and the queue never touches the Railway/production database.
$daemonDir = Join-Path $SmaHome 'daemon'
$ensureDb = @"
import pg from 'pg'
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@localhost:$QueuePort/postgres' })
await c.connect()
try { await c.query('CREATE DATABASE $QueueDb'); console.log('created $QueueDb') }
catch (e) { if (e.code === '42P04') console.log('$QueueDb already exists'); else { console.error(String(e.message||e)); process.exit(1) } }
await c.end()
"@
$ensureFile = Join-Path $env:TEMP 'sma-ensure-queue-db.mjs'
Set-Content -Path $ensureFile -Value $ensureDb -Encoding UTF8
Write-Log "ensuring database $QueueDb on :$QueuePort"
Push-Location $daemonDir
try { & node $ensureFile 2>&1 | ForEach-Object { Write-Log "ensure-db: $_" } }
finally { Pop-Location; Remove-Item -Force $ensureFile -ErrorAction SilentlyContinue }

# (c) Launch the daemon composition root. main.mjs wires config -> event-wrapped
#     pg-boss adapter -> stateless tick + roster front. stdout/stderr append to the
#     rotating daily log. The config (queueUrl -> :$QueuePort/$QueueDb, front token)
#     is read from ~/.sma-daemon/config.json by loadConfig; nothing secret is printed.
$mainMjs = Join-Path $daemonDir 'src\main.mjs'
Write-Log "launching daemon: node $mainMjs"
& node $mainMjs *>> $logFile
