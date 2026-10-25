# restart-guards.ps1 -- restart both local voice guards (ASR 18080, TTS 18081).
# Kept in its own file so filtering on "guard-asr.ps1" never matches this process.
# ASCII ONLY.
$ErrorActionPreference = 'Continue'

$guards = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*guard-asr.ps1*' }
foreach ($g in $guards) { try { Stop-Process -Id $g.ProcessId -Force } catch { } }
Start-Sleep -Seconds 2

$cmd1 = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\py-asr\guard-asr.ps1"'
$cmd2 = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\py-asr\guard-asr.ps1" -Port 18081 -Server "D:\py-tts\tts-server.cmd" -LogName tts-server'
foreach ($c in @($cmd1, $cmd2)) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($c))
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('powershell.exe -NoProfile -EncodedCommand ' + $b64) } | Out-Null
}

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $a = (Invoke-WebRequest 'http://127.0.0.1:18080/health' -TimeoutSec 2 -UseBasicParsing).StatusCode
        $t = (Invoke-WebRequest 'http://127.0.0.1:18081/health' -TimeoutSec 2 -UseBasicParsing).StatusCode
        if ($a -eq 200 -and $t -eq 200) { $ok = $true; break }
    } catch { }
}
if ($ok) { 'both services up' } else { 'services did not come up' }
