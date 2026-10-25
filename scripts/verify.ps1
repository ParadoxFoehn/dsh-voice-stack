# verify.ps1 -- end-to-end smoke test for the local voice stack.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
# Exit code 0 = every check passed. ASCII ONLY.

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$cfgPath = Join-Path $root 'config\config.json'
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $root 'config\config.example.json' }
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$asrPort = [int]$cfg.ports.asr
$ttsPort = [int]$cfg.ports.tts
$fail = 0

function Check($name, $ok, $detail) {
    if ($ok) { Write-Host ("  PASS  " + $name + "  " + $detail) }
    else { Write-Host ("  FAIL  " + $name + "  " + $detail); $script:fail++ }
}

Write-Host '--- files ---'
foreach ($rel in @('models\Qwen3-ASR-1.7B\config.json', 'models\CosyVoice2-0.5B\cosyvoice2.yaml',
                   'models\CosyVoice2-0.5B\llm.pt', 'models\CosyVoice2-0.5B\CosyVoice-BlankEN\model.safetensors',
                   'third_party\CosyVoice-2.0\cosyvoice\cli\cosyvoice.py', 'third_party\Matcha-TTS\matcha',
                   'assets\prompt.wav')) {
    Check 'exists' (Test-Path (Join-Path $root $rel)) $rel
}

Write-Host '--- services ---'
function Probe($port, $name) {
    try { $r = Invoke-WebRequest ("http://127.0.0.1:{0}/health" -f $port) -TimeoutSec 3 -UseBasicParsing
          Check $name ($r.StatusCode -eq 200) $r.Content.Trim() }
    catch { Check $name $false 'not running (scripts\restart-guards.ps1 starts both)' }
}
Probe $asrPort 'asr'
Probe $ttsPort 'tts'

Write-Host '--- speech out ---'
$line = $cfg.verify_text
try {
    $enc = [uri]::EscapeDataString($line)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-WebRequest ("http://127.0.0.1:{0}/say?text={1}" -f $ttsPort, $enc) -TimeoutSec 600 -UseBasicParsing
    $sw.Stop()
    $bytes = $r.RawContentLength
    Check 'tts /say' ($r.StatusCode -eq 200 -and $bytes -gt 5000) ("{0} bytes in {1:N1}s" -f $bytes, $sw.Elapsed.TotalSeconds)
    $last = Invoke-WebRequest ("http://127.0.0.1:{0}/last" -f $ttsPort) -TimeoutSec 5 -UseBasicParsing
    $file = ([Text.Encoding]::UTF8.GetString($last.RawContentStream.ToArray()) | ConvertFrom-Json).file
    Check 'tts /player' ((Invoke-WebRequest ("http://127.0.0.1:{0}/player?file={1}" -f $ttsPort, $file) -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200) $file

    Write-Host '--- speech in (round trip) ---'
    $mp3 = Join-Path $root ("tts\out\" + $file)
    $json = & curl.exe -s --max-time 600 -F ("file=@{0}" -f $mp3) ("http://127.0.0.1:{0}/v1/audio/transcriptions" -f $asrPort)
    $text = ($json | ConvertFrom-Json).text
    $needle = $line.Substring(0, 2)
    $hit = ($text -replace '[^\u4e00-\u9fa5]', '') -like ('*' + $needle + '*')
    Check 'asr round trip' $hit $text
} catch {
    Check 'speech out' $false $_.Exception.Message
}

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL CHECKS PASSED' } else { Write-Host ("{0} CHECK(S) FAILED" -f $fail) }
exit $fail
