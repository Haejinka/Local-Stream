import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  APP_VERSION, AUDIO_EXTENSIONS, DEFAULT_PORT, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS,
  appDataDir, atomicWriteJson, defaultSettings, formatTimestamp, getMediaInfo,
  decodeHtmlEntities, parseIsoDuration, readJson, resolveBinary, safeSettings, sanitizeFilename,
  toPublicJob, validateTrim, runProcess
} from './lib.mjs';

const dataDir = appDataDir();
const settingsFile = path.join(dataDir, 'settings.json');
const tokenFile = path.join(dataDir, 'auth-token.txt');
const historyFile = path.join(dataDir, 'jobs.json');
const toolPathDir = path.join(dataDir, 'tools');
const port = Number(process.env.LOCAL_STREAM_PORT || DEFAULT_PORT);
let settings = safeSettings(await readJson(settingsFile, defaultSettings()));
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(settings.outputFolder, { recursive: true });
await fs.mkdir(settings.tempFolder, { recursive: true });
await atomicWriteJson(settingsFile, settings);

const installedToolPaths = {};
for (const name of ['ffmpeg', 'ffprobe', 'yt-dlp']) {
  try { installedToolPaths[name] = (await fs.readFile(path.join(toolPathDir, `${name}-path.txt`), 'utf8')).replace(/^\uFEFF/, '').trim(); }
  catch { installedToolPaths[name] = ''; }
}

let token = process.env.LOCAL_STREAM_TOKEN || (await readJson(tokenFile, null));
if (typeof token !== 'string' || token.length < 32) {
  token = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
}
const tokenString = String(token).trim();
if (tokenString.length < 32) throw new Error('LOCAL_STREAM_TOKEN must contain at least 32 characters.');

const jobs = new Map();
const queue = [];
let activeId = null;
let activeController = null;
const recentRequests = new Map();
const persisted = await readJson(historyFile, []);
for (const job of Array.isArray(persisted) ? persisted : []) {
  if (!job?.id) continue;
  if (!['pending', 'added', 'failed', 'not-requested'].includes(job.projectImportStatus)) {
    job.projectImportStatus = job.status === 'completed' ? 'not-requested' : 'pending';
  }
  if (typeof job.projectImportError !== 'string') job.projectImportError = '';
  if (['queued', 'downloading', 'processing'].includes(job.status)) {
    job.status = 'failed';
    job.error = 'Backend restarted before this job completed. Select Retry to run it again.';
    job.progress = 0;
    job.updatedAt = new Date().toISOString();
  }
  jobs.set(job.id, job);
}
await pruneHistory();
await persistJobs();

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(payload);
}

