import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const APP_VERSION = '0.2.3';
export const DEFAULT_PORT = 47831;
export const CEP_EXTENSION_ID = 'com.localstream.premiere';
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm', '.avi', '.mts', '.m2ts']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.opus', '.wma']);
export const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

export function appDataDir(env = process.env) {
  const localData = env.LOCALAPPDATA || path.join(env.USERPROFILE || process.cwd(), 'AppData', 'Local');
  return env.LOCAL_STREAM_DATA_DIR || path.join(localData, 'Adobe', 'CEP', 'extensionsData', CEP_EXTENSION_ID);
}

export function defaultSettings(env = process.env) {
  const home = env.USERPROFILE || process.cwd();
  const appData = appDataDir(env);
  return {
    outputFolder: path.join(home, 'Videos', 'Local Stream'),
    tempFolder: path.join(appData, 'Temp'),
    defaultFormat: 'mp4',
    defaultQuality: 'best',
    defaultBitrate: '192k',
    autoImport: false,
    cleanupDays: 30,
    ffmpegPath: '',
    ffprobePath: '',
    allowFormatsRequireEncoding: true,
    youtubeBrowserSession: false,
    lightMode: false,
    pausePreviewWhenHidden: true,
    youtubeApiKey: ''
  };
}

export function safeSettings(settings, env = process.env) {
  const defaults = defaultSettings(env);
  const next = { ...defaults };
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    for (const key of ['outputFolder', 'tempFolder']) {
      if (typeof settings[key] === 'string' && settings[key].trim()) next[key] = path.resolve(settings[key].trim());
    }
    for (const key of ['ffmpegPath', 'ffprobePath']) {
      if (typeof settings[key] === 'string') next[key] = settings[key].trim() ? path.resolve(settings[key].trim()) : '';
    }
    if (['mp4', 'mp3'].includes(settings.defaultFormat)) next.defaultFormat = settings.defaultFormat;
    if (['best', '2160', '1440', '1080', '720', '480', '360'].includes(String(settings.defaultQuality))) next.defaultQuality = String(settings.defaultQuality);
    if (['128k', '192k', '256k', '320k'].includes(settings.defaultBitrate)) next.defaultBitrate = settings.defaultBitrate;
    if (typeof settings.autoImport === 'boolean') next.autoImport = settings.autoImport;
    if (typeof settings.allowFormatsRequireEncoding === 'boolean') next.allowFormatsRequireEncoding = settings.allowFormatsRequireEncoding;
    if (typeof settings.youtubeBrowserSession === 'boolean') next.youtubeBrowserSession = settings.youtubeBrowserSession;
    if (typeof settings.lightMode === 'boolean') next.lightMode = settings.lightMode;
    if (typeof settings.pausePreviewWhenHidden === 'boolean') next.pausePreviewWhenHidden = settings.pausePreviewWhenHidden;
    if (Number.isInteger(settings.cleanupDays) && settings.cleanupDays >= 0 && settings.cleanupDays <= 3650) next.cleanupDays = settings.cleanupDays;
    if (typeof settings.youtubeApiKey === 'string') next.youtubeApiKey = settings.youtubeApiKey.trim().slice(0, 256);
  }
  return next;
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback; throw error; }
}

export async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

export function sanitizeFilename(value, fallback = 'media') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '_$1')
    .slice(0, 100);
  return cleaned || fallback;
}

export function formatTimestamp(seconds) {
  const milliseconds = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = ((milliseconds % 60_000) / 1000).toFixed(3).padStart(6, '0');
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs}` : `${String(minutes).padStart(2, '0')}:${secs}`;
}

export function validateTrim(start, end, duration) {
  const begin = Number(start);
  const finish = Number(end);
  const length = Number(duration);
  if (![begin, finish, length].every(Number.isFinite)) throw Object.assign(new Error('Start, end, and media duration must be valid numbers.'), { status: 400 });
  if (begin < 0 || finish - begin < 1 / 60 || finish > length + 0.05) throw Object.assign(new Error('Choose a clip range at least one frame long and within the media duration.'), { status: 400 });
  return { start: begin, end: Math.min(finish, length), duration: Math.min(finish, length) - begin };
}

export function resolveBinary(configuredPath, name) {
  if (configuredPath) return configuredPath;
  const candidates = process.platform === 'win32'
    ? [`C:\\ffmpeg\\bin\\${name}.exe`, `C:\\Program Files\\ffmpeg\\bin\\${name}.exe`]
    : [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  for (const candidate of candidates) {
    try { requireStat(candidate); return candidate; } catch {}
  }
  return name;
}

function requireStat(file) {
  // spawn itself is the final check; this avoids importing sync fs into callers.
  if (!path.isAbsolute(file)) throw new Error('Expected an absolute executable path.');
  return file;
}

export function runProcess(executable, args, { signal, onStdout, onStderr, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timeout;
    const abort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    if (timeoutMs > 0) timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-2_000_000);
      onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-16_000);
      onStderr?.(text);
    });
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code, terminationSignal) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(stderr.trim().split(/\r?\n/).slice(-5).join('\n') || `Process exited with code ${code ?? terminationSignal}.`);
        error.code = code;
        error.signal = terminationSignal;
        reject(error);
      }
    });
  });
}

export async function getMediaInfo(filePath, ffprobePath, signal) {
  const { stdout } = await runProcess(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration,format_name:format_tags=title',
    '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate,channels',
    '-of', 'json', filePath
  ], { signal, timeoutMs: 60_000 });
  const probe = JSON.parse(stdout);
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('FFprobe could not read a valid media duration.');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video && !audio) throw new Error('The selected file has no supported audio or video stream.');
  return {
    duration,
    format: probe.format?.format_name || '',
    title: probe.format?.tags?.title || path.basename(filePath, path.extname(filePath)),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width || null,
    height: video?.height || null,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    audioSampleRate: audio?.sample_rate || null,
    audioChannels: audio?.channels || null
  };
}

export function parseIsoDuration(value) {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export function isYouTubeVideoSearchItem(item) {
  return item?.id?.kind === 'youtube#video' && /^[A-Za-z0-9_-]{11}$/.test(item.id.videoId || '');
}

export function decodeHtmlEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: '\u00a0', quot: '"',
    copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
  };
  return String(value || '').replace(/&(#(?:x[\da-f]{1,6}|\d{1,7})|[a-z][a-z\d]+);/gi, (entity, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const codePoint = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

export function toPublicJob(job) {
  const { sourcePath, outputPath, ...publicFields } = job;
  return {
    ...publicFields,
    sourceName: sourcePath ? path.basename(sourcePath) : null,
    outputName: outputPath ? path.basename(outputPath) : null,
    outputPath: job.status === 'completed' ? outputPath : undefined
  };
}
