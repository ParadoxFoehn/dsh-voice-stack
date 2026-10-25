# guard-asr.ps1 -- keep the local Qwen3-ASR endpoint alive for exactly as long as the DSH client runs.
#
# Behaviour (user request 2026-10-24):
#   * client starts  -> endpoint process starts (cheap; the MODEL loads lazily on first voice use)
#   * first voice use -> model loads into VRAM, then stays resident
#   * client exits   -> endpoint is stopped, VRAM released
#   * endpoint dies while the client runs -> restarted
#
# Installed as a logon scheduled task:  DSH-ASR-Guard
# Manual test:  powershell -NoProfile -ExecutionPolicy Bypass -File guard-asr.ps1 -ClientName notepad
#
# NOTE: ASCII ONLY (PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK).

param(
    [string]$ClientName = 'DeepSeek Harness',
    [int]$Port = 18080,
    [int]$PollSec = 3,
    [string]$Server = '',
    [string]$LogName = 'asr-server'
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
if (-not $Server) { $Server = Join-Path $here 'asr-server.cmd' }
$server = $Server
$log = Join-Path $here 'guard.log'

function Write-Log([string]$msg) {
    try { ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) | Add-Content -LiteralPath $log -Encoding UTF8 } catch { }
}

function Test-Asr {
    try { $null = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 2 -UseBasicParsing; return $true }
    catch { return $false }
}

function Get-AsrPid {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
    return 0
}

function Stop-Asr {
    $p = Get-AsrPid
    if ($p -gt 0) {
        try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Log ("stopped asr pid {0} (client gone)" -f $p) } catch { }
    }
}

function Start-Asr {
    if (Test-Asr) { return }
    # keep the endpoint's own stdout/stderr so a 500 can be diagnosed later
    $logs = Join-Path (Split-Path $here -Parent) 'logs'
    if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Force -Path $logs | Out-Null }
    $out = Join-Path $logs ($LogName + '.log')
    $err = Join-Path $logs ($LogName + '.log.err')
    # Start detached through WMI: a child started from this console dies with a
    # window-CLOSE event (Python/MKL abort) when the console goes away.
    $line = 'cmd.exe /c ""' + $server + '" >> "' + $out + '" 2>> "' + $err + '""'
    try { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line } | Out-Null } catch { }
    Write-Log ("started endpoint on port {0}" -f $Port)
    for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if (Test-Asr) { break } }
}

# single instance only
$mutex = New-Object System.Threading.Mutex($false, ('Global\DshGuard-' + $Port))
if (-not $mutex.WaitOne(0)) { exit 0 }

Write-Log ("guard up; waiting for client process '{0}'" -f $ClientName)

while ($true) {
    $client = Get-Process -Name $ClientName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($client) {
        if (-not (Test-Asr)) { Start-Asr }
        $script:wasUp = $true
    } else {
        if (Test-Asr -or (Get-AsrPid) -gt 0) { Stop-Asr }
    }
    Start-Sleep -Seconds $PollSec
}