function html(res, status, value) {
  const payload = Buffer.from(value, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function youtubePreviewHtml(videoId, origin) {
  const id = JSON.stringify(videoId);
  const playerOrigin = JSON.stringify(origin);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body,#player{width:100%;height:100%;margin:0;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:0}</style>
    </head><body><div id="player" aria-label="YouTube video preview"></div>
    <script>
      const videoId=${id};
      const youtubeOrigin=${playerOrigin};
      let player=null;
      let stateTimer=null;
      function report(){
        if(!player || typeof player.getDuration!=='function') return;
        parent.postMessage({type:'local-stream-player-state',videoId,duration:player.getDuration(),currentTime:player.getCurrentTime(),playerState:player.getPlayerState()},'*');
      }
      function onYouTubeIframeAPIReady(){
        player=new YT.Player('player',{videoId,playerVars:{controls:1,enablejsapi:1,playsinline:1,rel:0,origin:youtubeOrigin,widget_referrer:youtubeOrigin},events:{onReady(){report();stateTimer=setInterval(report,400)},onStateChange:report}});
      }
      const api=document.createElement('script');api.src='https://www.youtube.com/iframe_api';document.head.appendChild(api);
      addEventListener('message',event=>{
        if(event.source!==parent) return;
        const data=event.data;
        if(!data || data.type!=='local-stream-player-command' || data.videoId!==videoId || !player) return;
        if(data.command==='seek' && Number.isFinite(Number(data.seconds))) player.seekTo(Math.max(0,Number(data.seconds)),true);
        else if(data.command==='play') player.playVideo();
        else if(data.command==='pause') player.pauseVideo();
      });
      addEventListener('pagehide',()=>clearInterval(stateTimer));
    </script></body></html>`;
}

function replyError(res, status, message) {
  json(res, status, { error: String(message || 'Request failed.') });
}

function parseBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(tokenString);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function checkRateLimit(req) {
  const address = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const samples = (recentRequests.get(address) || []).filter((time) => now - time < 60_000);
  if (samples.length >= 180) return false;
  samples.push(now);
  recentRequests.set(address, samples);
  return true;
}

async function persistJobs() {
  const latest = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  await atomicWriteJson(historyFile, latest);
}

async function pruneHistory() {
  if (!settings.cleanupDays) return;
  const cutoff = Date.now() - settings.cleanupDays * 86_400_000;
  for (const [id, job] of jobs) {
    if (Date.parse(job.updatedAt || job.createdAt) < cutoff && !['queued', 'processing', 'downloading'].includes(job.status)) jobs.delete(id);
  }
}

function safeBinary(name) {
  const chosen = name === 'ffmpeg' ? settings.ffmpegPath : name === 'ffprobe' ? settings.ffprobePath : installedToolPaths[name];
  return resolveBinary(chosen || installedToolPaths[name], name);
}

function browserForYouTubeCookies() {
  if (process.platform !== 'win32') return 'chrome';
  try {
    const output = execFileSync('reg.exe', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'
    ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const progId = /ProgId\s+REG_SZ\s+([^\s]+)/i.exec(output)?.[1] || '';
    if (/MSEdgeHTM/i.test(progId)) return 'edge';
    if (/BraveHTML/i.test(progId)) return 'brave';
    if (/FirefoxURL/i.test(progId)) return 'firefox';
  } catch {}
  return 'chrome';
}

async function selectedSource(body) {
  if (!body || typeof body.path !== 'string' || body.path.length > 4096) throw Object.assign(new Error('Select a local media file first.'), { status: 400 });
  const extension = path.extname(body.path).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) throw Object.assign(new Error(`Unsupported file type: ${extension || '(no extension)'}.`), { status: 415 });
  let realPath;
  try { realPath = await fs.realpath(body.path); }
  catch { throw Object.assign(new Error('The selected media file could not be found.'), { status: 404 }); }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw Object.assign(new Error('The selected path is not a file.'), { status: 400 });
  if (stat.size > 100 * 1024 * 1024 * 1024) throw Object.assign(new Error('Files larger than 100 GB are not supported.'), { status: 413 });
  return { realPath, extension, stat };
}

async function analyzeFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) throw Object.assign(new Error('Choose a supported audio or video file.'), { status: 415 });
  return getMediaInfo(filePath, safeBinary('ffprobe'));
}

async function makeOutputPath(job) {
  await fs.mkdir(settings.outputFolder, { recursive: true });
  const sourceBase = sanitizeFilename(job.title || path.basename(job.sourcePath, path.extname(job.sourcePath)));
  let copyNumber = 1;
  while (true) {
    const suffix = copyNumber === 1 ? '' : ` (${copyNumber})`;
    const outputPath = path.join(settings.outputFolder, `${sourceBase}${suffix}.${job.format}`);
    try {
      await fs.access(outputPath);
      copyNumber += 1;
    } catch (error) {
      if (error.code === 'ENOENT') return outputPath;
      throw error;
    }
  }
}

async function startJob(job) {
  if (activeId || job.status !== 'queued') return;
  activeId = job.id;
  activeController = new AbortController();
  const controller = activeController;
  job.status = job.sourceType === 'youtube' ? 'downloading' : 'processing';
  job.progress = 0;
  job.error = null;
  job.updatedAt = new Date().toISOString();
  await persistJobs();
  let outputPath = '';
  let stderrTail = '';
  const jobTempDir = path.join(settings.tempFolder, `job-${job.id}`);
  let downloadedSource = '';
  try {
    outputPath = await makeOutputPath(job);
    let sourcePath = job.sourcePath;
    let mediaInfo = job.mediaInfo;
    let trimStart = job.start;
    let trimEnd = job.end;
    if (job.sourceType === 'youtube') {
      await fs.mkdir(jobTempDir, { recursive: true });
      const maxHeight = job.quality === 'best' ? 2160 : Number(job.quality);
      const maxHeightPart = `[height<=${maxHeight}]`;
      const formatSelector = job.format === 'mp3'
        ? 'bestaudio/best'
        : job.allowFormatsRequireEncoding
          ? `bestvideo${maxHeightPart}+bestaudio/best${maxHeightPart}`
          : `bestvideo[ext=mp4][vcodec^=avc1]${maxHeightPart}+bestaudio[ext=m4a]/best[ext=mp4]${maxHeightPart}`;
      job.progress = 0;
      let downloadProgressBuffer = '';
      const downloadArgs = [
        '--no-playlist', '--no-warnings', '--newline',
        '--format', formatSelector,
        '--download-sections', `*${formatTimestamp(job.start)}-${formatTimestamp(job.end)}`,
        '--force-keyframes-at-cuts',
        '--merge-output-format', 'mkv',
        '--output', path.join(jobTempDir, '%(id)s.%(ext)s'),
        '--print', 'after_move:filepath',
        `https://www.youtube.com/watch?v=${encodeURIComponent(job.youtubeId)}`
      ];
      if (job.youtubeBrowserSession) downloadArgs.unshift('--cookies-from-browser', browserForYouTubeCookies());
      const downloaded = await runProcess(safeBinary('yt-dlp'), downloadArgs, {
        signal: controller.signal,
        timeoutMs: 12 * 60 * 60 * 1000,
        onStdout: () => {},
        onStderr: (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-5000);
          downloadProgressBuffer += chunk;
          const lines = downloadProgressBuffer.split(/[\r\n]+/);
          downloadProgressBuffer = lines.pop() || '';
          for (const line of lines) {
            const match = /\[download\]\s+([\d.]+)%/.exec(line);
            if (match) {
              job.progress = Math.min(68, Math.max(job.progress, Math.round(Number(match[1]) * 0.68)));
              job.updatedAt = new Date().toISOString();
            }
          }
        }
      });
      downloadedSource = downloaded.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || '';
      if (!downloadedSource || !path.isAbsolute(downloadedSource)) {
        const candidates = await fs.readdir(jobTempDir, { withFileTypes: true });
        const candidate = candidates.find((entry) => entry.isFile() && !entry.name.endsWith('.part'));
        if (candidate) downloadedSource = path.join(jobTempDir, candidate.name);
      }
      if (!downloadedSource) throw new Error('YouTube finished without creating a downloadable media file.');
      try { await fs.access(downloadedSource); }
      catch { throw new Error('The downloaded YouTube media file could not be found.'); }
      mediaInfo = await getMediaInfo(downloadedSource, safeBinary('ffprobe'), controller.signal);
      const selectedDuration = job.end - job.start;
      trimStart = 0;
      trimEnd = Math.min(selectedDuration, mediaInfo.duration);
      if (trimEnd < 1 / 60) throw new Error('The selected range is outside the downloaded media duration.');
      job.selectedDuration = trimEnd;
      job.mediaInfo = mediaInfo;
      job.progress = 70;
    }
    if (controller.signal.aborted) throw new Error('Job cancelled.');
    job.status = 'processing';
    job.updatedAt = new Date().toISOString();
    await persistJobs();
    const duration = trimEnd - trimStart;
    const ffmpeg = safeBinary('ffmpeg');
    const args = ['-hide_banner', '-nostdin', '-y', '-i', sourcePath || downloadedSource, '-ss', formatTimestamp(trimStart), '-t', formatTimestamp(duration)];
    if (job.format === 'mp3') {
      args.push('-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', job.bitrate, '-write_xing', '1');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
      {
        const maxHeight = job.quality === 'best' ? 2160 : Number(job.quality);
        if ([360, 480, 720, 1080, 1440, 2160].includes(maxHeight) && job.mediaInfo.height && job.mediaInfo.height > maxHeight) {
          args.push('-vf', `scale=-2:min(ih\\,${maxHeight})`);
        }
      }
      if (job.mediaInfo.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
      else args.push('-an');
      args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    }
    args.push('-progress', 'pipe:1', '-nostats', outputPath);
    let progressBuffer = '';
    await runProcess(ffmpeg, args, {
      signal: controller.signal,
      onStdout: (chunk) => {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = line.split('=', 2);
          if (key === 'out_time_us') {
            const ratio = Number(value) / (duration * 1_000_000);
            if (Number.isFinite(ratio)) {
              const mapped = job.sourceType === 'youtube' ? 70 + ratio * 29 : ratio * 100;
              job.progress = Math.min(99, Math.max(job.progress, Math.round(mapped)));
            }
            job.updatedAt = new Date().toISOString();
          }
        }
      },
      onStderr: (chunk) => { stderrTail = (stderrTail + chunk).slice(-5000); },
      timeoutMs: 12 * 60 * 60 * 1000
    });
    if (controller.signal.aborted) throw new Error('Job cancelled.');
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size < 256) throw new Error('FFmpeg did not produce a valid output file.');
    const verification = await getMediaInfo(outputPath, safeBinary('ffprobe'));
    const difference = Math.abs(verification.duration - duration);
    const tolerance = Math.max(0.35, duration * 0.02);
    if (difference > tolerance) throw new Error(`Output duration check failed: expected ${duration.toFixed(3)} s, found ${verification.duration.toFixed(3)} s.`);
    job.status = 'completed';
    job.progress = 100;
    job.outputPath = outputPath;
    job.outputBytes = stat.size;
    job.verifiedDuration = verification.duration;
    job.completedAt = new Date().toISOString();
  } catch (error) {
    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
    if (controller.signal.aborted || /cancelled|SIGTERM/i.test(error.message || '')) {
      job.status = 'cancelled';
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = `${error.message || 'Processing failed.'}${stderrTail ? `\n${stderrTail.trim().split(/\r?\n/).slice(-3).join(' ')}` : ''}`.slice(0, 1200);
    }
  } finally {
    await fs.rm(jobTempDir, { recursive: true, force: true }).catch(() => {});
    job.updatedAt = new Date().toISOString();
    await persistJobs();
    if (activeId === job.id) {
      activeId = null;
      activeController = null;
    }
    pumpQueue();
  }
}

