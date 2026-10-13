param([switch]$ToolsOnly)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path (Join-Path $PSScriptRoot '..\plugin')).Path
$backendSource = (Resolve-Path (Join-Path $PSScriptRoot '..\backend')).Path
$extensionRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$target = Join-Path $extensionRoot 'com.localstream.premiere'
$resolvedExtensionRoot = [System.IO.Path]::GetFullPath($extensionRoot)
$resolvedTarget = [System.IO.Path]::GetFullPath($target)

if (-not $ToolsOnly -and -not $resolvedTarget.StartsWith($resolvedExtensionRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to install outside the current user CEP extensions folder.'
}

$legacyAppData = Join-Path $env:LOCALAPPDATA 'LocalStream'
$appData = Join-Path $env:LOCALAPPDATA 'Adobe\CEP\extensionsData\com.localstream.premiere'
$legacyToolsRoot = Join-Path $legacyAppData 'tools'
$toolsRoot = Join-Path $appData 'tools'
$ffmpegRoot = Join-Path $toolsRoot 'ffmpeg'
$nodePathFile = Join-Path $toolsRoot 'node-path.txt'
$ffmpegPathFile = Join-Path $toolsRoot 'ffmpeg-path.txt'
$ffprobePathFile = Join-Path $toolsRoot 'ffprobe-path.txt'
$ytDlpPathFile = Join-Path $toolsRoot 'yt-dlp-path.txt'
New-Item -ItemType Directory -Path $appData -Force | Out-Null

foreach ($name in @('settings.json', 'jobs.json', 'auth-token.txt')) {
  $legacyFile = Join-Path $legacyAppData $name
  $currentFile = Join-Path $appData $name
  if ((Test-Path -LiteralPath $legacyFile -PathType Leaf) -and -not (Test-Path -LiteralPath $currentFile -PathType Leaf)) {
    Copy-Item -LiteralPath $legacyFile -Destination $currentFile
  }
}

if ((Test-Path -LiteralPath $legacyToolsRoot -PathType Container) -and -not (Test-Path -LiteralPath $toolsRoot -PathType Container)) {
  Copy-Item -LiteralPath $legacyToolsRoot -Destination $appData -Recurse -Force
}

function Update-MigratedToolPath($pathFile, $legacyRoot, $currentRoot) {
  if (-not (Test-Path -LiteralPath $pathFile -PathType Leaf)) { return }
  $savedPath = (Get-Content -Raw -LiteralPath $pathFile).Trim()
  $legacyPrefix = [System.IO.Path]::GetFullPath($legacyRoot).TrimEnd('\') + '\'
  if ($savedPath.StartsWith($legacyPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relativePath = $savedPath.Substring($legacyPrefix.Length)
    Set-Content -LiteralPath $pathFile -Value (Join-Path $currentRoot $relativePath) -Encoding Ascii -NoNewline
  }
}

Update-MigratedToolPath $nodePathFile $legacyToolsRoot $toolsRoot
Update-MigratedToolPath $ffmpegPathFile $legacyToolsRoot $toolsRoot
Update-MigratedToolPath $ffprobePathFile $legacyToolsRoot $toolsRoot

$settingsFile = Join-Path $appData 'settings.json'
if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
  try {
    $settings = Get-Content -Raw -LiteralPath $settingsFile | ConvertFrom-Json
    $legacyTemp = Join-Path $legacyAppData 'Temp'
    if ($settings.tempFolder -and [System.IO.Path]::GetFullPath([string]$settings.tempFolder).Equals([System.IO.Path]::GetFullPath($legacyTemp), [System.StringComparison]::OrdinalIgnoreCase)) {
      $settings.tempFolder = Join-Path $appData 'Temp'
      $json = $settings | ConvertTo-Json -Depth 10
      [System.IO.File]::WriteAllText($settingsFile, $json, [System.Text.UTF8Encoding]::new($false))
    }
  } catch { throw "Could not migrate Local Stream settings: $($_.Exception.Message)" }
}

New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

function Test-Node20($executable) {
  if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $false }
  try {
    $versionText = (& $executable --version 2>$null)
    $nativeExitCode = $LASTEXITCODE
    $match = [regex]::Match([string]$versionText, '^v?(\d+)\.')
    return ($nativeExitCode -eq 0 -and $match.Success -and [int]$match.Groups[1].Value -ge 20)
  } catch { return $false }
}

function Get-ResponseBodyText($response) {
  if ($response.Content -is [byte[]]) {
    return [System.Text.Encoding]::UTF8.GetString($response.Content)
  }
  return [string]$response.Content
}

function Get-VerifiedSha256($checksumText, $fileName) {
  if ($fileName) {
    $escapedName = [regex]::Escape($fileName)
    $line = ($checksumText -split "`r?`n" | Where-Object { $_ -match ($escapedName + '$') } | Select-Object -First 1)
    if ($line) {
      $hash = [regex]::Match($line, '(?i)\b[0-9a-f]{64}\b').Value
      if ($hash) { return $hash.ToLowerInvariant() }
    }
  }
  $singleHash = [regex]::Match($checksumText, '(?i)\b[0-9a-f]{64}\b').Value
  if ($singleHash) { return $singleHash.ToLowerInvariant() }
  throw "Could not read the SHA-256 checksum for $fileName."
}

$setupRoot = Join-Path $env:TEMP ('LocalStreamSetup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $setupRoot -Force | Out-Null

$savedNodePath = if (Test-Path -LiteralPath $nodePathFile -PathType Leaf) { (Get-Content -Raw -LiteralPath $nodePathFile).Trim() } else { '' }
$portableNodePath = Join-Path $toolsRoot 'node\node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$nodePath = if ($savedNodePath -and (Test-Node20 $savedNodePath)) { $savedNodePath }
  elseif (Test-Node20 $portableNodePath) { $portableNodePath }
  elseif ($nodeCommand -and (Test-Node20 $nodeCommand.Source)) { $nodeCommand.Source }
  else { '' }
if (-not $nodePath) {
  Write-Output 'Installing the portable Node.js runtime…'
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $release = $releases | Where-Object { $_.lts -and $_.version -match '^v(2[0-9])\.' } | Select-Object -First 1
  if (-not $release) { throw 'Could not find a supported Node.js LTS release.' }
  $nodeVersion = [string]$release.version
  $nodeArchive = "node-$nodeVersion-win-x64.zip"
  $nodeBase = "https://nodejs.org/dist/$nodeVersion"
  $nodeZip = Join-Path $setupRoot $nodeArchive
  Invoke-WebRequest -Uri "$nodeBase/$nodeArchive" -OutFile $nodeZip -UseBasicParsing -TimeoutSec 180
  $nodeChecksums = Get-ResponseBodyText (Invoke-WebRequest -Uri "$nodeBase/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30)
  $expectedNodeHash = Get-VerifiedSha256 $nodeChecksums $nodeArchive
  $actualNodeHash = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualNodeHash -ne $expectedNodeHash) { throw 'The Node.js download failed SHA-256 verification.' }

  $nodeExtract = Join-Path $setupRoot 'node-extract'
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
  $nodeExecutable = Get-ChildItem -Path $nodeExtract -Filter node.exe -File -Recurse | Select-Object -First 1
  if (-not $nodeExecutable) { throw 'The Node.js archive did not contain node.exe.' }
  $nodeInstall = Join-Path $toolsRoot 'node'
  New-Item -ItemType Directory -Path $nodeInstall -Force | Out-Null
  Copy-Item -Path (Join-Path $nodeExecutable.DirectoryName '*') -Destination $nodeInstall -Recurse -Force
  $nodePath = Join-Path $nodeInstall 'node.exe'
  if (-not (Test-Node20 $nodePath)) { throw 'The installed Node.js runtime did not pass the version check.' }
}
Set-Content -LiteralPath $nodePathFile -Value $nodePath -Encoding Ascii -NoNewline

$ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$ffprobeCommand = Get-Command ffprobe.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$savedFfmpegPath = if (Test-Path -LiteralPath $ffmpegPathFile -PathType Leaf) { (Get-Content -Raw -LiteralPath $ffmpegPathFile).Trim() } else { '' }
$savedFfprobePath = if (Test-Path -LiteralPath $ffprobePathFile -PathType Leaf) { (Get-Content -Raw -LiteralPath $ffprobePathFile).Trim() } else { '' }
$ffmpegPath = if ($savedFfmpegPath -and (Test-Path -LiteralPath $savedFfmpegPath -PathType Leaf)) { $savedFfmpegPath } elseif ($ffmpegCommand) { $ffmpegCommand.Source } else { '' }
$ffprobePath = if ($savedFfprobePath -and (Test-Path -LiteralPath $savedFfprobePath -PathType Leaf)) { $savedFfprobePath } elseif ($ffprobeCommand) { $ffprobeCommand.Source } else { '' }
if (-not $ffmpegPath -or -not $ffprobePath) {
  Write-Output 'Installing the portable FFmpeg and FFprobe tools…'
  $ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  $ffmpegArchive = 'ffmpeg-release-essentials.zip'
  $ffmpegZip = Join-Path $setupRoot $ffmpegArchive
  Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing -TimeoutSec 300
  $ffmpegChecksum = Get-ResponseBodyText (Invoke-WebRequest -Uri "$ffmpegUrl.sha256" -UseBasicParsing -TimeoutSec 30)
  $expectedFfmpegHash = Get-VerifiedSha256 $ffmpegChecksum $ffmpegArchive
  $actualFfmpegHash = (Get-FileHash -LiteralPath $ffmpegZip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualFfmpegHash -ne $expectedFfmpegHash) { throw 'The FFmpeg download failed SHA-256 verification.' }

  $ffmpegExtract = Join-Path $setupRoot 'ffmpeg-extract'
  Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegExtract -Force
  $ffmpegExecutable = Get-ChildItem -Path $ffmpegExtract -Filter ffmpeg.exe -File -Recurse | Select-Object -First 1
  $ffprobeExecutable = Get-ChildItem -Path $ffmpegExtract -Filter ffprobe.exe -File -Recurse | Select-Object -First 1
  if (-not $ffmpegExecutable -or -not $ffprobeExecutable) { throw 'The FFmpeg archive did not contain both required tools.' }

  $ffmpegBin = Join-Path $ffmpegRoot 'bin'
  New-Item -ItemType Directory -Path $ffmpegBin -Force | Out-Null
  Copy-Item -LiteralPath $ffmpegExecutable.FullName -Destination (Join-Path $ffmpegBin 'ffmpeg.exe') -Force
  Copy-Item -LiteralPath $ffprobeExecutable.FullName -Destination (Join-Path $ffmpegBin 'ffprobe.exe') -Force
  $ffmpegBuildRoot = Split-Path -Parent $ffmpegExecutable.DirectoryName
  Get-ChildItem -Path $ffmpegBuildRoot -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|README)' } | Copy-Item -Destination $ffmpegRoot -Force
  $ffmpegPath = Join-Path $ffmpegBin 'ffmpeg.exe'
  $ffprobePath = Join-Path $ffmpegBin 'ffprobe.exe'
}
Set-Content -LiteralPath $ffmpegPathFile -Value $ffmpegPath -Encoding Ascii -NoNewline
Set-Content -LiteralPath $ffprobePathFile -Value $ffprobePath -Encoding Ascii -NoNewline

$savedYtDlpPath = if (Test-Path -LiteralPath $ytDlpPathFile -PathType Leaf) { (Get-Content -Raw -LiteralPath $ytDlpPathFile).Trim() } else { '' }
$pathYtDlp = Get-Command yt-dlp.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$portableYtDlpPath = Join-Path $toolsRoot 'yt-dlp\yt-dlp.exe'
$ytDlpPath = if ($savedYtDlpPath -and (Test-Path -LiteralPath $savedYtDlpPath -PathType Leaf)) { $savedYtDlpPath }
  elseif (Test-Path -LiteralPath $portableYtDlpPath -PathType Leaf) { $portableYtDlpPath }
  elseif ($pathYtDlp) { $pathYtDlp.Source }
  else { '' }
if (-not $ytDlpPath) {
  Write-Output 'Installing the official yt-dlp downloader…'
  $ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  $ytDlpChecksumUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS'
  $ytDlpArchive = Join-Path $setupRoot 'yt-dlp.exe'
  Invoke-WebRequest -Uri $ytDlpUrl -OutFile $ytDlpArchive -UseBasicParsing -TimeoutSec 180
  $ytDlpChecksums = Get-ResponseBodyText (Invoke-WebRequest -Uri $ytDlpChecksumUrl -UseBasicParsing -TimeoutSec 30)
  $expectedYtDlpHash = Get-VerifiedSha256 $ytDlpChecksums 'yt-dlp.exe'
  $actualYtDlpHash = (Get-FileHash -LiteralPath $ytDlpArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualYtDlpHash -ne $expectedYtDlpHash) { throw 'The yt-dlp download failed SHA-256 verification.' }
  $ytDlpDirectory = Split-Path -Parent $portableYtDlpPath
  New-Item -ItemType Directory -Path $ytDlpDirectory -Force | Out-Null
  Copy-Item -LiteralPath $ytDlpArchive -Destination $portableYtDlpPath -Force
  $ytDlpPath = $portableYtDlpPath
}
Set-Content -LiteralPath $ytDlpPathFile -Value $ytDlpPath -Encoding Ascii -NoNewline

$healthUri = 'http://127.0.0.1:47831/api/health'
$jobsUri = 'http://127.0.0.1:47831/api/jobs'
$runningBackend = $false
try {
  $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
  $runningBackend = ($health.name -eq 'Local Stream' -and $health.ready -eq $true)
} catch { }
if ($runningBackend -and -not $ToolsOnly) {
  $tokenFile = Join-Path $appData 'auth-token.txt'
  if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw 'The Local Stream backend is running, but its local token is missing. Close the backend and retry the update.' }
  $authToken = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
  if ($authToken.Length -lt 32) { throw 'The Local Stream backend token is invalid. Close the backend and retry the update.' }
  try {
    $activeJobs = Invoke-RestMethod -Uri $jobsUri -Headers @{ Authorization = "Bearer $authToken" } -TimeoutSec 4
  } catch {
    throw 'Could not check the Local Stream download queue. Close the backend and retry the update.'
  }
  if (@($activeJobs | Where-Object { $_.status -in @('queued', 'downloading', 'processing') }).Count -gt 0) {
    throw 'A Local Stream download is active. Wait for it to finish, then run the installer again.'
  }
  $installedServerPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedTarget 'backend\server.mjs'))
  $listeningPids = @(Get-NetTCPConnection -LocalPort 47831 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  $serverProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and (
      $_.CommandLine.IndexOf($installedServerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ($listeningPids -contains $_.ProcessId -and $_.CommandLine -match 'server\.mjs')
    )
  }
  foreach ($serverProcess in $serverProcesses) {
    Stop-Process -Id $serverProcess.ProcessId -Force
    Wait-Process -Id $serverProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }
}

