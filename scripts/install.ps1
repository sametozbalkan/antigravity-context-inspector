# Install or update Antigravity Context Inspector on Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/sametozbalkan/antigravity-context-inspector/main/scripts/install.ps1 | iex

& {
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $RepoUrl   = 'https://github.com/sametozbalkan/antigravity-context-inspector.git'
    $ZipUrl    = 'https://github.com/sametozbalkan/antigravity-context-inspector/archive/refs/heads/main.zip'
    $PluginDir = Join-Path $HOME '.gemini\config\plugins\context-inspector'
    $ParentDir = Split-Path -Parent $PluginDir
    $HasGit    = [bool](Get-Command git -ErrorAction SilentlyContinue)

    if (Test-Path (Join-Path $PluginDir '.git')) {
        if ($HasGit) {
            Write-Host 'Updating Context Inspector via git pull...' -ForegroundColor Cyan
            git -C $PluginDir pull --ff-only
            if ($LASTEXITCODE -ne 0) {
                throw "git pull failed with exit code $LASTEXITCODE"
            }
            Write-Host 'Updated! Toggle Context Inspector off and on in Antigravity Customizations to reload.' -ForegroundColor Green
            return
        }
    }

    New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
    $StageRoot = Join-Path $ParentDir ('.tmp-context-inspector-' + [guid]::NewGuid().ToString('N'))

    try {
        New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
        $StageSource = $null

        if ($HasGit) {
            Write-Host "Cloning into $PluginDir..." -ForegroundColor Cyan
            $StageSource = Join-Path $StageRoot 'repo'
            git clone $RepoUrl $StageSource
            if ($LASTEXITCODE -ne 0) {
                throw "git clone failed with exit code $LASTEXITCODE"
            }
        } else {
            Write-Host 'git not found — downloading ZIP archive...' -ForegroundColor Cyan
            $tmpZip = Join-Path $StageRoot 'archive.zip'
            $tmpExtract = Join-Path $StageRoot 'extract'
            Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip -UseBasicParsing
            Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
            $dirs = @(Get-ChildItem -Path $tmpExtract -Directory)
            if ($dirs.Count -ne 1) {
                throw "Expected a single directory in extracted archive, found $($dirs.Count)."
            }
            $StageSource = $dirs[0].FullName
        }

        if (-not (Test-Path (Join-Path $StageSource 'plugin.json'))) {
            throw 'Staged installation is missing plugin.json.'
        }

        if (Test-Path $PluginDir) {
            Write-Host "Replacing existing installation at $PluginDir..." -ForegroundColor Yellow
            Remove-Item -Recurse -Force $PluginDir
        }

        Move-Item -Path $StageSource -Destination $PluginDir
    } finally {
        if (Test-Path $StageRoot) {
            Remove-Item -Recurse -Force $StageRoot -ErrorAction SilentlyContinue
        }
    }

    Write-Host ''
    Write-Host 'Installed Context Inspector!' -ForegroundColor Green
    Write-Host 'Next: Open Antigravity -> Customizations -> Installed, enable "Context Inspector", and open it from the side panel.'
}