function pumpQueue() {
  if (activeId) return;
  while (queue.length) {
    const next = jobs.get(queue.shift());
    if (next?.status === 'queued') {
      void startJob(next);
      break;
    }
  }
}

async function createJob(body) {
  const format = body.format === 'mp3' ? 'mp3' : body.format === 'mp4' ? 'mp4' : '';
  if (!format) throw Object.assign(new Error('Choose MP4 or MP3.'), { status: 400 });
  const quality = ['best', '2160', '1440', '1080', '720', '480', '360'].includes(String(body.quality)) ? String(body.quality) : 'best';
  const bitrate = ['128k', '192k', '256k', '320k'].includes(body.bitrate) ? body.bitrate : '192k';
  const id = crypto.randomUUID();
  let title;
  let sourcePath = null;
  let mediaInfo;
  let trim;
  let sourceType = 'local';
  let youtubeId = null;
  let sourceDuration = null;
  let allowFormatsRequireEncoding = false;
  let youtubeBrowserSession = false;

  if (body.youtubeId !== undefined) {
    youtubeId = String(body.youtubeId || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) throw Object.assign(new Error('Enter a valid YouTube video ID.'), { status: 400 });
    sourceDuration = Number(body.duration);
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 172_800) {
      throw Object.assign(new Error('YouTube must report a valid video duration before downloading.'), { status: 400 });
    }
    trim = validateTrim(body.start, body.end, sourceDuration);
    title = sanitizeFilename(decodeHtmlEntities(String(body.title || youtubeId).slice(0, 160)));
    sourceType = 'youtube';
    allowFormatsRequireEncoding = Boolean(settings.allowFormatsRequireEncoding);
    youtubeBrowserSession = Boolean(settings.youtubeBrowserSession);
    mediaInfo = { duration: sourceDuration, hasVideo: format === 'mp4', hasAudio: true, height: null };
  } else {
    const selected = await selectedSource(body);
    sourcePath = selected.realPath;
    mediaInfo = await analyzeFile(sourcePath);
    if (format === 'mp4' && !mediaInfo.hasVideo) throw Object.assign(new Error('MP4 video export needs a video source. Choose MP3 for audio-only files.'), { status: 400 });
    if (format === 'mp3' && !mediaInfo.hasAudio) throw Object.assign(new Error('The selected media has no audio stream for MP3 export.'), { status: 400 });
    trim = validateTrim(body.start, body.end, mediaInfo.duration);
    title = sanitizeFilename(decodeHtmlEntities(String(body.title || path.basename(sourcePath, selected.extension)).slice(0, 160)));
  }

  const job = {
    id, title, sourceType, sourcePath, youtubeId, sourceDuration,
    mediaInfo,
    start: trim.start, end: trim.end, selectedDuration: trim.duration,
    format, quality, bitrate, allowFormatsRequireEncoding, youtubeBrowserSession,
    status: 'queued', progress: 0, error: null, outputPath: null,
    projectImportStatus: 'pending', projectImportError: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  jobs.set(id, job);
  queue.push(id);
  await persistJobs();
  pumpQueue();
  return job;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    void persistJobs();
  } else if (['downloading', 'processing'].includes(job.status) && activeId === id) {
    activeController?.abort();
  }
  return job;
}

