# sapi_tts.ps1 -- synthesize text to mp3 with Windows SAPI (offline, no cloud).
# Called by asr_server.py:  powershell -File sapi_tts.ps1 <textfile-utf8> <out.mp3>
# ASCII ONLY (PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK).

param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$VoiceName = 'Microsoft Huihui Desktop'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($text)) { exit 2 }

$wav = [IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetFileNameWithoutExtension($OutFile) + '.wav')

$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    try { $s.SelectVoice($VoiceName) } catch { }   # fall back to the default voice
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s.SetOutputToWaveFile($wav, $fmt)
    $s.Speak($text)
} finally {
    $s.Dispose()
}

& ffmpeg -y -v error -i $wav -codec:a libmp3lame -b:a 64k $OutFile
$code = $LASTEXITCODE
Remove-Item -LiteralPath $wav -ErrorAction SilentlyContinue
exit $code
