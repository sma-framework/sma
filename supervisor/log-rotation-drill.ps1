<#
  log-rotation-drill.ps1 - drive the daemon log writer across a midnight and say, in one
  JSON line, whether the rotation actually happened.

  WHAT IT IS FOR. "The date is resolved per line" is a claim about a wrapper that lives for
  days, and reading the source is not evidence: the only honest proof is a RUN that crosses
  a day boundary. Waiting for a real midnight is one way and costs a night. This is the
  other: it moves the clock the writer reads (SMA_LOG_CLOCK_FILE, honoured by
  daemon-log-day.ps1) from just before midnight to just after, halfway through a stream of
  lines, and then checks the two files it produced.

  IT DRIVES THE SHIPPING CODE. The lines flow out of a REAL child process, through a
  ForEach-Object pipeline, into Write-SmaDaemonLogLine - the same function, in the same
  shape, that start-daemon-windows.ps1 pipes the daemon's own output through. Nothing about
  the writer is re-implemented here; if the wrapper's rotation breaks, this drill goes red.

  WHAT IT PROVES, and what a green run means:
    - a file for the NEW day was created, distinct from the old day's file;
    - every line emitted before the flip is in the old day's file, every line after it in
      the new day's - each line in its own day;
    - no line was lost and no line was written twice on the transition.

  Usage (LogDir defaults to a fresh temp directory, whose path is printed in the verdict):
    powershell -NoProfile -ExecutionPolicy Bypass -File supervisor/log-rotation-drill.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File supervisor/log-rotation-drill.ps1 -LogDir C:\path\to\dir -Lines 8

  Exit code 0 when the verdict is ok, 1 otherwise. The JSON verdict is the last line of
  stdout, prefixed with DRILL, so a test or a human reads the same thing.

  ENCODING - pure ASCII on purpose; see the note in daemon-log-day.ps1.
#>
[CmdletBinding()]
param(
  # Where the two daily log files land. A fresh temp directory by default, so a drill never
  # writes into the real ~/.sma-daemon/logs and never disturbs a running daemon.
  [string]$LogDir = '',
  # The two sides of the boundary. Any timestamp the invariant culture can parse.
  [string]$Before = '2026-08-27T23:59:58',
  [string]$After = '2026-08-28T00:00:03',
  # How many lines the child process emits. The clock moves at the halfway line.
  [int]$Lines = 6
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

. (Join-Path $PSScriptRoot 'daemon-log-day.ps1')

if (-not $LogDir) {
  $LogDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sma-log-rotation-drill-" + [guid]::NewGuid().ToString('N'))
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($Lines -lt 2) { throw 'log-rotation-drill.ps1: -Lines must be at least 2, or there is no boundary to cross' }
$flipAt = [int][math]::Ceiling($Lines / 2) + 1   # the first line that belongs to the NEW day

$clockFile = Join-Path $LogDir 'drill-clock.txt'
$producer = Join-Path $LogDir 'drill-producer.mjs'
$prevClock = $env:SMA_LOG_CLOCK_FILE

# The child process is deliberately dumb: it knows nothing about days or files. Everything the
# drill is testing happens on the consuming side, which is where the wrapper's logic lives.
$producerBody = @"
const total = Number(process.argv[2] || 6)
for (let i = 1; i <= total; i += 1) console.log('drill line ' + i + ' of ' + total)
"@
Set-Content -Path $producer -Value $producerBody -Encoding ASCII
Set-Content -Path $clockFile -Value $Before -Encoding ASCII
$env:SMA_LOG_CLOCK_FILE = $clockFile

$beforeDay = Get-SmaDaemonLogDay
$script:seen = 0
$script:written = @()

try {
  # The same pipeline shape as start-daemon-windows.ps1: a native command, merged streams,
  # one Write-SmaDaemonLogLine per line.
  & node $producer $Lines *>&1 | ForEach-Object {
    $script:seen += 1
    # MIDNIGHT, MID-STREAM. The clock file is re-read by the writer on every line, so moving
    # it here is exactly the situation a real midnight creates for a long-lived wrapper.
    if ($script:seen -eq $flipAt) { Set-Content -Path $clockFile -Value $After -Encoding ASCII }
    $script:written += (Write-SmaDaemonLogLine -LogDir $LogDir -Text ($_ | Out-String))
  }
  $afterDay = Get-SmaDaemonLogDay
} finally {
  $env:SMA_LOG_CLOCK_FILE = $prevClock
  Remove-Item -Force $producer -ErrorAction SilentlyContinue
  Remove-Item -Force $clockFile -ErrorAction SilentlyContinue
}

$beforeFile = Join-Path $LogDir ("daemon-{0}.log" -f $beforeDay)
$afterFile = Join-Path $LogDir ("daemon-{0}.log" -f $afterDay)

function Read-Lines([string]$path) {
  if (-not (Test-Path $path)) { return @() }
  return @(Get-Content -Path $path -Encoding UTF8 | Where-Object { $_.Trim() -ne '' })
}

$beforeLines = Read-Lines $beforeFile
$afterLines = Read-Lines $afterFile
$all = @($beforeLines) + @($afterLines)

$expectedBefore = @(1..($flipAt - 1) | ForEach-Object { "drill line $_ of $Lines" })
$expectedAfter = @($flipAt..$Lines | ForEach-Object { "drill line $_ of $Lines" })

# Lost: emitted by the child, absent from BOTH files. Misfiled: present, but in the wrong day.
# Duplicated: written more than once anywhere - the failure a naive "reopen on change" would
# hide behind a line that merely looks present.
$lost = @()
$misfiled = @()
$duplicated = @()
foreach ($line in @($expectedBefore) + @($expectedAfter)) {
  $inBefore = @($beforeLines | Where-Object { $_ -eq $line }).Count
  $inAfter = @($afterLines | Where-Object { $_ -eq $line }).Count
  if (($inBefore + $inAfter) -eq 0) { $lost += $line; continue }
  if (($inBefore + $inAfter) -gt 1) { $duplicated += $line }
  $wantsBefore = $expectedBefore -contains $line
  if ($wantsBefore -and $inBefore -ne 1) { $misfiled += $line }
  if ((-not $wantsBefore) -and $inAfter -ne 1) { $misfiled += $line }
}

$verdict = [ordered]@{
  ok = $false
  logDir = $LogDir
  beforeFile = $beforeFile
  afterFile = $afterFile
  beforeDay = $beforeDay
  afterDay = $afterDay
  flipAt = $flipAt
  emitted = $script:seen
  rotated = ($beforeDay -ne $afterDay -and $beforeFile -ne $afterFile)
  newDayFileCreated = (Test-Path $afterFile)
  oldDayCount = @($beforeLines).Count
  newDayCount = @($afterLines).Count
  totalWritten = @($all).Count
  lost = @($lost)
  misfiled = @($misfiled)
  duplicated = @($duplicated)
}
$verdict.ok = (
  $verdict.rotated -and
  $verdict.newDayFileCreated -and
  (Test-Path $beforeFile) -and
  $script:seen -eq $Lines -and
  @($lost).Count -eq 0 -and
  @($misfiled).Count -eq 0 -and
  @($duplicated).Count -eq 0 -and
  @($all).Count -eq $Lines
)

Write-Host ("old day: {0}" -f $beforeFile)
Write-Host ("new day: {0}" -f $afterFile)
Write-Host ("DRILL " + ($verdict | ConvertTo-Json -Compress))
if ($verdict.ok) { exit 0 } else { exit 1 }
