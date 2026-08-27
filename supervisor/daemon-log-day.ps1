<#
  daemon-log-day.ps1 - the day the next log line belongs to, and the writer that puts
  it there. Dot-sourced by start-daemon-windows.ps1; it defines functions only and
  starts nothing, so sourcing it is free.

  WHY THIS IS ITS OWN FILE. The wrapper lives as long as the daemon does, so the name
  of the log file cannot be worked out once at launch: a name computed at boot pins
  every later day to the boot day's file. That was measured on 26.08.2026 -
  "daemon-20260826.log" never existed, and 1134 lines of the 26th plus the crash dump
  that ended the process all sat in daemon-20260825.log where nobody looked. The cure
  is to resolve the date PER LINE. The cure could not be PROVEN, though, without either
  waiting for a real midnight or being able to move the clock: the date lived inline
  inside a pipeline that only runs after Postgres is up and the daemon is launched, so
  nothing could drive it. This file is that seam, and nothing more - the same two
  functions the wrapper writes through can be dot-sourced by a drill and driven across
  a midnight in a second (see log-rotation-drill.ps1).

  THE CLOCK OVERRIDE IS FOR DRILLS AND IS FAIL-SOFT. $env:SMA_LOG_CLOCK_FILE names a
  file holding one timestamp ("2026-08-27T23:59:58", or a bare "20260827"). It is read
  on EVERY line, so a drill - or an operator watching a live wrapper - can move the
  clock mid-stream. Anything wrong with it (unset, missing, empty, unparseable, locked)
  falls back to the real clock without a word: a broken drill variable must never be
  able to stop a daemon from writing its log.

  ENCODING - this file is pure ASCII on purpose, and must stay that way or carry a BOM.
  Windows PowerShell 5.1 reads a BOM-less file as ANSI and can turn a non-ASCII
  character into a string delimiter, which makes the whole script fail to parse. A test
  in the suite holds every shipped .ps1 to that rule.
#>

# Get-SmaDaemonLogDay - the yyyyMMdd stamp the CURRENT line belongs to.
function Get-SmaDaemonLogDay {
  $clockFile = $env:SMA_LOG_CLOCK_FILE
  if ($clockFile) {
    try {
      $raw = [System.IO.File]::ReadAllText($clockFile).Trim()
      if ($raw) {
        if ($raw -match '^\d{8}$') { return $raw }
        $when = [datetime]::Parse($raw, [System.Globalization.CultureInfo]::InvariantCulture)
        return $when.ToString('yyyyMMdd')
      }
    } catch { }
  }
  return (Get-Date -Format 'yyyyMMdd')
}

# Get-SmaDaemonLogFile - the full path of the file the CURRENT line belongs in.
function Get-SmaDaemonLogFile([string]$LogDir) {
  return (Join-Path $LogDir ("daemon-{0}.log" -f (Get-SmaDaemonLogDay)))
}

<#
  Write-SmaDaemonLogLine - append one line to the day's file and return that path.

  ONE SHORT-LIVED HANDLE PER LINE. Add-Content or Out-File would hold the file open for
  the daemon's whole life, and then nobody - not the founder, not a support command -
  could so much as read the log while the thing they are debugging is running. Measured:
  `Get-Content` answered "being used by another process" for as long as the daemon lived.

  UTF-8 WITHOUT A BOM, explicitly. PowerShell 5.1's `*>>` append redirection writes
  UTF-16 into a file the rest of the wrapper writes as UTF-8, so the daemon's own lines
  came out as "[ S m a D a e m o n ]" and every Cyrillic sentence it prints - which is
  most of what it says to an operator - became unreadable.
#>
function Write-SmaDaemonLogLine([string]$LogDir, [string]$Text) {
  $path = Get-SmaDaemonLogFile $LogDir
  [System.IO.File]::AppendAllText($path, $Text, (New-Object System.Text.UTF8Encoding($false)))
  return $path
}