async function searchYouTube(query, mode = 'video', pageToken = '') {
  if (!settings.youtubeApiKey) throw Object.assign(new Error('Add a YouTube Data API v3 key in Settings to search YouTube.'), { status: 409 });
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  const searchParams = { part: 'snippet', type: 'video', maxResults: '50', q: query, key: settings.youtubeApiKey };
  if (pageToken) searchParams.pageToken = pageToken;
  if (mode === 'music') searchParams.videoCategoryId = '10';
  searchUrl.search = new URLSearchParams(searchParams);
  const response = await fetch(searchUrl, { signal: AbortSignal.timeout(12_000) });
  const search = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(search.error?.message || `YouTube search returned ${response.status}.`), { status: 502 });
  const ids = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  if (!ids.length) return { results: [], nextPageToken: search.nextPageToken || '' };
  const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailUrl.search = new URLSearchParams({ part: 'contentDetails,statistics', id: ids.join(','), key: settings.youtubeApiKey });
  const detailResponse = await fetch(detailUrl, { signal: AbortSignal.timeout(12_000) });
  const details = await detailResponse.json().catch(() => ({}));
  if (!detailResponse.ok) throw Object.assign(new Error(details.error?.message || `YouTube details returned ${detailResponse.status}.`), { status: 502 });
  const byId = new Map((details.items || []).map((item) => [item.id, item]));
  const results = (search.items || []).map((item) => {
    const snippet = item.snippet || {};
    const detail = byId.get(item.id?.videoId);
    return {
      id: item.id?.videoId,
      title: decodeHtmlEntities(snippet.title || 'Untitled video'),
      channel: snippet.channelTitle || '',
      description: snippet.description || '',
      thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
      duration: parseIsoDuration(detail?.contentDetails?.duration),
      views: Number(detail?.statistics?.viewCount) || 0
    };
  });
  return { results, nextPageToken: search.nextPageToken || '' };
}

