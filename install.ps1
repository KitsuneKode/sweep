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

  Download and inspect before running (respects execution policy):
    Invoke-WebRequest -Uri https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.ps1 -OutFile install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Environment variables:
    SWEEP_VERSION           Version or tag to install, e.g. 0.5.2 or v0.5.2 (default: latest)
    SWEEP_INSTALL_DIR       Install directory (default: %LOCALAPPDATA%\Programs\sweep)
    SWEEP_RELEASE_BASE_URL  Test-only override for the GitHub releases base URL
#>
[CmdletBinding()]
param(
  [string]$Version = $env:SWEEP_VERSION,
  [string]$InstallDir = $(if ($env:SWEEP_INSTALL_DIR) { $env:SWEEP_INSTALL_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\sweep" } else { "" }),
  [switch]$NoPathUpdate
)

# Run everything inside a child scriptblock so `irm ... | iex` never leaks
# $ErrorActionPreference, $ProgressPreference, strict mode, or helper functions
# into the caller's shell, and never calls `exit` (which would close the window).
& {
  param(
    [string]$VersionArg,
    [string]$InstallDirArg,
    [bool]$SkipPathUpdate
  )

  Set-StrictMode -Version Latest
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"

  # Required on Windows PowerShell 5.1 before referencing GZipStream.
  Add-Type -AssemblyName System.IO.Compression

  $Repo = "KitsuneKode/sweep"
  $Asset = "sweep-win-x64.exe"
  $DownloadAsset = "$Asset.gz"
  $MaxDownloadBytes = 209715200
  $MaxDecompressedBytes = 314572800
  $MaxChecksumBytes = 4096
  $ReleaseBase = if ($env:SWEEP_RELEASE_BASE_URL) {
    $env:SWEEP_RELEASE_BASE_URL.TrimEnd("/")
  } else {
    "https://github.com/$Repo/releases"
  }

  function Write-Info([string]$Message) {
    Write-Host "  $Message"
  }

  function Fail([string]$Message) {
    throw "sweep-install: $Message"
  }

  function Enable-ModernTls {
    $protocols = [Net.SecurityProtocolType]::Tls12
    if ([Enum]::IsDefined([Net.SecurityProtocolType], "Tls13")) {
      $protocols = $protocols -bor [Net.SecurityProtocolType]::Tls13
    }
    try {
      [Net.ServicePointManager]::SecurityProtocol = $protocols
    } catch {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }
  }

  function Resolve-LiteralFilesystemPath([string]$RawPath) {
    if ([string]::IsNullOrWhiteSpace($RawPath)) {
      return ""
    }
    $trimmed = $RawPath.Trim()
    if ([System.IO.Path]::IsPathRooted($trimmed)) {
      return [System.IO.Path]::GetFullPath($trimmed)
    }
    $baseDir = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
    return [System.IO.Path]::GetFullPath((Join-Path -Path $baseDir -ChildPath $trimmed))
  }

  function ConvertTo-NormalizedPathEntry([string]$Entry) {
    if ([string]::IsNullOrWhiteSpace($Entry)) {
      return ""
    }
    $clean = $Entry.Trim()
    if ($clean.Length -ge 2 -and $clean.StartsWith('"') -and $clean.EndsWith('"')) {
      $clean = $clean.Substring(1, $clean.Length - 2).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($clean)) {
      return ""
    }
    $clean = $clean.Replace("/", "\")
    try {
      if ([System.IO.Path]::IsPathRooted($clean)) {
        $clean = [System.IO.Path]::GetFullPath($clean)
      }
    } catch {
      # Keep raw entry if it contains characters or env tokens not valid for GetFullPath.
    }
    $root = ""
    try {
      $root = [System.IO.Path]::GetPathRoot($clean)
    } catch {
      $root = ""
    }
    if ($clean.Length -gt $root.Length) {
      $clean = $clean.TrimEnd("\")
    }
    return $clean
  }

  function Update-SweepUserPathValue([string]$CurrentPath, [string]$TargetDir) {
    $normalizedTarget = ConvertTo-NormalizedPathEntry $TargetDir
    $rawEntries = @()
    if (-not [string]::IsNullOrWhiteSpace($CurrentPath)) {
      $rawEntries = @($CurrentPath.Split(";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $deduped = New-Object 'System.Collections.Generic.List[string]'
    $alreadyPresent = $false

    foreach ($entry in $rawEntries) {
      $trimmed = $entry.Trim()
      $norm = ConvertTo-NormalizedPathEntry $trimmed
      if ([string]::IsNullOrEmpty($norm)) {
        continue
      }
      if ($norm.Equals($normalizedTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        $alreadyPresent = $true
      }
      if ($seen.Add($norm)) {
        $deduped.Add($trimmed)
      }
    }

    $finalEntries = @($deduped.ToArray())
    if (-not $alreadyPresent) {
      $finalEntries = @($finalEntries) + @($TargetDir)
    }
    $newPath = if ($finalEntries.Count -gt 0) { $finalEntries -join ";" } else { $TargetDir }
    $existingPath = if ($null -eq $CurrentPath) { "" } else { $CurrentPath }
    $changed = ($newPath -cne $existingPath)

    return [PSCustomObject]@{
      Path           = $newPath
      Added          = (-not $alreadyPresent)
      Changed        = $changed
      AlreadyPresent = $alreadyPresent
    }
  }

  function Test-ProcessPathContains([string]$ProcessPath, [string]$TargetDir) {
    $normalizedTarget = ConvertTo-NormalizedPathEntry $TargetDir
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($ProcessPath)) {
      $entries = @($ProcessPath.Split(";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    foreach ($entry in $entries) {
      $norm = ConvertTo-NormalizedPathEntry $entry
      if ($norm.Equals($normalizedTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
    return $false
  }

  function Invoke-DownloadWithRetry([string]$Uri, [string]$OutFile, [long]$MaxBytes) {
    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
      try {
        $params = @{
          Uri             = $Uri
          OutFile         = $OutFile
          UseBasicParsing = $true
          TimeoutSec      = 120
        }
        Invoke-WebRequest @params | Out-Null
        $fileInfo = Get-Item -LiteralPath $OutFile
        if ($fileInfo.Length -gt $MaxBytes) {
          Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
          Fail "downloaded file exceeds maximum allowed size ($MaxBytes bytes): $Uri"
        }
        return
      } catch {
        if ($_.Exception.Message -like "sweep-install:*") {
          throw
        }
        if ($attempt -eq $maxAttempts) {
          Fail "download failed after $maxAttempts attempts ($Uri): $($_.Exception.Message)"
        }
        Start-Sleep -Seconds $attempt
      }
    }
  }

  function Expand-GzipFile([string]$SourcePath, [string]$DestinationPath, [long]$MaxBytes) {
    $inputStream = [System.IO.File]::OpenRead($SourcePath)
    try {
      $gzipStream = New-Object System.IO.Compression.GZipStream($inputStream, [System.IO.Compression.CompressionMode]::Decompress)
      try {
        $outputStream = [System.IO.File]::Create($DestinationPath)
        try {
          $buffer = New-Object byte[] 65536
          [long]$total = 0
          while (($read = $gzipStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt $MaxBytes) {
              Fail "decompressed binary exceeds maximum allowed size ($MaxBytes bytes)"
            }
            $outputStream.Write($buffer, 0, $read)
          }
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

  Enable-ModernTls

  $arch = ""
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $arch = $env:PROCESSOR_ARCHITECTURE
  }
  if ($arch -notin @("X64", "AMD64")) {
    Fail "unsupported Windows architecture: $arch (only Windows x64 is currently supported; use npm: npm i -g @kitsunekode/sweep)"
  }

  if ([string]::IsNullOrWhiteSpace($InstallDirArg)) {
    Fail "unable to determine install directory; pass -InstallDir or set SWEEP_INSTALL_DIR"
  }

  $resolvedInstallDir = Resolve-LiteralFilesystemPath $InstallDirArg
  if (Test-Path -LiteralPath $resolvedInstallDir -PathType Leaf) {
    Fail "install directory path is a file, refusing to install: $resolvedInstallDir"
  }

  if (-not [string]::IsNullOrWhiteSpace($VersionArg)) {
    if ($VersionArg -match '[/\s]') {
      Fail "invalid version: $VersionArg"
    }
    $tag = if ($VersionArg.StartsWith("v")) { $VersionArg } else { "v$VersionArg" }
    $baseUrl = "$ReleaseBase/download/$tag"
    $label = $tag
  } else {
    $baseUrl = "$ReleaseBase/latest/download"
    $label = "latest"
  }

  [System.IO.Directory]::CreateDirectory($resolvedInstallDir) | Out-Null

  $destBin = Join-Path -Path $resolvedInstallDir -ChildPath "sweep.exe"
  if (Test-Path -LiteralPath $destBin -PathType Container) {
    Fail "destination path is a directory, refusing to install: $destBin"
  }

  $stageDir = Join-Path -Path $resolvedInstallDir -ChildPath (".sweep-stage-" + [System.Guid]::NewGuid().ToString("N"))
  [System.IO.Directory]::CreateDirectory($stageDir) | Out-Null

  try {
    $downloadPath = Join-Path -Path $stageDir -ChildPath $DownloadAsset
    $checksumPath = Join-Path -Path $stageDir -ChildPath "$DownloadAsset.sha256"
    $stagedBin = Join-Path -Path $stageDir -ChildPath "sweep.exe"
    $assetUrl = "$baseUrl/$DownloadAsset"
    $checksumUrl = "$assetUrl.sha256"

    Write-Info "downloading $DownloadAsset ($label)"
    Invoke-DownloadWithRetry -Uri $assetUrl -OutFile $downloadPath -MaxBytes $MaxDownloadBytes
    Invoke-DownloadWithRetry -Uri $checksumUrl -OutFile $checksumPath -MaxBytes $MaxChecksumBytes

    $checksumLines = @(Get-Content -LiteralPath $checksumPath -TotalCount 1)
    $checksumLine = if ($checksumLines.Count -gt 0) { [string]$checksumLines[0] } else { "" }
    $expected = ($checksumLine.Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
      Fail "invalid SHA-256 checksum file: $checksumUrl"
    }

    $actual = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Fail "checksum mismatch: expected $expected, got $actual"
    }
    Write-Info "checksum verified"

    Expand-GzipFile -SourcePath $downloadPath -DestinationPath $stagedBin -MaxBytes $MaxDecompressedBytes

    # Prove the replacement starts and executes cleanly before touching any existing install.
    $global:LASTEXITCODE = 0
    $versionOk = $false
    $versionOut = @()
    try {
      $versionOut = @(& $stagedBin --version 2>&1)
      $cmdOk = $?
      $exitVar = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
      $exitCode = if ($null -ne $exitVar) { $exitVar.Value } else { $null }
      $versionOk = $cmdOk -and ($null -eq $exitCode -or $exitCode -eq 0)
    } catch {
      $versionOut = @($_.Exception.Message)
      $versionOk = $false
    }
    if (-not $versionOk) {
      $detail = (@($versionOut) | ForEach-Object { "$_" }) -join " "
      Fail "staged binary failed --version; existing installation was left unchanged: $detail"
    }

    if (Test-Path -LiteralPath $destBin -PathType Container) {
      Fail "destination path is a directory, refusing to install: $destBin"
    }
    Move-Item -LiteralPath $stagedBin -Destination $destBin -Force
    $versionText = (@($versionOut) | ForEach-Object { "$_" }) -join " "
    Write-Info "installed sweep -> $destBin ($versionText)"

    $pathUpdated = $false
    if (-not $SkipPathUpdate) {
      $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
      $pathResult = Update-SweepUserPathValue -CurrentPath $userPath -TargetDir $resolvedInstallDir
      if ($pathResult.Changed) {
        [Environment]::SetEnvironmentVariable("Path", $pathResult.Path, "User")
      }
      if ($pathResult.Added) {
        $pathUpdated = $true
        Write-Info "added $resolvedInstallDir to your user PATH"
      }
      # Refresh the current process PATH even when the user PATH already had it.
      if (-not (Test-ProcessPathContains -ProcessPath $env:Path -TargetDir $resolvedInstallDir)) {
        $env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) {
          $resolvedInstallDir
        } else {
          "$resolvedInstallDir;$env:Path"
        }
      }
    }

    Write-Host ""
    Write-Info "next steps:"
    if ($pathUpdated) {
      Write-Info "  1. Open a new terminal so PATH picks up $resolvedInstallDir (or run sweep right away in this shell)."
    } elseif ($SkipPathUpdate) {
      Write-Info "  1. Add $resolvedInstallDir to your PATH, or run `"$destBin`" directly."
    }
    Write-Info "  - Run 'sweep --dry-run' to preview cleanup candidates safely."
    Write-Info "  - Run 'sweep ui .' for the interactive terminal UI."
    Write-Info "  - Run 'sweep --help' for all commands and options."
  } finally {
    if (Test-Path -LiteralPath $stageDir) {
      Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
} $Version $InstallDir ([bool]$NoPathUpdate)
