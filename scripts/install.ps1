# Install or update Antigravity Context Inspector on Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/sametozbalkan/antigravity-context-inspector/main/scripts/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$RepoUrl   = 'https://github.com/sametozbalkan/antigravity-context-inspector.git'
$ZipUrl    = 'https://github.com/sametozbalkan/antigravity-context-inspector/archive/refs/heads/main.zip'
$PluginDir = Join-Path $HOME '.gemini\config\plugins\context-inspector'
$HasGit    = [bool](Get-Command git -ErrorAction SilentlyContinue)

if (Test-Path (Join-Path $PluginDir '.git')) {
    if ($HasGit) {
        Write-Host 'Updating Context Inspector via git pull...' -ForegroundColor Cyan
        git -C $PluginDir pull --ff-only
        Write-Host 'Updated! Toggle Context Inspector off and on in Antigravity Customizations to reload.' -ForegroundColor Green
        return
    }
}

if (Test-Path $PluginDir) {
    Write-Host "Replacing existing installation at $PluginDir..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $PluginDir
}

New-Item -ItemType Directory -Force -Path (Split-Path $PluginDir) | Out-Null

if ($HasGit) {
    Write-Host "Cloning into $PluginDir..." -ForegroundColor Cyan
    git clone $RepoUrl $PluginDir
} else {
    Write-Host 'git not found — downloading ZIP archive...' -ForegroundColor Cyan
    $tmpZip = Join-Path $env:TEMP 'antigravity-context-inspector.zip'
    $tmpDir = Join-Path $env:TEMP 'antigravity-context-inspector-extract'
    Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip -UseBasicParsing
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    $extracted = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
    Move-Item -Path $extracted.FullName -Destination $PluginDir
    Remove-Item -Force $tmpZip
    Remove-Item -Recurse -Force $tmpDir
}

Write-Host ''
Write-Host 'Installed Context Inspector!' -ForegroundColor Green
Write-Host 'Next: Open Antigravity -> Customizations -> Installed, enable "Context Inspector", and open it from the side panel.'