const server = http.createServer(async (req, res) => {
  if (!checkRateLimit(req)) return replyError(res, 429, 'Too many requests. Try again in a moment.');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { name: 'Local Stream', version: APP_VERSION, ready: true, ytConfigured: Boolean(settings.youtubeApiKey) });
  }
  if (req.method === 'GET' && url.pathname === '/youtube-preview') {
    const videoId = url.searchParams.get('videoId') || '';
    const previewOrigin = url.origin;
    const originUrl = new URL(previewOrigin);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return replyError(res, 400, 'Invalid YouTube video ID.');
    if (originUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(originUrl.hostname) || Number(originUrl.port || 80) !== port) {
      return replyError(res, 400, 'YouTube preview must use the Local Stream loopback address.');
    }
    return html(res, 200, youtubePreviewHtml(videoId, previewOrigin));
  }
  if (!authorized(req)) return replyError(res, 401, 'This panel is not authorized. Paste the backend token in Settings.');
  try {
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, 200, { ...settings, youtubeApiKey: '', ytConfigured: Boolean(settings.youtubeApiKey), tokenHint: `${tokenString.slice(0, 4)}…${tokenString.slice(-4)}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await parseBody(req);
      settings = safeSettings({ ...settings, ...body });
      await fs.mkdir(settings.outputFolder, { recursive: true });
      await fs.mkdir(settings.tempFolder, { recursive: true });
      await atomicWriteJson(settingsFile, settings);
      return json(res, 200, { ...settings, youtubeApiKey: '', ytConfigured: Boolean(settings.youtubeApiKey) });
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await parseBody(req);
      const { realPath } = await selectedSource(body);
      const media = await analyzeFile(realPath);
      return json(res, 200, { ...media, name: path.basename(realPath), sourcePath: realPath, availableVideoHeights: media.height ? [360, 480, 720, 1080, 1440, 2160].filter((height) => height <= media.height) : [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return json(res, 200, [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toPublicJob));
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await parseBody(req);
      const job = await createJob(body);
      return json(res, 202, toPublicJob(job));
    }
    if (req.method === 'POST' && url.pathname === '/api/youtube/search') {
      const body = await parseBody(req);
      const query = String(body.query || '').trim().slice(0, 200);
      const mode = body.mode === 'music' ? 'music' : 'video';
      const pageToken = String(body.pageToken || '').trim().slice(0, 4096);
      if (!query) return replyError(res, 400, 'Enter a search phrase.');
      return json(res, 200, await searchYouTube(query, mode, pageToken));
    }
    const jobRoute = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(retry|cancel|project-import))?$/.exec(url.pathname);
    if (jobRoute) {
      const [, id, action] = jobRoute;
      const job = jobs.get(id);
      if (!job) return replyError(res, 404, 'Job not found.');
      if (action === 'retry' && req.method === 'POST') {
        if (!['failed', 'cancelled'].includes(job.status)) return replyError(res, 409, 'Only failed or cancelled jobs can be retried.');
        if (job.sourceType === 'youtube') job.youtubeBrowserSession = Boolean(settings.youtubeBrowserSession);
        job.projectImportStatus = 'pending'; job.projectImportError = '';
        job.status = 'queued'; job.progress = 0; job.error = null; job.outputPath = null; job.updatedAt = new Date().toISOString();
        queue.push(id); await persistJobs(); pumpQueue();
        return json(res, 202, toPublicJob(job));
      }
      if (action === 'project-import' && req.method === 'POST') {
        if (job.status !== 'completed') return replyError(res, 409, 'Only completed exports can be added to the Premiere project.');
        const body = await parseBody(req);
        if (body.status === 'added') {
          job.projectImportStatus = 'added';
          job.projectImportError = '';
        } else if (body.status === 'failed') {
          job.projectImportStatus = 'failed';
          job.projectImportError = String(body.error || 'Premiere could not add this export to the project.').slice(0, 500);
        } else {
          return replyError(res, 400, 'Project import status must be added or failed.');
        }
        job.updatedAt = new Date().toISOString();
        await persistJobs();
        return json(res, 200, toPublicJob(job));
      }
      if (action === 'cancel' && req.method === 'POST') {
        cancelJob(id); await persistJobs();
        return json(res, 200, toPublicJob(job));
      }
      if (!action && req.method === 'DELETE') {
        if (['queued', 'processing', 'downloading'].includes(job.status)) return replyError(res, 409, 'Cancel the active job before removing it from history.');
        jobs.delete(id); await persistJobs();
        return json(res, 200, { removed: true });
      }
    }
    replyError(res, 404, 'Route not found.');
  } catch (error) {
    replyError(res, error.status || 500, error.message || 'Request failed.');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`Local Stream could not start: port ${port} is already in use.`);
  else console.error('Local Stream server error:', error);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local Stream backend ${APP_VERSION} listening at http://127.0.0.1:${port}`);
  console.log(`API token: ${tokenString}`);
  console.log(`Output folder: ${settings.outputFolder}`);
  console.log(`Settings folder: ${dataDir}`);
});

async function shutdown() {
  activeController?.abort();
  await new Promise((resolve) => server.close(resolve));
  await persistJobs().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
