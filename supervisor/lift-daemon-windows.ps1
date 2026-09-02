<#
  lift-daemon-windows.ps1 - THE ONE HOP BETWEEN NODE AND THE START WRAPPER ON WINDOWS.

  Why this file exists at all. The lift used to be a single hop: node spawned
  `powershell -File start-daemon-windows.ps1` with `detached: true`, so the command that
  asked for the lift could exit while the daemon went on living. On Windows that flag is
  not a hint - libuv turns it into DETACHED_PROCESS, which tells the kernel the child must
  get NO console. Windows PowerShell 5.1 cannot start without one: measured on this machine
  02.09.2026, the process is created, exits 0 within milliseconds, runs not one line of the
  script (a marker file the script writes on its first line never appeared) and prints
  nothing anywhere. Exit code 0 with an empty log is the worst shape a failure can take -
  it looks like a success to everything upstream. The same spawn without the flag runs the
  script and captures every line.

  So the detachment is bought differently here: this launcher is started ATTACHED and is
  short-lived, and the daemon it starts is detached by Start-Process, which gives the real
  wrapper its own hidden console and its own redirected streams. Windows does not kill a
  child when its parent exits, so the daemon outlives this launcher by the same amount it
  used to outlive the node process.

  What it guarantees to the caller, and why each part is here:
    - the pid of the process it started, printed on stdout, so the daily lift log names a
      process a human can look for;
    - the first lines of that process's own output, echoed back onto stdout, so the lift log
      holds the BEGINNING OF THE BOOT and not just the intention to boot;
    - the path of the raw capture files, so the rest of a long boot can be read in full;
    - a line when the wrapper exits early, because an exit two seconds after a lift is the
      single most useful fact about a lift that did not work.

  Everything this prints on stdout/stderr is inherited from node and lands in
  `daemon-lift-<day>.log` - see supervisor/lift-log.mjs, which owns that file.

  ENCODING - this file is deliberately PURE ASCII, no byte-order mark. Windows PowerShell
  5.1 reads a BOM-less file as ANSI, and a non-ASCII dash in a comment can decode into a
  character it accepts as a string delimiter, which breaks the parse of a perfectly balanced
  script. A test in the suite holds every shipped .ps1 to "pure ASCII, or a BOM"; staying
  inside ASCII keeps this one safe under either reading.
#>
[CmdletBinding()]
param(
  # Absolute path of the SMA product clone. Resolved in the body, never in a param default:
  # under -File, $PSScriptRoot is empty inside the param block on PowerShell 5.1.
  [string]$SmaHome = '',
  # Where the raw capture files go. Same folder as every other daemon log.
  [string]$LogDir = '',
  # How much of the boot to echo back into the lift log, and for how long to watch for it.
  # The wrapper can legitimately spend a minute and a half waiting for the queue, so this is
  # a WINDOW ONTO the boot, not a wait for it to finish: the launcher must not outlive its
  # usefulness to the caller.
  [int]$FirstLines = 24,
  [int]$WatchSeconds = 25
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

if (-not $SmaHome) { $SmaHome = Split-Path -Parent $PSScriptRoot }
if (-not $SmaHome) { Write-Error 'lift-daemon-windows.ps1: could not work out SmaHome - pass -SmaHome explicitly'; exit 1 }
if (-not $LogDir) { $LogDir = Join-Path $HOME '.sma-daemon\logs' }

$target = Join-Path $PSScriptRoot 'start-daemon-windows.ps1'
if (-not (Test-Path $target)) { Write-Error "lift-daemon-windows.ps1: the start wrapper is missing at $target"; exit 1 }

try { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null } catch { }

# ONE PAIR OF CAPTURE FILES PER LIFT, stamped to the second. Start-Process TRUNCATES what it
# redirects into and demands two distinct files, so it can neither share the daily lift log
# nor be pointed at a file the previous daemon may still be holding open.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $LogDir "daemon-lift-$stamp.out.log"
$errFile = Join-Path $LogDir "daemon-lift-$stamp.err.log"

$psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $target, '-SmaHome', $SmaHome)
try {
  $proc = Start-Process -FilePath 'powershell' -ArgumentList $psArgs -WindowStyle Hidden `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
} catch {
  Write-Error ("lift-daemon-windows.ps1: could not start the wrapper: " + $_.Exception.Message)
  exit 1
}

# TOUCH THE HANDLE, OR THE EXIT CODE IS LOST. Reading .Handle once caches it in this process;
# without that, .ExitCode on the object Start-Process handed back comes out EMPTY after the
# child is gone (measured on the first live run of this launcher: «already exited, code »).
# An exit code that only shows up sometimes is worse than none - it teaches a reader to skim.
try { $null = $proc.Handle } catch { }

Write-Output ("lift started: pid {0}, wrapper {1}" -f $proc.Id, $target)
Write-Output ("raw boot output: {0} (stderr: {1})" -f $outFile, $errFile)

# Echo what the boot says, as it says it. Reading a file another process is writing can fail
# for a moment (sharing, a half-written line); that is never a reason to fail a lift, so
# every read here is fail-soft and simply tried again on the next pass.
#
# ALWAYS WRAP THE RESULT IN @() AT THE CALL SITE. PowerShell unrolls a one-element array on
# its way out of a function, so a boot whose first line was the only line came back as a
# STRING - and indexing a string yields CHARACTERS. The first live run of this launcher echoed
# «boot: 2», the first character of «2026-09-02T22:41:50 the window already answers...», while
# the capture file held the whole sentence. A log that quotes one character of the evidence is
# the same silence this launcher exists to end.
function Read-Lines([string]$path) {
  try {
    if (-not (Test-Path $path)) { return @() }
    # -Encoding UTF8: the wrapper prints UTF-8 and its stream was redirected byte-for-byte, so
    # reading it as the ANSI code page turned every em dash into «a-tilde-euro-mdash» on its way
    # back into the lift log. The mangling happened HERE, on the read, not in the capture file.
    $c = Get-Content -Path $path -Encoding UTF8 -ErrorAction Stop
    if ($null -eq $c) { return @() }
    return @($c)
  } catch { return @() }
}

$shownOut = 0
$shownErr = 0
$echoed = 0
$deadline = (Get-Date).AddSeconds($WatchSeconds)
while ((Get-Date) -lt $deadline -and $echoed -lt $FirstLines) {
  Start-Sleep -Milliseconds 500
  $o = @(Read-Lines $outFile)
  if ($o.Count -gt $shownOut) {
    for ($i = $shownOut; $i -lt $o.Count -and $echoed -lt $FirstLines; $i++) {
      Write-Output ("boot: " + $o[$i]); $echoed++
    }
    $shownOut = $o.Count
  }
  $e = @(Read-Lines $errFile)
  if ($e.Count -gt $shownErr) {
    for ($i = $shownErr; $i -lt $e.Count -and $echoed -lt $FirstLines; $i++) {
      Write-Output ("boot-err: " + $e[$i]); $echoed++
    }
    $shownErr = $e.Count
  }
  # AN EARLY EXIT IS THE ANSWER, NOT A REASON TO KEEP WATCHING. The wrapper is meant to live
  # as long as the daemon does; if it is already gone, its exit code is the whole story.
  if ($proc.HasExited) { break }
}

if ($proc.HasExited) {
  Write-Output ("the wrapper process {0} already exited, code {1} - the daemon is NOT being held by it" -f $proc.Id, $proc.ExitCode)
} else {
  Write-Output ("the wrapper process {0} is still running - the rest of the boot continues in the logs above" -f $proc.Id)
}
exit 0
