param(
  [string]$CertificatePath,
  [string]$OutputPath,
  [string]$CertificateCountryCode = 'US',
  [string]$CertificateState = 'NA',
  [string]$PublisherOrganization = 'Local Stream Project',
  [string]$PublisherName = 'Local Stream Community'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $repoRoot 'plugin\CSXS\manifest.xml'
[xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath
$version = [string]$manifest.ExtensionManifest.ExtensionBundleVersion
if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Could not read a valid extension bundle version from $manifestPath"
}

$localStreamRoot = Join-Path $env:LOCALAPPDATA 'LocalStream'
$toolDirectory = Join-Path $localStreamRoot 'tools'
$certificateDirectory = Join-Path $localStreamRoot 'certs'
$signTool = Join-Path $toolDirectory 'ZXPSignCmd.exe'
$certificatePasswordCache = Join-Path $certificateDirectory 'local-stream-signing-password.dpapi'
if (-not $CertificatePath) {
  $CertificatePath = Join-Path $certificateDirectory 'local-stream-signing.p12'
}
if (-not $OutputPath) {
  $OutputPath = Join-Path $repoRoot "dist\Local-Stream-$version.zxp"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath = Join-Path $repoRoot $OutputPath
}

New-Item -ItemType Directory -Path $toolDirectory, $certificateDirectory, (Split-Path -Parent $OutputPath) -Force | Out-Null

function Invoke-ZxpSignCommand {
  param([string[]]$CommandArguments)
  Push-Location $toolDirectory
  try {
    & $signTool @CommandArguments | Out-Host
    $commandExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return $commandExitCode
}

if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) {
  $downloadUrl = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe'
  $temporaryDownload = Join-Path $toolDirectory 'ZXPSignCmd.exe.download'
  Write-Output 'Downloading Adobe ZXPSignCmd...'
  Invoke-WebRequest -Uri $downloadUrl -OutFile $temporaryDownload -UseBasicParsing
  if (-not (Test-Path -LiteralPath $temporaryDownload -PathType Leaf) -or (Get-Item -LiteralPath $temporaryDownload).Length -lt 1MB) {
    Remove-Item -LiteralPath $temporaryDownload -Force -ErrorAction SilentlyContinue
    throw 'The downloaded ZXPSignCmd executable is missing or unexpectedly small.'
  }
  Move-Item -LiteralPath $temporaryDownload -Destination $signTool -Force
}

if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
  Write-Output "Creating a self-signed packaging certificate at: $CertificatePath"
  $randomBytes = New-Object byte[] 32
  $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $randomGenerator.GetBytes($randomBytes)
    $plainPassword = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
  } finally {
    $randomGenerator.Dispose()
  }
  $certificateExitCode = Invoke-ZxpSignCommand @('-selfSignedCert', $CertificateCountryCode, $CertificateState, $PublisherOrganization, $PublisherName, $plainPassword, $CertificatePath, '-validityDays', '3650')
  if ($certificateExitCode -ne 0 -or -not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
    throw 'ZXPSignCmd could not create the local signing certificate.'
  }
  $securePassword = ConvertTo-SecureString -String $plainPassword -AsPlainText -Force
  ConvertTo-SecureString -String $plainPassword -AsPlainText -Force |
    ConvertFrom-SecureString |
    Set-Content -LiteralPath $certificatePasswordCache -Encoding Ascii
} elseif (Test-Path -LiteralPath $certificatePasswordCache -PathType Leaf) {
  try {
    $securePassword = (Get-Content -Raw -LiteralPath $certificatePasswordCache).Trim() | ConvertTo-SecureString
  } catch {
    throw "Could not read the DPAPI-protected certificate password cache for this Windows account: $certificatePasswordCache"
  }
  $password = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($password) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($password) }
} else {
  $securePassword = Read-Host 'Enter the password for the signing certificate' -AsSecureString
  $password = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($password) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($password) }
}

$stagePath = Join-Path (Split-Path -Parent $OutputPath) (".zxp-stage-" + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
  Copy-Item -Path (Join-Path $repoRoot 'plugin\*') -Destination $stagePath -Recurse -Force
  $backendStage = Join-Path $stagePath 'backend'
  New-Item -ItemType Directory -Path $backendStage -Force | Out-Null
  Copy-Item -Path (Join-Path $repoRoot 'backend\*') -Destination $backendStage -Recurse -Force

  Write-Output "Signing Local Stream $version..."
  $signExitCode = Invoke-ZxpSignCommand @('-sign', $stagePath, $OutputPath, $CertificatePath, $plainPassword)
  if ($signExitCode -ne 0 -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw 'ZXPSignCmd failed to sign the ZXP package.'
  }

  Write-Output 'Verifying the signed ZXP...'
  $verifyExitCode = Invoke-ZxpSignCommand @('-verify', $OutputPath)
  if ($verifyExitCode -ne 0) { throw 'ZXPSignCmd could not verify the generated ZXP.' }
  $sha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output "ZXP created and verified: $OutputPath"
  Write-Output "SHA-256: $sha256"
  Write-Output "Signing files remain outside the repository: $certificateDirectory"
} finally {
  if (Test-Path -LiteralPath $stagePath -PathType Container) {
    $resolvedStage = [System.IO.Path]::GetFullPath($stagePath)
    $resolvedDist = [System.IO.Path]::GetFullPath((Split-Path -Parent $OutputPath)).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedStage).StartsWith('.zxp-stage-', [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
  }
}
