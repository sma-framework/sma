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

  ENCODING - DO NOT SAVE THIS FILE WITHOUT A BOM. It carries non-ASCII characters (the
  em dashes in these comments and in the log lines below). Windows PowerShell 5.1 - the
  shell that ships with Windows, and the one the Scheduled Task invokes - reads a file
  with no byte-order mark as ANSI, and an em dash then decodes into a character that
  PowerShell accepts as a STRING DELIMITER. What follows is not a mangled comment: the
  first log line closes its string early, the brace balance collapses, and the whole
  script fails to parse with "Missing closing brace" pointing at a block that is
  perfectly balanced. Nothing runs, and no log is written to say so. A test in the suite
  holds every shipped .ps1 to "pure ASCII, or a BOM", so this cannot come back quietly.
#>
[CmdletBinding()]
param(
  # Absolute path of the SMA product clone. Left EMPTY here on purpose and resolved in the
  # body — see the note under the param block; a default that computes a path is exactly what
  # made this script unable to start.
  [string]$SmaHome = '',
  # The embedded-postgres sandbox that owns the local queue Postgres on :5433.
  [string]$PgSandbox = (Join-Path $HOME 'pg-sandbox'),
  [int]$QueuePort = 5433,
  [string]$QueueDb = 'sma_queue',
  # The port the daemon's window answers on. Used ONLY to notice that a daemon is already
  # running — this script never binds it.
  [int]$FrontPort = 7777
)

$ErrorActionPreference = 'Stop'

# READ THE CHILD'S OUTPUT AS UTF-8. Node prints UTF-8; PowerShell decodes a native command's
# output using the CONSOLE code page, which on this machine is an OEM one, so every Russian
# sentence the daemon says arrived as «ð║ð¥ð¢ð▓ðÁð╣ðÁÐÇ» — mangled on the way IN, before any
# redirection could preserve it. Set once, at the top, so every child below is read correctly.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# WHERE AM I? Resolved HERE, in the body, and not in the param block above.
#
# Measured on Windows PowerShell 5.1, the shell that ships with Windows and the one every
# caller of this script uses: inside a param() default, `$MyInvocation.MyCommand.Path` is
# $null and `$PSScriptRoot` is an empty string when the script is started with -File — which
# is how the Scheduled Task, the logon shortcut and the documented manual command ALL start
# it. The run then dies on its very first line («Cannot bind argument to parameter 'Path'»)
# before the log file exists, so it fails with nothing to show for it. In the body both are
# populated. This script lives in <SmaHome>\supervisor, so the clone is that directory's parent.
if (-not $SmaHome) { $SmaHome = Split-Path -Parent $PSScriptRoot }
if (-not $SmaHome) { throw 'start-daemon-windows.ps1: could not work out SmaHome — pass -SmaHome explicitly' }

$logDir = Join-Path $HOME '.sma-daemon\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("daemon-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Write-Log([string]$msg) {
  $line = "{0} {1}" -f (Get-Date -Format 's'), $msg
  # FAIL-SOFT ON PURPOSE. A running daemon holds this very file open for its own output, so a
  # SECOND run of this script — the logon shortcut firing while the machine is already
  # serving, which is the normal case — cannot append to it. With $ErrorActionPreference =
  # 'Stop' that write is fatal, and the script dies before it can even report that it had
  # nothing to do. Saying something is the job; saying it in the file is a preference.
  try { Add-Content -Path $logFile -Value $line -ErrorAction Stop } catch { }
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

# (a0) IS ONE ALREADY RUNNING? Two triggers can point at this script — the nightly one and
#      the at-logon one — and a machine that is already serving must not get a second daemon
#      fighting for the same port and the same queue. An OPEN FRONT PORT is the fact; a lock
#      file would be a claim that outlives the process that made it.
if (Test-Port $FrontPort) {
  Write-Log "the window already answers on :$FrontPort — a daemon is running, so this start is a no-op"
  exit 0
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
#     and the queue never touches the production database.
$daemonDir = Join-Path $SmaHome 'daemon'
$ensureDb = @"
import pg from 'pg'
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@localhost:$QueuePort/postgres' })
await c.connect()
try { await c.query('CREATE DATABASE $QueueDb'); console.log('created $QueueDb') }
catch (e) { if (e.code === '42P04') console.log('$QueueDb already exists'); else { console.error(String(e.message||e)); process.exit(1) } }
await c.end()
"@
# The temp module lives INSIDE the daemon directory, not in %TEMP%. Node resolves an ESM
# `import pg from 'pg'` relative to the FILE, never to the working directory, so a script
# sitting in %TEMP% could never find the driver no matter where it was launched from — this
# step failed with ERR_MODULE_NOT_FOUND on every run and was tolerated only because the
# database it ensures already existed. Named with a leading dot and removed in the finally.
$ensureFile = Join-Path $daemonDir '.sma-ensure-queue-db.mjs'
Set-Content -Path $ensureFile -Value $ensureDb -Encoding UTF8
Write-Log "ensuring database $QueueDb on :$QueuePort"
Push-Location $daemonDir
try {
  # A NATIVE COMMAND'S OUTPUT MUST NOT BE GOVERNED BY 'Stop'. In Windows PowerShell 5.1 a
  # redirected native stderr line arrives as an ErrorRecord, and $ErrorActionPreference =
  # 'Stop' turns that into a terminating error — even when the program exits 0. Measured
  # exactly here: the script logged «ensuring database …» and then died without another word,
  # so the daemon never launched and nothing said why.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $ensureOut = & node $ensureFile 2>&1
  $ensureCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  foreach ($l in $ensureOut) { Write-Log "ensure-db: $l" }
  if ($ensureCode -ne 0) { Write-Log "ensure-db: exited $ensureCode — continuing; the daemon reports a bad queue itself" }
} finally { Pop-Location; Remove-Item -Force $ensureFile -ErrorAction SilentlyContinue }

# (c) Launch the daemon composition root. main.mjs wires config -> event-wrapped
#     pg-boss adapter -> stateless tick + roster front. stdout/stderr append to the
#     rotating daily log. The config (queueUrl -> :$QueuePort/$QueueDb, front token)
#     is read from ~/.sma-daemon/config.json by loadConfig; nothing secret is printed.
$mainMjs = Join-Path $daemonDir 'src\main.mjs'
Write-Log "launching daemon: node $mainMjs"
# Same rule as the ensure step above, and it matters more here: the daemon writes to stderr in
# the ordinary course of a night. Under 'Stop' the first such line would kill this wrapper —
# and with it the daemon it is holding.
$ErrorActionPreference = 'Continue'
# NOT `*>> $logFile`. Windows PowerShell 5.1's append redirection writes UTF-16 into a file
# the rest of this script has been writing as UTF-8, so the daemon's own lines came out as
# «[ S m a D a e m o n ]» and every Cyrillic sentence it prints — which is most of what it
# says to an operator — became unreadable. Measured on a cold start. Merging the streams and
# appending through Add-Content with an explicit encoding keeps ONE readable file.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
& node $mainMjs *>&1 | ForEach-Object {
  # One SHORT-LIVED handle per line. Add-Content or Out-File would hold the file open for the
  # daemon's whole life, and then nobody — not the founder, not a support command — could so
  # much as read the log while the thing they are debugging is running. Measured: `Get-Content`
  # answered «being used by another process» for as long as the daemon lived.
  [System.IO.File]::AppendAllText($logFile, ($_ | Out-String), $utf8NoBom)
}
