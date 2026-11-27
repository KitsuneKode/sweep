<#
.SYNOPSIS
  Install sweep standalone binary on Windows x64.

.DESCRIPTION
  Downloads the compressed Windows x64 release asset from GitHub Releases,
  verifies its SHA-256 checksum, stages and self-checks the binary inside
  the install directory before replacing any existing installation, and
  adds the install directory to the user PATH unless -NoPathUpdate is passed.

  Quick install:
    irm https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 | iex

  Environment variables:
    SWEEP_VERSION           Version or tag to install, e.g. 0.5.2 or v0.5.2 (default: latest)
    SWEEP_INSTALL_DIR       Install directory (default: %LOCALAPPDATA%\Programs\sweep)
    SWEEP_RELEASE_BASE_URL  Test-only override for the GitHub releases base URL
#>
[CmdletBinding()]
param(
  [string]$Version = $env:SWEEP_VERSION,
  [string]$InstallDir = $(if ($env:SWEEP_INSTALL_DIR) { $env:SWEEP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\sweep" }),
  [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Repo = "KitsuneKode/sweep"
$Asset = "sweep-win-x64.exe"
$DownloadAsset = "$Asset.gz"
$ReleaseBase = if ($env:SWEEP_RELEASE_BASE_URL) {
  $env:SWEEP_RELEASE_BASE_URL.TrimEnd("/")
} else {
  "https://github.com/$Repo/releases"
}

function Write-Info([string]$Message) {
  Write-Host "  $Message"
}

function Fail([string]$Message) {
  Write-Error "sweep-install: $Message"
  exit 1
}

function Invoke-DownloadWithRetry([string]$Uri, [string]$OutFile) {
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      $params = @{
        Uri             = $Uri
        OutFile         = $OutFile
        UseBasicParsing = $true
        TimeoutSec      = 120
      }
      Invoke-WebRequest @params
      return
    } catch {
      if ($attempt -eq $maxAttempts) {
        Fail "download failed after $maxAttempts attempts ($Uri): $($_.Exception.Message)"
      }
      Start-Sleep -Seconds $attempt
    }
  }
}

function Expand-GzipFile([string]$SourcePath, [string]$DestinationPath) {
  $inputStream = [System.IO.File]::OpenRead($SourcePath)
  try {
    $gzipStream = New-Object System.IO.Compression.GZipStream($inputStream, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $outputStream = [System.IO.File]::Create($DestinationPath)
      try {
        $gzipStream.CopyTo($outputStream)
      } finally {
        $outputStream.Dispose()
      }
    } finally {
      $gzipStream.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }
}

# Enforce TLS 1.2+ on Windows PowerShell 5.1.
if ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12 -eq 0) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
} else {
  $env:PROCESSOR_ARCHITECTURE
}
if ($arch -notin @("X64", "AMD64")) {
  Fail "unsupported Windows architecture: $arch (only Windows x64 is currently supported; use npm: npm i -g @kitsunekode/sweep)"
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  Fail "unable to determine install directory; pass -InstallDir or set SWEEP_INSTALL_DIR"
}

if (-not [string]::IsNullOrWhiteSpace($Version)) {
  if ($Version -match '[/\s]') {
    Fail "invalid version: $Version"
  }
  $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  $baseUrl = "$ReleaseBase/download/$tag"
  $label = $tag
} else {
  $baseUrl = "$ReleaseBase/latest/download"
  $label = "latest"
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

$stageDir = Join-Path $InstallDir (".sweep-stage-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

try {
  $downloadPath = Join-Path $stageDir $DownloadAsset
  $checksumPath = Join-Path $stageDir "$DownloadAsset.sha256"
  $stagedBin = Join-Path $stageDir "sweep.exe"
  $assetUrl = "$baseUrl/$DownloadAsset"
  $checksumUrl = "$assetUrl.sha256"

  Write-Info "downloading $DownloadAsset ($label)"
  Invoke-DownloadWithRetry -Uri $assetUrl -OutFile $downloadPath
  Invoke-DownloadWithRetry -Uri $checksumUrl -OutFile $checksumPath

  $checksumLine = (Get-Content -Path $checksumPath -TotalCount 1).Trim()
  $expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-f]{64}$') {
    Fail "invalid SHA-256 checksum file: $checksumUrl"
  }

  $actual = (Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "checksum mismatch: expected $expected, got $actual"
  }
  Write-Info "checksum verified"

  Expand-GzipFile -SourcePath $downloadPath -DestinationPath $stagedBin

  # Prove the replacement executes before touching any existing install.
  $versionOut = & $stagedBin --version 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail "staged binary failed --version; existing installation was left unchanged: $versionOut"
  }

  $destBin = Join-Path $InstallDir "sweep.exe"
  Move-Item -Path $stagedBin -Destination $destBin -Force
  Write-Info "installed sweep -> $destBin ($($versionOut -join ' '))"

  $pathUpdated = $false
  if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $normalizedInstall = $InstallDir.TrimEnd("\")
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($userPath)) {
      $entries = $userPath.Split(";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }
    $alreadyPresent = $false
    foreach ($entry in $entries) {
      if ($entry.Trim().TrimEnd("\").Equals($normalizedInstall, [System.StringComparison]::OrdinalIgnoreCase)) {
        $alreadyPresent = $true
        break
      }
    }
    if (-not $alreadyPresent) {
      $newPath = if ($entries.Count -gt 0) { ($entries + $InstallDir) -join ";" } else { $InstallDir }
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
      if (-not ($env:Path -split ";" | Where-Object { $_.Trim().TrimEnd("\").Equals($normalizedInstall, [System.StringComparison]::OrdinalIgnoreCase) })) {
        $env:Path = "$InstallDir;$env:Path"
      }
      $pathUpdated = $true
      Write-Info "added $InstallDir to your user PATH"
    }
  }

  Write-Host ""
  Write-Info "next steps:"
  if ($pathUpdated) {
    Write-Info "  1. Open a new terminal so PATH picks up $InstallDir (or run sweep right away in this shell)."
  } elseif ($NoPathUpdate) {
    Write-Info "  1. Add $InstallDir to your PATH, or run `"$destBin`" directly."
  }
  Write-Info "  - Run 'sweep --dry-run' to preview cleanup candidates safely."
  Write-Info "  - Run 'sweep ui .' for the interactive terminal UI."
  Write-Info "  - Run 'sweep --help' for all commands and options."
} finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
