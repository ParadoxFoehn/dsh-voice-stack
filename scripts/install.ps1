# install.ps1 -- set up the local voice stack (Windows 10/11, PowerShell 5.1+).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
#
# What it does (idempotent, safe to re-run):
#   1. checks python 3.12 / ffmpeg
#   2. creates .venv-asr and .venv-tts
#   3. installs torch (CUDA 12.8 wheels by default) + each service's requirements
#   4. fetches the CosyVoice v2.0 source + Matcha-TTS into third_party\
#   5. downloads the two models from ModelScope (about 8.8 GB)
#   6. makes assets\prompt.wav with Windows SAPI (the seed voice)
#   7. writes config\config.json
#   8. prints the remaining manual steps
#
# ASCII ONLY.

[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cu128',
    [string]$PipIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple',
    [string]$GitHubProxy = 'https://gh-proxy.com/',
    [switch]$SkipModels,
    [switch]$SkipSource,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --- guard: refuse to install over an old v0.1 setup -------------------------
$pf = Join-Path $PSScriptRoot 'preflight.ps1'
if (Test-Path $pf) {
    & $pf
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host 'INSTALL BLOCKED: old v0.1 detected.'
        Write-Host 'Tell the owner to remove the old install first; details in scripts/preflight.json'
        Write-Host 'and the human-readable text in scripts/messages.json.'
        exit 1
    }
}
# ---------------------------------------------------------------------------
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
function Say($m) { Write-Host ("[install] " + $m) }

# ---------------------------------------------------------------- 0. sanity
if ($env:OS -ne 'Windows_NT') { throw 'This installer targets Windows.' }
if ($root -match '[^\x00-\x7F]') {
    Say 'WARNING: the repo path contains non-ASCII characters.'
    Say '         Some dependencies (wetext fsts, nagisa, onnxruntime) fail on such paths.'
    Say '         Recommended: move the folder to e.g. D:\dsh-voice, or create a junction:'
    Say '           cmd /c mklink /J D:\dsh-voice "' + $root + '"'
    Say '         and run this installer from the junction.'
}

function Find-Python {
    if ($Python) { return $Python }
    foreach ($cand in @('py -3.12', 'py -3', 'python')) {
        try {
            $exe = $cand.Split(' ')[0]
            $rest = ($cand.Split(' ') | Select-Object -Skip 1) -join ' '
            $ver = & $exe $rest -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
            if ($ver -eq '3.12' -or $ver -eq '3.11' -or $ver -eq '3.13') {
                $path = & $exe $rest -c "import sys;print(sys.executable)" 2>$null
                if ($path) { return $path }
            }
        } catch { }
    }
    throw 'Python 3.12 not found. Install it (python.org) and re-run with -Python "C:\Path\python.exe".'
}

$py = Find-Python
Say ("python: " + $py)

$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
    Say 'ffmpeg not found on PATH. Install it (winget install Gyan.FFmpeg) - wav<->mp3 conversion needs it.'
    throw 'ffmpeg missing'
}
Say ("ffmpeg: " + $ff.Source)

# ---------------------------------------------------------------- 1. venvs
function New-Venv([string]$dir) {
    if ((Test-Path (Join-Path $dir 'Scripts\python.exe')) -and -not $Force) {
        Say ("venv exists: " + $dir)
        return
    }
    Say ("creating " + $dir)
    & $py -m venv $dir
}

New-Venv '.venv-asr'
New-Venv '.venv-tts'
$asrPy = Join-Path $root '.venv-asr\Scripts\python.exe'
$ttsPy = Join-Path $root '.venv-tts\Scripts\python.exe'

# ---------------------------------------------------------------- 2. packages
Say 'upgrading pip in both venvs'
& $asrPy -m pip install --upgrade pip wheel | Out-Null
& $ttsPy -m pip install --upgrade pip wheel | Out-Null

Say 'installing torch/torchaudio (this is the big one, ~2.7 GB)'
& $asrPy -m pip install --no-cache-dir "torch==2.11.0" "torchaudio==2.11.0" --index-url $TorchIndex
& $ttsPy -m pip install --no-cache-dir "torch==2.11.0" "torchaudio==2.11.0" --index-url $TorchIndex

Say 'installing ASR requirements'
& $asrPy -m pip install --no-cache-dir -r (Join-Path $root 'asr\requirements.txt') --index-url $PipIndex
Say 'installing TTS requirements'
& $ttsPy -m pip install --no-cache-dir -r (Join-Path $root 'tts\requirements.txt') --index-url $PipIndex

