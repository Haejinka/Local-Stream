# Windows distribution

## Build

On Windows, install Inno Setup 6.3 or 7, then run from the repository root:

```powershell
.\scripts\build-setup.cmd
```

The build script first signs and verifies the versioned ZXP, then compiles `scripts\Local-Stream-Setup.iss` into `dist\Local-Stream-Setup-<version>.exe` and writes a matching `.sha256` sidecar. The first build downloads Adobe ZXPSignCmd and creates a self-signed certificate with a generated password protected by Windows DPAPI in local app data. Keep the private certificate and password cache outside the repository.

The wizard bundles the signed ZXP and the setup helper scripts. At install time it asks Adobe's Unified Plugin Installer (included with Creative Cloud Desktop) to install the package. It provisions Node.js, FFmpeg, FFprobe, and yt-dlp as needed, verifying published SHA-256 checksums. Runtime tools are downloaded from their project/vendor release endpoints and stored under the user's Local Stream data directory. UPIA itself is not bundled.

The setup installer is per-user and does not enable CEP developer mode. It requires an installed Creative Cloud Desktop app with Unified Plugin Installer and an internet connection when media tools are missing. The .exe is currently not Authenticode-signed, so Windows SmartScreen may display a warning. Signing the installer with a trusted code-signing certificate would reduce that warning for end users.

## Signing and trust

A self-signed extension certificate signs the ZXP so Adobe's installer and CEP can verify that the package has not changed. It does not establish a trusted publisher identity; recipients should download from a trusted release source and compare the published SHA-256 checksum. The certificate currently has a finite validity period and should be renewed and the package rebuilt before expiry. For a public production release, use a publisher identity and timestamping setup appropriate for the project.

Adobe documents the ZXP signing, verification, and installation flows in its [Package, Distribute, Install guide](https://github.com/Adobe-CEP/Getting-Started-guides/blob/master/Package%20Distribute%20Install/readme.md) and describes UPIA as the replacement for ExManCmd in its [plugin installer announcement](https://blog.developer.adobe.com/en/publish/2021/06/new-command-line-tool-for-plugin-installation-replaces-exmancmd).

## Manual installation

The setup wizard is the recommended user route. For manual installs, install the ZXP through Adobe's Unified Plugin Installer or another current CEP-compatible installer. To prepare runtime tools from a repository checkout, run `scripts\setup-tools.cmd`. See [INSTALLATION.md](INSTALLATION.md) for user steps and troubleshooting.

## Release checklist

- Review the source diff and confirm no API key, backend token, signing certificate, or signing password is staged.
- Build the ZXP and setup EXE with `scripts\build-setup.cmd` on Windows.
- Verify the ZXP signature and record the setup EXE SHA-256 checksum.
- Test installation and launch on a clean Windows account with Adobe Creative Cloud Desktop and a supported Premiere Pro version.
- Publish the ZXP and setup EXE with the checksum and release notes. Do not publish the private P12 or password.
