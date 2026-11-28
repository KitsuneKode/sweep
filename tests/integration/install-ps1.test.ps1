# PowerShell 5.1 and PowerShell 7 test suite for install.ps1.
# Runs pure AST/helper/scope checks everywhere, plus full local HTTP install
# tests (spaces, brackets, reinstall, -NoPathUpdate, bad checksum, start failure,
# irm | iex scope isolation) on Windows.
[CmdletBinding()]
param(
  [string]$TestBinaryPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installPs1 = Join-Path -Path $repoRoot -ChildPath "install.ps1"

$script:passed = 0
$script:failed = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "Assertion failed: $Message"
  }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) {
    throw "Assertion failed ($Message): expected '$Expected', got '$Actual'"
  }
}

function Run-Test([string]$Name, [scriptblock]$Body) {
  try {
    & $Body
    $script:passed++
    Write-Host "  PASS: $Name"
  } catch {
    $script:failed++
    Write-Host "  FAIL: $Name -> $($_.Exception.Message)"
  }
}

Write-Host "Running install.ps1 tests on PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"

# 1. AST parse check (0 syntax errors).
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installPs1, [ref]$tokens, [ref]$parseErrors)

Run-Test "install.ps1 parses with zero syntax errors" {
  Assert-True ($parseErrors.Count -eq 0) "Found parse errors: $($parseErrors -join '; ')"
}

# Extract helper functions directly from install.ps1's AST so tests cover the exact implementation.
$helperDefs = $ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -in @("ConvertTo-NormalizedPathEntry", "Update-SweepUserPathValue", "Test-ProcessPathContains", "Invoke-StagedVersionCheck")
}, $true)

Assert-True ($helperDefs.Count -eq 4) "Expected 4 helper functions in install.ps1, found $($helperDefs.Count)"
foreach ($def in $helperDefs) {
  Invoke-Expression $def.Extent.Text
}

Run-Test "Update-SweepUserPathValue handles empty, single-entry, and multi-entry PATH without PS 5.1/7 scalar bugs" {
  $target = "C:\Users\dev\AppData\Local\Programs\sweep"

  $empty = Update-SweepUserPathValue -CurrentPath "" -TargetDir $target
  Assert-Equal $empty.Path $target "empty PATH"
  Assert-True $empty.Added "empty PATH should mark Added"
  Assert-True $empty.Changed "empty PATH should mark Changed"

  # Single-entry default Windows PATH (blocker on both PS 5.1 and PS 7).
  $single = Update-SweepUserPathValue -CurrentPath "C:\Users\dev\AppData\Local\Microsoft\WindowsApps" -TargetDir $target
  Assert-Equal $single.Path "C:\Users\dev\AppData\Local\Microsoft\WindowsApps;$target" "single-entry PATH join"
  Assert-True $single.Added "single-entry PATH should add target"

  $multi = Update-SweepUserPathValue -CurrentPath "C:\Tools;C:\Bin" -TargetDir $target
  Assert-Equal $multi.Path "C:\Tools;C:\Bin;$target" "multi-entry PATH join"
}

Run-Test "Update-SweepUserPathValue normalizes case, quotes, slashes, trailing backslashes and deduplicates entries" {
  $target = "C:\Users\dev\AppData\Local\Programs\sweep"

  $equiv = Update-SweepUserPathValue -CurrentPath '"c:/Users/dev/AppData/Local/Programs/sweep\"' -TargetDir $target
  Assert-True (-not $equiv.Added) "equivalent quoted/forward-slash/trailing-slash entry should match"
  Assert-True $equiv.AlreadyPresent "AlreadyPresent should be true"

  $dups = Update-SweepUserPathValue -CurrentPath "C:\Tools;c:\tools\;C:\Bin;$target;$target\" -TargetDir $target
  Assert-True (-not $dups.Added) "existing target should not be added again"
  Assert-Equal $dups.Path "C:\Tools;C:\Bin;$target" "duplicate entries should be collapsed"
}

