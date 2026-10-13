param(
  [Parameter(Mandatory = $true)][string]$ZxpPath,
  [Parameter(Mandatory = $true)][string]$ExpectedZxpSha256,
  [Parameter(Mandatory = $true)][string]$ToolSetupScriptPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
$script:SetupLogPath = [System.IO.Path]::GetFullPath($LogPath)
$script:SetupWorkspace = ''

function Write-SetupLog([string]$message) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [System.IO.File]::AppendAllText($script:SetupLogPath, "[$stamp] $message`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Assert-ChildPath([string]$root, [string]$candidate, [string]$description) {
  $fullRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $fullCandidate = [System.IO.Path]::GetFullPath($candidate)
  if (-not $fullCandidate.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected $description path."
  }
  return $fullCandidate
}

$exitCode = 0
try {
  $logDirectory = Split-Path -Parent $script:SetupLogPath
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  [System.IO.File]::WriteAllText($script:SetupLogPath, '', [System.Text.UTF8Encoding]::new($false))
  Write-SetupLog 'Starting Local Stream setup.'

  if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) {
    throw 'Close Adobe Premiere Pro before installing Local Stream, then run this setup again.'
  }
  foreach ($requiredPath in @($ZxpPath, $ToolSetupScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "A required setup file is missing: $requiredPath" }
  }

  $expectedHash = $ExpectedZxpSha256.Trim().ToLowerInvariant()
  if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw 'The setup package does not contain a valid ZXP checksum.' }
  $actualHash = (Get-FileHash -LiteralPath $ZxpPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw 'The ZXP package failed its SHA-256 integrity check.' }
  Write-SetupLog "ZXP package integrity check passed: $actualHash"

  $upiRelativePath = 'Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
  $upiPath = @($env:ProgramW6432, ${env:ProgramFiles}, ${env:ProgramFiles(x86)}) |
    Where-Object { $_ } |
    ForEach-Object { Join-Path $_ $upiRelativePath } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not $upiPath) {
    throw 'Adobe Creative Cloud Unified Plugin Installer is missing. Install or update the Creative Cloud desktop app, then run setup again.'
  }

  $workspaceParent = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
  $script:SetupWorkspace = Join-Path $workspaceParent ('LocalStreamWizard-' + [Guid]::NewGuid().ToString('N'))
  $workspacePath = Assert-ChildPath $workspaceParent $script:SetupWorkspace 'temporary workspace'
  New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null

  $payloadRoot = Join-Path $workspacePath 'payload'
  $pluginRoot = Join-Path $payloadRoot 'plugin'
  $backendRoot = Join-Path $payloadRoot 'backend'
  $scriptsRoot = Join-Path $payloadRoot 'scripts'
  New-Item -ItemType Directory -Path $pluginRoot, $scriptsRoot -Force | Out-Null

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory([System.IO.Path]::GetFullPath($ZxpPath), $pluginRoot)
  $manifestPath = Join-Path $pluginRoot 'CSXS\manifest.xml'
  $pluginBackendPath = Join-Path $pluginRoot 'backend\server.mjs'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $pluginBackendPath -PathType Leaf)) {
    throw 'The signed package does not contain the Local Stream panel and backend.'
  }
  [xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath
  if ($manifest.ExtensionManifest.ExtensionBundleId -ne 'com.localstream.bundle' -or
      -not ($manifest.ExtensionManifest.ExtensionList.Extension | Where-Object { $_.Id -eq 'com.localstream.premiere' })) {
    throw 'The extension manifest does not identify Local Stream.'
  }

  # The runtime provisioner expects the source repository layout. Re-create that
  # small layout from the signed payload so its -ToolsOnly mode remains reusable.
  New-Item -ItemType Directory -Path $backendRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $pluginRoot 'backend\*') -Destination $backendRoot -Recurse -Force
  Copy-Item -LiteralPath $ToolSetupScriptPath -Destination (Join-Path $scriptsRoot 'install-cep.ps1') -Force
  Write-SetupLog 'Provisioning Node.js, FFmpeg, FFprobe, and yt-dlp.'
  $toolOutput = & (Join-Path $scriptsRoot 'install-cep.ps1') -ToolsOnly 2>&1
  foreach ($line in $toolOutput) { Write-SetupLog ([string]$line) }
  if (-not ($toolOutput | Where-Object { ([string]$_).Contains('Local Stream runtime tools are ready.') })) {
    throw 'The runtime setup did not report completion. Check the setup log for details.'
  }

  Write-SetupLog "Installing the signed CEP package through Adobe Unified Plugin Installer: $upiPath"
  $upiOutput = & $upiPath '--install' ([System.IO.Path]::GetFullPath($ZxpPath)) 2>&1
  $upiExitCode = $LASTEXITCODE
  foreach ($line in $upiOutput) { Write-SetupLog ([string]$line) }
  if ($upiExitCode -ne 0) { throw "Adobe's extension installer returned exit code $upiExitCode." }

  Write-SetupLog 'Local Stream panel and runtime tools installed successfully.'
  Write-Output 'Local Stream setup completed.'
} catch {
  try { Write-SetupLog "ERROR: $($_.Exception.Message)" } catch { }
  $exitCode = 1
} finally {
  if ($script:SetupWorkspace -and (Test-Path -LiteralPath $script:SetupWorkspace -PathType Container)) {
    try {
      $workspaceParent = [System.IO.Path]::GetFullPath($env:TEMP)
      $safeWorkspace = Assert-ChildPath $workspaceParent $script:SetupWorkspace 'temporary cleanup'
      if ((Split-Path -Leaf $safeWorkspace) -notlike 'LocalStreamWizard-*') { throw 'Unexpected setup workspace name.' }
      Remove-Item -LiteralPath $safeWorkspace -Recurse -Force
    } catch { try { Write-SetupLog "The temporary setup folder was retained: $($_.Exception.Message)" } catch { } }
  }
}

exit $exitCode