if (-not $ToolsOnly) {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
  $backendTarget = Join-Path $target 'backend'
  New-Item -ItemType Directory -Path $backendTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $backendSource '*') -Destination $backendTarget -Recurse -Force

  $debugKey = 'HKCU:\Software\Adobe\CSXS.12'
  New-Item -Path $debugKey -Force | Out-Null
  New-ItemProperty -Path $debugKey -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}

$resolvedSetupRoot = [System.IO.Path]::GetFullPath($setupRoot)
$resolvedTempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
if ($resolvedSetupRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path -Leaf $resolvedSetupRoot).StartsWith('LocalStreamSetup-', [System.StringComparison]::OrdinalIgnoreCase)) {
  Remove-Item -LiteralPath $resolvedSetupRoot -Recurse -Force
}

if ($ToolsOnly) {
  Write-Output 'Local Stream runtime tools are ready.'
  Write-Output "Node.js, FFmpeg, FFprobe, and yt-dlp are stored in: $toolsRoot"
  Write-Output 'No CEP files or Premiere settings were changed.'
} else {
  Write-Output "Installed Local Stream CEP panel and backend to: $target"
  Write-Output 'Local Stream will start its backend and load its token when the panel opens.'
  Write-Output "Settings, history, the backend token, Node.js, FFmpeg, FFprobe, and yt-dlp are stored in: $appData"
  Write-Output 'Enabled unsigned CEP 12 extensions for this Windows user.'
  Write-Output 'Restart Premiere Pro once to load the updated panel.'
}
