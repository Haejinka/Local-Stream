# Contributing

Thanks for helping improve Local Stream. Issues and pull requests are welcome.

## Development setup

1. Install Node.js 20 or later and FFmpeg/FFprobe.
2. Clone the repository and run `scripts\install-cep.cmd` to install the development panel, or use `npm start` to run only the local backend.
3. Add your own YouTube Data API v3 key in the panel Settings. Never commit personal API keys, backend tokens, local settings, or signing credentials.

## Checks

Run `npm test` before submitting backend or media-processing changes. The tests exercise the local API and media pipeline but cannot replace a manual test in Premiere's CEP runtime. For panel changes, install the extension, restart Premiere, and check search, preview, trimming, download progress, export, and automatic bin import where relevant.

## Pull requests

- Describe the user-visible change and how you checked it.
- Keep changes focused and update README or setup documentation when behavior changes.
- Do not include downloaded runtime binaries, local data, API keys, user cookies, generated certificates, or private signing keys.
- Respect the MIT license and applicable YouTube API terms and media rights.
