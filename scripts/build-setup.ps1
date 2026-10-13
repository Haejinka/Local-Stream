param([string]$InnoCompilerPath)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $repoRoot 'plugin\CSXS\manifest.xml'
[xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath
$version = [string]$manifest.ExtensionManifest.ExtensionBundleVersion
if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Could not read a valid extension version from $manifestPath"
}

$packageScript = Join-Path $PSScriptRoot 'package-zxp.ps1'
& $packageScript
if ($LASTEXITCODE -ne 0) { throw 'The ZXP package could not be built and verified.' }
$zxpPath = Join-Path $repoRoot "dist\Local-Stream-$version.zxp"
if (-not (Test-Path -LiteralPath $zxpPath -PathType Leaf)) { throw "The ZXP package is missing: $zxpPath" }
$zxpSha256 = (Get-FileHash -LiteralPath $zxpPath -Algorithm SHA256).Hash.ToLowerInvariant()

$compilerCandidates = @()
if ($InnoCompilerPath) { $compilerCandidates += $InnoCompilerPath }
$compilerCandidates += @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
)
$compiler = $compilerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $compiler) {
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $compiler = $command.Source }
}
if (-not $compiler) { throw 'Inno Setup 6 or 7 is required to build the setup wizard. Install it from https://jrsoftware.org/isinfo.php.' }

$installerScript = Join-Path $PSScriptRoot 'Local-Stream-Setup.iss'
$installerPath = Join-Path $repoRoot "dist\Local-Stream-Setup-$version.exe"
& $compiler "/DAppVersion=$version" "/DZxpSha256=$zxpSha256" $installerScript
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw 'Inno Setup could not build the Local Stream setup wizard.'
}

$sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$installerPath.sha256"
$checksumLine = "$sha256  $(Split-Path -Leaf $installerPath)"
[System.IO.File]::WriteAllText($checksumPath, $checksumLine + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Output "Setup wizard created: $installerPath"
Write-Output "Checksum: $checksumPath"
Write-Output "SHA-256: $sha256"
