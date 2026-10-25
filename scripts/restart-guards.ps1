# restart-guards.ps1 -- restart both service guards (ASR + TTS) and wait for health.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-guards.ps1
# ASCII ONLY.

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$cfgPath = Join-Path $root 'config\config.json'
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $root 'config\config.example.json' }
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$asrPort = [int]$cfg.ports.asr
$ttsPort = [int]$cfg.ports.tts

$guard = Join-Path $root 'asr\guard-asr.ps1'
$asrCmd = Join-Path $root 'asr\asr-server.cmd'
$ttsCmd = Join-Path $root 'tts\tts-server.cmd'

foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like '*guard-asr.ps1*' })) {
    try { Stop-Process -Id $p.ProcessId -Force } catch { }
}
Start-Sleep -Seconds 2

$jobs = @(
    @{ args = ('-File "{0}" -Port {1} -Server "{2}" -LogName asr-server' -f $guard, $asrPort, $asrCmd) },
    @{ args = ('-File "{0}" -Port {1} -Server "{2}" -LogName tts-server' -f $guard, $ttsPort, $ttsCmd) }
)
foreach ($j in $jobs) {
    $cmdline = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' + $j.args
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmdline))
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('powershell.exe -NoProfile -EncodedCommand ' + $b64) } | Out-Null
}

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $a = (Invoke-WebRequest ("http://127.0.0.1:{0}/health" -f $asrPort) -TimeoutSec 2 -UseBasicParsing).StatusCode
        $t = (Invoke-WebRequest ("http://127.0.0.1:{0}/health" -f $ttsPort) -TimeoutSec 2 -UseBasicParsing).StatusCode
        if ($a -eq 200 -and $t -eq 200) { $ok = $true; break }
    } catch { }
}
if ($ok) { Write-Host 'both services up' } else { Write-Host 'services did not come up (see logs\*.log)' }