# tts requirements pin numpy 1.26 / transformers 4.51; other packages may have bumped them
& $ttsPy -m pip install --no-cache-dir "numpy==1.26.4" "transformers==4.51.3" "scipy==1.13.1" `
    "scikit-learn==1.5.2" "numba==0.60.0" "pyarrow==17.0.0" "huggingface_hub<1.0" --index-url $PipIndex

# ---------------------------------------------------------------- 3. source
if (-not $SkipSource) {
    $tp = Join-Path $root 'third_party'
    New-Item -ItemType Directory -Force -Path $tp | Out-Null

    $cvDir = Join-Path $tp 'CosyVoice-2.0'
    if (-not (Test-Path (Join-Path $cvDir 'cosyvoice\cli\cosyvoice.py'))) {
        Say 'fetching CosyVoice source (tag v2.0 -- main is CosyVoice3 and will NOT work with this model)'
        $tgz = Join-Path $env:TEMP 'cosyvoice-v2.0.tgz'
        Invoke-WebRequest -Uri ($GitHubProxy + 'https://codeload.github.com/FunAudioLLM/CosyVoice/tar.gz/refs/tags/v2.0') -OutFile $tgz
        Push-Location $tp; & tar.exe -xzf $tgz 2>$null; Pop-Location
        if (-not (Test-Path $cvDir)) { Move-Item (Join-Path $tp 'CosyVoice-2.0') $cvDir -Force }
    } else { Say 'CosyVoice source already present' }

    $mtDir = Join-Path $tp 'Matcha-TTS'
    if (-not (Test-Path (Join-Path $mtDir 'matcha'))) {
        Say 'fetching Matcha-TTS source (provides the `matcha` package CosyVoice imports)'
        $tgz2 = Join-Path $env:TEMP 'matcha-tts.tgz'
        Invoke-WebRequest -Uri ($GitHubProxy + 'https://codeload.github.com/shivammehta25/Matcha-TTS/tar.gz/refs/heads/main') -OutFile $tgz2
        Push-Location $tp; & tar.exe -xzf $tgz2 2>$null; Pop-Location
        if (-not (Test-Path $mtDir)) { Move-Item (Join-Path $tp 'Matcha-TTS-main') $mtDir -Force }
    } else { Say 'Matcha-TTS source already present' }

    Say 'patching CosyVoice load_wav for torchaudio >= 2.9 (TorchCodec)'
    & $asrPy (Join-Path $root 'scripts\patch-cosyvoice.py') | Out-Host
}

# ---------------------------------------------------------------- 4. models
if (-not $SkipModels) {
    Say 'downloading models from ModelScope (~8.8 GB, resumable: existing files are skipped)'
    & $asrPy (Join-Path $root 'scripts\download-models.py')
} else {
    Say 'models skipped (-SkipModels)'
}

# ---------------------------------------------------------------- 5. prompt voice
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$promptWav = Join-Path $assets 'prompt.wav'
if (-not (Test-Path $promptWav)) {
    Say 'creating assets\prompt.wav with Windows SAPI (this is only the timbre seed)'
    try {
        Add-Type -AssemblyName System.Speech
        $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try { $s.SelectVoice('Microsoft Huihui Desktop') } catch { }
        $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono)
        $s.SetOutputToWaveFile($promptWav, $fmt)
        $promptText = (Get-Content -LiteralPath (Join-Path $root 'config\config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json).prompt_text
        $s.Speak($promptText)
        $s.Dispose()
    } catch {
        Say 'SAPI failed. Record 3-5 seconds of speech yourself, 16 kHz mono WAV,'
        Say 'and save it as assets\prompt.wav, then edit prompt_text in config\config.json.'
    }
}

# ---------------------------------------------------------------- 6. config
$cfg = Join-Path $root 'config\config.json'
if (-not (Test-Path $cfg) -or $Force) {
    Copy-Item (Join-Path $root 'config\config.example.json') $cfg -Force
    Say 'wrote config\config.json (edit it if your paths differ)'
} else { Say 'config\config.json already exists, left untouched' }

# ---------------------------------------------------------------- 7. next steps
Say ''
Say 'Done. Next:'
Say '  1) powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1'
Say '  2) install the DSH plugin: point your plugin manager at plugin\ (bundle @local/dsh-voice-player)'
Say '  3) copy skill\speak into your DSH skills folder'
Say '  4) optional: scripts\register-startup.ps1   (start both services with Windows)'
