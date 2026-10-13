# Local Stream

**A local-first YouTube search, clip editor, and media export panel for Adobe Premiere Pro.**

Search with your own YouTube Data API v3 key, set an In and Out point, and export a Premiere-friendly video or audio file. Press Enter to search. Local Stream runs its processing backend on your Windows computer and adds completed exports to the `LocalStream Downloads` bin in the active Premiere project.

## Download

**[Download Local Stream 0.2.1 (ZXP)](https://github.com/Haejinka/Local-Stream/raw/refs/heads/main/dist/Local-Stream-0.2.1.zxp)**

Install the `.zxp` with a CEP-compatible ZXP installer. Then run `scripts\setup-tools.cmd` from the repository to set up the local processing tools, restart Premiere, and enter your own YouTube Data API v3 key in Settings. See the [Windows setup guide](docs/INSTALLATION.md) for the full steps.

## Features

- Search YouTube videos and music with official YouTube Data API v3 results and pagination.
- Preview videos in YouTube's embedded player, fall back to a local yt-dlp stream when embedding is blocked, and set In/Out points directly in the player.
- Export a selected range as H.264/AAC MP4 or MP3, with visible download progress and completion notices.
- Automatically import completed exports into the Premiere project's `LocalStream Downloads` bin, ready to drag onto the timeline.
- Browse local media through the same clip range and export workflow.
- Choose maximum video quality, enable formats that need encoding, optionally use local browser cookies when YouTube sign-in is required, and change the download folder.
- Keep the backend, settings, download queue, and processing on the local computer.

## Screenshots

### Search YouTube

![YouTube search results with download controls](docs/screenshots/search-results.png)

### Preview and set a clip range

![Player with integrated clip range and sticky download controls](docs/screenshots/clip-editor.png)

### Track completed exports

![Completed downloads ready for the Premiere timeline](docs/screenshots/downloads.png)

### Configure quality and download behavior

![Local Stream download quality and processing settings](docs/screenshots/settings-public.png)

### Add your own YouTube API key

![YouTube Data API key settings](docs/screenshots/settings-key-public.png)

## Requirements

- Windows 10 or 11.
- Adobe Premiere Pro 25.6 or later with CEP 12 support.
- A YouTube Data API v3 key for search.
- Internet access for YouTube search, preview, and source retrieval.
- Node.js 20+, FFmpeg, FFprobe, and yt-dlp. The setup scripts can provision these locally if they are not already installed.

## Quick start: install from source

1. Download or clone this repository.
2. Close Premiere Pro, then run `scripts\install-cep.cmd`.
3. Start Premiere and open **Window → Extensions (Legacy) → Local Stream**.
4. Open Settings, paste your YouTube Data API v3 key, and save.
5. Search, select a result, set the range, and choose **Download video** or **Download audio**.

See [the full Windows setup guide](docs/INSTALLATION.md) for API key creation, ZXP installation, tool setup, privacy, and troubleshooting.

## Build a ZXP for distribution

Run `scripts\package-zxp.cmd` (or `powershell -ExecutionPolicy Bypass -File scripts\package-zxp.ps1`). The first run downloads Adobe's ZXPSignCmd and creates a self-signed certificate with a generated password protected by Windows DPAPI in your local app data. The resulting package is written to `dist\Local-Stream-0.2.1.zxp`.

The private signing certificate and its Windows-user-encrypted password cache are kept outside this repository. A self-signed package may show a publisher trust prompt in a CEP installer. See [distribution notes](docs/DISTRIBUTION.md) before publishing a release.

## YouTube API key and media permissions

Create a key for **YouTube Data API v3** in Google Cloud Console, enable that API for the project, and enter the key only in Local Stream's Settings. The key is saved locally under `%LOCALAPPDATA%\Adobe\CEP\extensionsData\com.localstream.premiere`; it is not part of this source repository or ZXP. Search uses the official Data API. Follow Google's key security guidance and restrict the key to the YouTube Data API where possible.

The project provides media retrieval and conversion features. Operators are responsible for complying with YouTube's terms, any written approval required for their use case, copyright, and the rights attached to each source. Approval or access held by one operator does not transfer to other users of this open-source project.

## Local processing and privacy

The CEP panel starts its companion Node.js backend on `127.0.0.1:47831`. A random local bearer token authenticates panel requests. Settings, the token, tool paths, and job history live in `%LOCALAPPDATA%\Adobe\CEP\extensionsData\com.localstream.premiere`; exports default to `%USERPROFILE%\Videos\Local Stream`. No Local Stream account or remote Local Stream service is required. YouTube services and the configured media source remain external network services.

The setup scripts install the CEP panel under `%APPDATA%\Adobe\CEP\extensions\com.localstream.premiere`. They enable CEP 12's unsigned developer extension mode for the current Windows user. Restart Premiere after installing or updating.

## Development

Requirements and test instructions are in [CONTRIBUTING.md](CONTRIBUTING.md). To start the backend during development, run `npm start`. The automated test suite can be run with `npm test`; it does not simulate Premiere's CEP or ExtendScript runtime.

## Project structure

```text
backend/             Local HTTP API, settings, download queue, and media processing
plugin/              CEP 12 panel, Premiere bridge, and extension manifest
scripts/             Windows installer, runtime setup, and ZXP packaging
docs/                Setup, release notes, and product screenshots
test/                Automated backend and media processing tests
```

## License

Local Stream is available under the [MIT License](LICENSE).

## Adobe references

- [CEP 12 HTML Extension Cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md)
- [Adobe CEP resources and CSInterface.js](https://github.com/Adobe-CEP/CEP-Resources)
- [Adobe's Premiere Pro panel sample](https://github.com/Adobe-CEP/Samples/tree/master/PProPanel)
