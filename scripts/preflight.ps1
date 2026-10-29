# preflight.ps1 -- refuse to install over an old v0.1 setup.
#
# ASCII ONLY (checked by dsh-tools/check-script.py). All human-readable Chinese text lives
# in scripts/messages.json, which the assistant reads and relays to its owner; this script
# only prints machine markers and writes scripts/preflight.json.
#
# Exit codes: 0 = ok to install, 1 = blocked (old v0.1 found), 2 = script error.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outFile = Join-Path $root 'scripts\preflight.json'
$findings = @()
$status = 'ok'

function Add-Finding([string]$kind, [string]$detail) {
    $script:findings += [pscustomobject]@{ kind = $kind; detail = $detail }
}

# 1) VERSION file in the same folder as this repo
$versionFile = Join-Path $root 'VERSION'
if (Test-Path $versionFile) {
    $v = (Get-Content $versionFile -TotalCount 1).Trim()
    if ($v -match '^0\.1') {
        $status = 'old-v01'
        Add-Finding 'version-file' "VERSION=$v"
    }
}

# 2) the old CosyVoice model tree
foreach ($p in @('models\CosyVoice2-0.5B', 'third_party\CosyVoice-2.0')) {
    $full = Join-Path $root $p
    if (Test-Path $full) {
        $status = 'old-v01'
        Add-Finding 'old-model-tree' $p
    }
}

# 3) the plugin already installed in any DSH profile
$profiles = Join-Path $env:USERPROFILE '.dsh\profiles'
if (Test-Path $profiles) {
    Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $pkg = Join-Path $_.FullName 'node_modules\@local\dsh-voice-player\package.json'
        if (Test-Path $pkg) {
            try {
                $j = Get-Content $pkg -Raw | ConvertFrom-Json
                $ver = [string]$j.version
                if ($ver -match '^0\.1') {
                    $status = 'old-v01'
                    Add-Finding 'installed-plugin' ("profile=" + $_.Name + " version=" + $ver)
                }
            } catch {
                Add-Finding 'installed-plugin' ("profile=" + $_.Name + " unreadable")
            }
        }
    }
}

# 4) the old CosyVoice service still listening
$old = Get-NetTCPConnection -LocalPort 18081 -State Listen -ErrorAction SilentlyContinue
if ($old) {
    $status = 'old-v01'
    Add-Finding 'old-service' ("port 18081 pid=" + $old[0].OwningProcess)
}

$result = [pscustomobject]@{
    status   = $status
    findings = $findings
    action   = $(
# Human-readable report next to this script: the owner may never open a console.
$msgFile = Join-Path $PSScriptRoot 'messages.json'
$reportFile = Join-Path $PSScriptRoot 'PREFLIGHT-REPORT.txt'
try {
    if (Test-Path $msgFile) {
        $msg = Get-Content $msgFile -Raw | ConvertFrom-Json
        $node = $msg.($result.status)
        $lines = @()
        $lines += ('[' + $result.status + ']')
        if ($node.title_zh)   { $lines += $node.title_zh }
        if ($node.message_zh) { $lines += ''; $lines += $node.message_zh }
        $lines += ''
        $lines += '--- findings ---'
        $findings | ForEach-Object { $lines += ('- ' + $_.kind + ': ' + $_.detail) }
        $utf8b = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($reportFile, ($lines -join "`r`n"), $utf8b)
        Write-Output ('PREFLIGHT: human report -> ' + $reportFile)
    }
} catch {
    Write-Output ('PREFLIGHT: report write failed')
}

if ($status -eq 'old-v01') { 'ask-owner-to-remove-v01' } else { 'proceed' })
}

$json = $result | ConvertTo-Json -Depth 5
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outFile, $json, $utf8)

if ($status -eq 'old-v01') {
    Write-Output 'PREFLIGHT: BLOCKED old-v01'
    $findings | ForEach-Object { Write-Output ("  - " + $_.kind + ": " + $_.detail) }
    Write-Output ('PREFLIGHT: details -> ' + $outFile)
    Write-Output 'PREFLIGHT: assistant must tell the owner to remove v0.1 before installing'
    exit 1
}

Write-Output 'PREFLIGHT: OK'
Write-Output ('PREFLIGHT: details -> ' + $outFile)
exit 0
