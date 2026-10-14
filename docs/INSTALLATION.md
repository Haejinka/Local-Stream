# Windows setup

Local Stream supports Adobe Premiere Pro 25.6 or later with CEP 12. For regular users, the Windows setup wizard installs the signed panel and prepares the local media tools. A YouTube Data API v3 key is still needed for search.

## Option A: setup wizard (recommended)

1. Download and run `Local-Stream-Setup-0.2.3.exe` from the repository's [latest main branch](https://github.com/Haejinka/Local-Stream/raw/refs/heads/main/dist/Local-Stream-Setup-0.2.3.exe).
2. Keep Premiere Pro closed until setup finishes.
3. The wizard uses Adobe Creative Cloud's Unified Plugin Installer to install the signed ZXP and provisions Node.js, FFmpeg, FFprobe, and yt-dlp if they are not already available.
4. Start Premiere and open **Window → Extensions (Legacy) → Local Stream**.
5. Open Settings, add your YouTube Data API v3 key, and save.

The wizard needs the Creative Cloud desktop app and an internet connection. Missing media tools are downloaded and SHA-256 checked. It does not enable CEP developer mode. The setup EXE is not code-signed, so Windows may show a SmartScreen warning. If setup fails, see `%LOCALAPPDATA%\Adobe\CEP\extensionsData\com.localstream.premiere\installer.log`.

## Option B: install the ZXP manually

1. Download [the signed ZXP](https://github.com/Haejinka/Local-Stream/raw/refs/heads/main/dist/Local-Stream-0.2.3.zxp).
2. Install it using Adobe's Unified Plugin Installer (`UnifiedPluginInstallerAgent.exe --install <path-to-zxp>`) or a current CEP-compatible ZXP installer.
3. Run `scripts\setup-tools.cmd` from a local repository checkout to provision Node.js, FFmpeg, FFprobe, and yt-dlp.
4. Restart Premiere, open **Window → Extensions (Legacy) → Local Stream**, and enter your YouTube API key in Settings.

The Adobe installer ships with the Creative Cloud desktop app. It is normally located at `%ProgramFiles%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe`.

## Option C: install from source for development

1. Download or clone the repository.
2. Close Premiere Pro.
3. Run `scripts\install-cep.cmd`. This installs the panel and backend for the current Windows account and enables CEP 12 developer extensions for that account.
4. Open Premiere and select **Window → Extensions (Legacy) → Local Stream**.
5. In Settings, add your YouTube Data API v3 key and save.

The installer can use compatible Node.js 20+, FFmpeg/FFprobe, and yt-dlp tools already on `PATH`. If a tool is missing, it downloads a portable copy and verifies the published SHA-256 checksum. Tools are stored in `%LOCALAPPDATA%\Adobe\CEP\extensionsData\com.localstream.premiere\tools`.

## Create a YouTube Data API v3 key

1. In Google Cloud Console, create or choose a project.
2. Enable **YouTube Data API v3** for the project.
3. Create an API key under **APIs & Services → Credentials**.
4. Restrict the key to YouTube Data API v3 where Google's key restriction options allow it.
5. In Premiere's Local Stream panel, open Settings and paste the key into **YouTube Data API v3 key**, then save.

The key is stored in Local Stream's settings file on this computer. Do not add your personal key to source code, screenshots, issue reports, or commits. Search uses YouTube Data API quota; each search request and each paginated follow-up consumes quota under Google's current quota rules.

## What gets installed and where data lives

| Item | Location | Purpose |
| --- | --- | --- |
| CEP panel and backend | `%APPDATA%\Adobe\CEP\extensions\com.localstream.premiere` | Premiere extension files |
| Settings, API key, backend token, history, and runtime tools | `%LOCALAPPDATA%\Adobe\CEP\extensionsData\com.localstream.premiere` | Per-user app data |
| Default exports | `%USERPROFILE%\Videos\Local Stream` | Finished MP4 and MP3 files |
| ZXP signing certificate and password cache (developer only) | `%LOCALAPPDATA%\LocalStream\certs` | Private release signing data; never commit or distribute |

The backend listens only on `127.0.0.1:47831`. The panel starts it and reads its token automatically. You do not need to copy or configure the token. The developer installer migrates older settings and tools from `%LOCALAPPDATA%\LocalStream` when they exist.

## First export

1. Search for a YouTube video or music track, or open a local media file.
2. Select a search result to open its preview.
3. Wait for the duration to load. Drag the In and Out handles to set the clip; click or seek in the player to move the playhead.
4. Choose **Download video** or **Download audio**. You can also use the quick download button on a search result.
5. Follow the progress indicator in the panel. A completion notice appears when processing finishes.
6. The exported file is automatically imported into the active Premiere project in the `LocalStream Downloads` bin. Drag it from that bin to the timeline.

MP4 export can re-encode to H.264/AAC for compatibility and precise trims. MP3 export uses FFmpeg. Long or high-resolution conversions can take time; progress remains visible in the panel.

## Troubleshooting

### The panel is missing from Premiere

- For the setup wizard, confirm that Adobe Creative Cloud is installed and that setup completed successfully.
- For a manual ZXP install, confirm the installer reports success and supports CEP 12.
- For source installs, rerun `scripts\install-cep.cmd` and restart Premiere.
- Confirm Premiere Pro is version 25.6 or newer.

### Search says the API key is missing or invalid

- Check that the key was saved in Local Stream Settings.
- Confirm YouTube Data API v3 is enabled in the same Google Cloud project as the key.
- Review key restrictions and Google Cloud quota/errors.
- API key configuration is separate from the local backend token; the installer provisions the latter automatically.

### Backend connection is offline

- Open the Local Stream panel and wait briefly for the backend to start.
- Check that local security software has not blocked Node.js from listening on localhost.
- For development, `scripts\start-backend.cmd` can start the backend separately; don't launch a second copy while the panel's backend is already running.

### A download fails or a format needs conversion

- Run `scripts\setup-tools.cmd` from the repository to provision or repair Node.js, FFmpeg/FFprobe, and yt-dlp without reinstalling the panel.
- Check your network connection and the source video's availability and restrictions.
- Some videos block embedding or require sign-in; the **YouTube browser session** setting can use local browser cookies when enabled. Availability depends on the source and the user's logged-in browser session.
- Use media only when permitted by applicable terms and rights. Any written YouTube approval is specific to the operator and approved use.

### Premiere does not import the finished file

- Confirm an active Premiere project is open and the project is saved.
- Check that the file exists in the configured download location and that Premiere can access it.
- The panel reports import errors in its download status; a completed export remains on disk even if Premiere import fails.

## Removing the panel

Uninstall Local Stream from Windows **Installed apps** or remove `%APPDATA%\Adobe\CEP\extensions\com.localstream.premiere`. The app data folder contains settings, local job history, tools, and the YouTube key; remove it separately only if you also want to erase those data. Removing the panel does not remove exported media from your download folder or project bin.
