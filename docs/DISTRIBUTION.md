# ZXP distribution

## Build

From the repository root, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-zxp.ps1
```

The script downloads Adobe ZXPSignCmd into `%LOCALAPPDATA%\LocalStream\tools`, copies the CEP extension and its sibling backend into a temporary staging folder, signs the staged extension, and verifies the result. The package is written to `dist\Local-Stream-0.2.1.zxp`.

On first use, the script creates a self-signed publisher certificate under `%LOCALAPPDATA%\LocalStream\certs`, generates a strong password, and stores that password protected with Windows DPAPI. The password cache is readable only by the same Windows account on the same computer. Never commit the `.p12`, DPAPI cache, or password. The package script intentionally excludes the developer installer, local settings, API keys, backend token, runtime tools, and repository documentation from the ZXP.

To use a separate publisher certificate, pass its P12 path with `-CertificatePath`, then enter its password when prompted. The P12 remains outside the repository.

## Signing and trust

A self-signed certificate lets CEP installers verify that a ZXP is internally signed and unchanged; it does not prove that Adobe or a certificate authority verified the publisher's identity. Recipients should obtain packages from a trusted release source and compare any published checksums. For a public production release, follow Adobe's current signing and distribution guidance and use a publisher identity suitable for the project.

Adobe's packaging resources and tool are available in [Adobe CEP Resources](https://github.com/Adobe-CEP/CEP-Resources). Adobe's [Package, Distribute, and Install guide](https://github.com/Adobe-CEP/Getting-Started-guides/tree/master/Package%20Distribute%20Install) describes ZXP packaging, signing, and verification.

## Install

Install the ZXP using a CEP-compatible installer. Then run `scripts\setup-tools.cmd` to install the local processing runtimes without changing the installed panel. Restart Premiere and open **Window → Extensions (Legacy) → Local Stream**. The detailed steps and troubleshooting are in [INSTALLATION.md](INSTALLATION.md).

## Release checklist

- Review the source diff and confirm no API key, backend token, signing certificate, or signing password is staged.
- Build the ZXP with a private certificate stored outside the checkout.
- Verify the ZXP with ZXPSignCmd (the build script does this after signing).
- Test install and launch on a clean Windows account with the supported Premiere version and CEP 12.
- Publish the ZXP and a SHA-256 checksum with the release notes. Do not publish the private P12 or password.