Run-Test "Test-ProcessPathContains detects normalized matches and misses" {
  $target = "C:\Users\dev\AppData\Local\Programs\sweep"
  Assert-True (-not (Test-ProcessPathContains -ProcessPath "C:\Windows\System32" -TargetDir $target)) "should be absent"
  Assert-True (Test-ProcessPathContains -ProcessPath "C:\Windows\System32;c:/users/dev/appdata/local/programs/sweep\" -TargetDir $target) "should match normalized entry"
}

Run-Test "install.ps1 does not leak ErrorActionPreference, ProgressPreference, or exit caller when run via iex" {
  $origEap = "Continue"
  $origProg = "Continue"
  $ErrorActionPreference = $origEap
  $ProgressPreference = $origProg

  $env:SWEEP_VERSION = "bad/version"
  $threw = $false
  try {
    Invoke-Expression (Get-Content -LiteralPath $installPs1 -Raw)
  } catch {
    $threw = $true
  } finally {
    Remove-Item Env:SWEEP_VERSION -ErrorAction SilentlyContinue
  }

  Assert-True $threw "invalid version via iex should throw, not exit the shell"
  Assert-Equal ([string]$ErrorActionPreference) $origEap "caller ErrorActionPreference must be preserved"
  Assert-Equal ([string]$ProgressPreference) $origProg "caller ProgressPreference must be preserved"
}

Run-Test "File.Replace with NullString::Value replaces existing file in [bracket] directory" {
  $tmp = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("sweep-replace-test-" + [System.Guid]::NewGuid().ToString("N"))
  $dir = Join-Path -Path $tmp -ChildPath "replace [bracket] dir"
  try {
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null
    $src = Join-Path -Path $dir -ChildPath "staged.bin"
    $dst = Join-Path -Path $dir -ChildPath "sweep.exe"
    [System.IO.File]::WriteAllText($dst, "old-version")
    [System.IO.File]::WriteAllText($src, "new-version")
    [System.IO.File]::Replace($src, $dst, [System.Management.Automation.Language.NullString]::Value)
    Assert-Equal ([System.IO.File]::ReadAllText($dst)) "new-version" "destination should hold new content"
    Assert-True (-not [System.IO.File]::Exists($src)) "staged source should be moved away"
  } finally {
    if (Test-Path -LiteralPath $tmp) {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

$isWindowsHost = ($env:OS -eq "Windows_NT") -or ((Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) -and $IsWindows)

Run-Test "Invoke-StagedVersionCheck kills stalled child within bounded timeout" {
  $tmp = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("sweep-timeout-test-" + [System.Guid]::NewGuid().ToString("N"))
  try {
    [System.IO.Directory]::CreateDirectory($tmp) | Out-Null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($isWindowsHost) {
      $exe = (Get-Process -Id $PID).Path
      $res = Invoke-StagedVersionCheck -ExecutablePath $exe -TimeoutMs 500 -Arguments "-NoProfile -Command Write-Output starting; Start-Sleep -Seconds 15"
    } else {
      $stallPath = Join-Path -Path $tmp -ChildPath "stall.sh"
      [System.IO.File]::WriteAllText($stallPath, "#!/bin/sh`necho starting`nsleep 15`n")
      & chmod +x $stallPath
      $res = Invoke-StagedVersionCheck -ExecutablePath $stallPath -TimeoutMs 500
    }
    $sw.Stop()
    Assert-True (-not $res.Ok) "stalled probe should fail"
    Assert-True ($res.Output -like "*timed out*") "expected timeout message, got: $($res.Output)"
    Assert-True ($sw.ElapsedMilliseconds -lt 6000) "timeout probe took too long: $($sw.ElapsedMilliseconds)ms"
  } finally {
    if (Test-Path -LiteralPath $tmp) {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($isWindowsHost) {
  Add-Type -AssemblyName System.IO.Compression

  $testRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("sweep-install-ps1-test-" + [System.Guid]::NewGuid().ToString("N"))
  [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null

  function Write-FakeAsset([string]$Dir, [byte[]]$RawBytes, [switch]$BadChecksum) {
    [System.IO.Directory]::CreateDirectory($Dir) | Out-Null
    $gzPath = Join-Path -Path $Dir -ChildPath "sweep-win-x64.exe.gz"
    $outStream = [System.IO.File]::Create($gzPath)
    try {
      $gzStream = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionMode]::Compress)
      try {
        $gzStream.Write($RawBytes, 0, $RawBytes.Length)
      } finally {
        $gzStream.Dispose()
      }
    } finally {
      $outStream.Dispose()
    }
    $hash = if ($BadChecksum) {
      "0" * 64
    } else {
      (Get-FileHash -LiteralPath $gzPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [System.IO.File]::WriteAllText((Join-Path -Path $Dir -ChildPath "sweep-win-x64.exe.gz.sha256"), "$hash  sweep-win-x64.exe.gz`n")
  }

  # Obtain a real Windows executable that exits 0 on --version.
  $goodBinBytes = $null
  if ($TestBinaryPath -and (Test-Path -LiteralPath $TestBinaryPath)) {
    $goodBinBytes = [System.IO.File]::ReadAllBytes($TestBinaryPath)
  } else {
    $defaultEngine = Join-Path -Path $repoRoot -ChildPath "target\release\sweep-engine.exe"
    $debugEngine = Join-Path -Path $repoRoot -ChildPath "target\debug\sweep-engine.exe"
    if (Test-Path -LiteralPath $defaultEngine) {
      $goodBinBytes = [System.IO.File]::ReadAllBytes($defaultEngine)
    } elseif (Test-Path -LiteralPath $debugEngine) {
      $goodBinBytes = [System.IO.File]::ReadAllBytes($debugEngine)
    } else {
      $builtExe = Join-Path -Path $testRoot -ChildPath "stub-sweep.exe"
      Add-Type -TypeDefinition 'public class StubSweep { public static int Main(string[] args) { System.Console.WriteLine("0.9.9-stub"); return 0; } }' -OutputAssembly $builtExe -OutputType ConsoleApplication
      $goodBinBytes = [System.IO.File]::ReadAllBytes($builtExe)
    }
  }

  $releaseRoot = Join-Path -Path $testRoot -ChildPath "releases"
  Write-FakeAsset -Dir (Join-Path -Path $releaseRoot -ChildPath "download\v0.5.4") -RawBytes $goodBinBytes
  Write-FakeAsset -Dir (Join-Path -Path $releaseRoot -ChildPath "download\v0.5.4-badsum") -RawBytes $goodBinBytes -BadChecksum
  # Non-executable garbage bytes to test failed start / $? branch under strict mode.
  Write-FakeAsset -Dir (Join-Path -Path $releaseRoot -ChildPath "download\v0.5.4-broken") -RawBytes ([System.Text.Encoding]::UTF8.GetBytes("not-a-valid-pe-executable"))

  # Pick a free TCP port and serve $releaseRoot via background PowerShell runspace HttpListener.
  $tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $tcp.Start()
  $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
  $tcp.Stop()

  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:$port/")
  $listener.Start()

  $rs = [runspacefactory]::CreateRunspace()
  $rs.Open()
  $psServer = [powershell]::Create()
  $psServer.Runspace = $rs
  [void]$psServer.AddScript({
    param($HttpListener, $RootDir)
    while ($HttpListener.IsListening) {
      try {
        $ctx = $HttpListener.GetContext()
      } catch {
        break
      }
      try {
        $rel = $ctx.Request.Url.AbsolutePath.TrimStart("/").Replace("/", "\")
        $full = Join-Path -Path $RootDir -ChildPath $rel
        if ([System.IO.File]::Exists($full)) {
          $bytes = [System.IO.File]::ReadAllBytes($full)
          $ctx.Response.StatusCode = 200
          $ctx.Response.ContentLength64 = $bytes.Length
          $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
          $ctx.Response.StatusCode = 404
        }
      } finally {
        $ctx.Response.OutputStream.Close()
      }
    }
  }).AddArgument($listener).AddArgument($releaseRoot)
  $serverHandle = $psServer.BeginInvoke()

  $baseUrl = "http://127.0.0.1:$port"

  try {
    Run-Test "installs into directory with spaces and -NoPathUpdate leaves user PATH untouched" {
      $dir = Join-Path -Path $testRoot -ChildPath "install dir with spaces"
      $beforeUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
      $env:SWEEP_RELEASE_BASE_URL = $baseUrl
      try {
        & $installPs1 -Version "0.5.4" -InstallDir $dir -NoPathUpdate
      } finally {
        Remove-Item Env:SWEEP_RELEASE_BASE_URL -ErrorAction SilentlyContinue
      }
      $afterUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
      Assert-Equal $afterUserPath $beforeUserPath "User PATH should be unchanged with -NoPathUpdate"
      Assert-True (Test-Path -LiteralPath (Join-Path -Path $dir -ChildPath "sweep.exe") -PathType Leaf) "sweep.exe should be installed"
    }

    Run-Test "installs into directory with [brackets] using -LiteralPath and supports reinstall" {
      $dir = Join-Path -Path $testRoot -ChildPath "install [bracket] dir"
      $env:SWEEP_RELEASE_BASE_URL = $baseUrl
      try {
        & $installPs1 -Version "v0.5.4" -InstallDir $dir -NoPathUpdate
        $exe = Join-Path -Path $dir -ChildPath "sweep.exe"
        Assert-True (Test-Path -LiteralPath $exe -PathType Leaf) "first install into bracket dir failed"
        # Reinstall over existing file.
        & $installPs1 -Version "0.5.4" -InstallDir $dir -NoPathUpdate
        Assert-True (Test-Path -LiteralPath $exe -PathType Leaf) "reinstall into bracket dir failed"
      } finally {
        Remove-Item Env:SWEEP_RELEASE_BASE_URL -ErrorAction SilentlyContinue
      }
    }

    Run-Test "rejects checksum mismatch and preserves existing sweep.exe" {
      $dir = Join-Path -Path $testRoot -ChildPath "install-badsum"
      [System.IO.Directory]::CreateDirectory($dir) | Out-Null
      $existing = Join-Path -Path $dir -ChildPath "sweep.exe"
      [System.IO.File]::WriteAllText($existing, "existing-sentinel")
      $env:SWEEP_RELEASE_BASE_URL = $baseUrl
      $threw = $false
      try {
        & $installPs1 -Version "0.5.4-badsum" -InstallDir $dir -NoPathUpdate
      } catch {
        $threw = $_.Exception.Message -like "*checksum mismatch*"
      } finally {
        Remove-Item Env:SWEEP_RELEASE_BASE_URL -ErrorAction SilentlyContinue
      }
      Assert-True $threw "checksum mismatch should throw"
      Assert-Equal ([System.IO.File]::ReadAllText($existing)) "existing-sentinel" "existing binary must be preserved"
    }

    Run-Test "handles non-executable staged binary cleanly without strict-mode LASTEXITCODE error" {
      $dir = Join-Path -Path $testRoot -ChildPath "install-broken"
      [System.IO.Directory]::CreateDirectory($dir) | Out-Null
      $existing = Join-Path -Path $dir -ChildPath "sweep.exe"
      [System.IO.File]::WriteAllText($existing, "existing-working")
      $env:SWEEP_RELEASE_BASE_URL = $baseUrl
      $errMsg = ""
      try {
        & $installPs1 -Version "0.5.4-broken" -InstallDir $dir -NoPathUpdate
      } catch {
        $errMsg = $_.Exception.Message
      } finally {
        Remove-Item Env:SWEEP_RELEASE_BASE_URL -ErrorAction SilentlyContinue
      }
      Assert-True ($errMsg -like "*failed --version*") "expected failed --version error, got: $errMsg"
      Assert-True ($errMsg -notlike "*LASTEXITCODE*") "must not throw strict-mode LASTEXITCODE error"
      Assert-Equal ([System.IO.File]::ReadAllText($existing)) "existing-working" "existing binary must be preserved"
    }

    Run-Test "irm | iex style invocation preserves caller ErrorActionPreference and ProgressPreference" {
      $dir = Join-Path -Path $testRoot -ChildPath "install-iex"
      $origEap = "Continue"
      $origProg = "Continue"
      $ErrorActionPreference = $origEap
      $ProgressPreference = $origProg
      $env:SWEEP_RELEASE_BASE_URL = $baseUrl
      $env:SWEEP_VERSION = "0.5.4"
      $env:SWEEP_INSTALL_DIR = $dir
      try {
        # Invoke with -NoPathUpdate via scriptblock creation to avoid mutating runner User PATH.
        $sb = [scriptblock]::Create((Get-Content -LiteralPath $installPs1 -Raw))
        & $sb -NoPathUpdate
      } finally {
        Remove-Item Env:SWEEP_RELEASE_BASE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:SWEEP_VERSION -ErrorAction SilentlyContinue
        Remove-Item Env:SWEEP_INSTALL_DIR -ErrorAction SilentlyContinue
      }
      Assert-Equal ([string]$ErrorActionPreference) $origEap "ErrorActionPreference leaked"
      Assert-Equal ([string]$ProgressPreference) $origProg "ProgressPreference leaked"
      Assert-True (Test-Path -LiteralPath (Join-Path -Path $dir -ChildPath "sweep.exe") -PathType Leaf) "iex install should produce sweep.exe"
    }
  } finally {
    $listener.Stop()
    $listener.Close()
    try { $psServer.EndInvoke($serverHandle) } catch { }
    $psServer.Dispose()
    $rs.Dispose()
    if (Test-Path -LiteralPath $testRoot) {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "install.ps1 test summary: $($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) {
  exit 1
}
