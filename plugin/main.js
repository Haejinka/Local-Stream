const { formatTime, parseTime, clamp, normalizeRange } = LocalStreamTrim;
const state = {
  apiBase: localStorage.getItem('local-stream-api') || 'http://127.0.0.1:47831',
  token: localStorage.getItem('local-stream-token') || '',
  csInterface: null,
  backendReady: false,
  settings: null,
  searchMode: 'video',
  resultsMode: 'video',
  searchQuery: '',
  nextPageToken: '',
  loadedResultCount: 0,
  previewLoop: false,
  previewPollTimer: null,
  pendingOutputFolder: '',
  youtubePlayerState: -1,
  youtubeMeta: null,
  sourcePath: '',
  sourceName: '',
  media: null,
  duration: 0,
  start: 0,
  end: 0,
  playhead: 0,
  dragging: null,
  selectedYouTubeId: '',
  pollTimer: null,
  toastTimer: null,
  audioContext: null,
  projectImportAttempts: new Set(),
  observedJobStatuses: new Map(),
  jobsPrimed: false,
  initialized: false,
  isSearching: false,
  exportDefaultsApplied: false,
  settingsReturnFocus: null
};

const el = {};
const API_KEYS = {
  search: 'query',
  selectedFormat: 'format',
  selectedQuality: 'quality'
};

function query(selector) { return document.querySelector(selector); }

function cacheElements() {
  for (const id of [
    'backend-state', 'settings-toggle', 'search-input', 'search-button', 'open-file', 'settings-panel', 'page-content',
    'settings-close', 'settings-form', 'setting-default-quality', 'setting-allow-encoding', 'setting-browser-session', 'setting-output-label',
    'choose-output-folder', 'setting-light-mode', 'setting-pause-hidden', 'setting-youtube-key', 'setting-clear-youtube', 'settings-status', 'results',
    'mode-video', 'mode-music', 'history-toggle',
    'download-progress', 'download-progress-label', 'download-progress-percent', 'download-progress-track', 'download-progress-fill', 'download-progress-queue',
    'search-area', 'browser-section', 'editor-section', 'jobs-section', 'browser-subtitle', 'result-count', 'load-more-results', 'source-video', 'youtube-player', 'preview-placeholder', 'media-title',
    'media-meta', 'clear-media', 'external-player-actions', 'open-youtube-browser', 'timeline', 'selected-range', 'playhead', 'start-handle', 'end-handle',
    'start-input', 'end-input', 'set-start', 'set-end', 'reset-range', 'clip-menu-toggle', 'clip-menu', 'preview-clip', 'selected-duration', 'playhead-time',
    'media-duration', 'quality-select', 'bitrate-select',
    'export-mp4-button', 'export-mp3-button', 'export-video-detail', 'export-audio-detail', 'export-note', 'jobs-list', 'job-count', 'toast', 'toast-message',
    'toast-close', 'footer-version', 'settings-status', 'back-to-results', 'back-to-browse', 'browser-heading', 'editor-heading', 'jobs-heading'
  ]) el[id] = query(`#${id}`);
}

function showToast(message, isError = false, { duration = isError ? 0 : 4500 } = {}) {
  el['toast-message'].textContent = message;
  el.toast.classList.toggle('is-error', Boolean(isError));
  el.toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = duration > 0 ? setTimeout(() => {
    el.toast.classList.remove('is-visible');
    state.toastTimer = null;
  }, duration) : null;
}

function primeCompletionAudio() {
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return;
  try {
    if (!state.audioContext || state.audioContext.state === 'closed') state.audioContext = new AudioContextType();
    if (state.audioContext.state === 'suspended') void state.audioContext.resume().catch(() => {});
  } catch {}
}

function playCompletionBell() {
  primeCompletionAudio();
  const audio = state.audioContext;
  if (!audio || audio.state === 'closed') return;
  const ring = () => {
    const startedAt = audio.currentTime;
    for (const partial of [
      { frequency: 880, volume: 0.095, decay: 0.78 },
      { frequency: 1320, volume: 0.048, decay: 0.56 },
      { frequency: 1760, volume: 0.022, decay: 0.38 }
    ]) {
      const oscillator = audio.createOscillator();
      const envelope = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(partial.frequency, startedAt);
      envelope.gain.setValueAtTime(0.0001, startedAt);
      envelope.gain.exponentialRampToValueAtTime(partial.volume, startedAt + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, startedAt + partial.decay);
      oscillator.connect(envelope);
      envelope.connect(audio.destination);
      oscillator.start(startedAt);
      oscillator.stop(startedAt + partial.decay + 0.02);
    }
  };
  if (audio.state === 'suspended') void audio.resume().then(ring).catch(() => {});
  else ring();
}

function setBackendLabel(label, status = 'offline') {
  el['backend-state'].classList.toggle('is-online', status === 'online');
  el['backend-state'].classList.toggle('is-error', status === 'error');
  el['backend-state'].querySelector('span').textContent = label;
}

function safeApiBase(candidate) {
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('For safety, the backend must use HTTP on this computer (127.0.0.1 or localhost).');
  }
  return parsed.origin;
}

async function api(path, options = {}) {
  if (!state.token && path !== '/api/health') throw new Error('Enter the backend token in Settings first.');
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  try {
    const response = await fetch(`${state.apiBase}${path}`, {
      ...options,
      headers,
      signal: options.signal || controller.signal,
      credentials: 'omit',
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Backend returned ${response.status}.`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The backend did not respond in time.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function jsonOptions(value, method = 'POST') {
  return { method, body: JSON.stringify(value) };
}

async function checkBackend() {
  try {
    state.apiBase = safeApiBase(state.apiBase);
    const health = await api('/api/health', { timeoutMs: 3000 });
    state.backendReady = Boolean(health.ready);
    if (!state.token) {
      setBackendLabel('Token needed', 'error');
      updateExportButton();
      return false;
    }
    try {
      state.settings = await api('/api/settings', { timeoutMs: 5000 });
      if (!state.exportDefaultsApplied) {
        el['quality-select'].value = state.settings.defaultQuality || 'best';
        state.exportDefaultsApplied = true;
      }
      setBackendLabel('Backend ready', 'online');
      updateSettingsHints();
      updateExportButton();
      return true;
    } catch (error) {
      state.backendReady = false;
      setBackendLabel(error.message.includes('authorized') ? 'Check token' : 'Backend error', 'error');
      updateExportButton();
      return false;
    }
  } catch {
    state.backendReady = false;
    setBackendLabel('Backend offline', 'offline');
    updateExportButton();
    return false;
  }
}

function updateSettingsHints() {
  if (!state.settings) return;
  document.body.classList.toggle('light-mode', Boolean(state.settings.lightMode));
  el['setting-default-quality'].value = state.settings.defaultQuality || 'best';
  el['setting-allow-encoding'].checked = Boolean(state.settings.allowFormatsRequireEncoding);
  el['setting-browser-session'].checked = Boolean(state.settings.youtubeBrowserSession);
  el['setting-output-label'].textContent = state.settings.outputFolder || '';
  el['setting-light-mode'].checked = Boolean(state.settings.lightMode);
  el['setting-pause-hidden'].checked = state.settings.pausePreviewWhenHidden !== false;
  setQualityOptions();
}

function openSettings() {
  state.settingsReturnFocus = document.activeElement;
  el['settings-panel'].classList.remove('is-hidden');
  el['page-content'].inert = true;
  el['setting-clear-youtube'].checked = false;
  el['setting-youtube-key'].value = '';
  el['settings-status'].textContent = state.settings?.ytConfigured ? 'A key is saved locally.' : '';
  state.pendingOutputFolder = state.settings?.outputFolder || '';
  updateSettingsHints();
  el['settings-close'].focus();
}

function closeSettings() {
  el['settings-panel'].classList.add('is-hidden');
  el['page-content'].inert = false;
  if (state.settingsReturnFocus?.isConnected) state.settingsReturnFocus.focus();
  state.settingsReturnFocus = null;
}

function trapSettingsFocus(event) {
  if (el['settings-panel'].classList.contains('is-hidden')) {
    if (event.key === 'Escape' && el['clip-menu'] && !el['clip-menu'].classList.contains('is-hidden')) closeClipMenu();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSettings();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...el['settings-panel'].querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !el['settings-panel'].contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !el['settings-panel'].contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}

async function saveSettings(event) {
  event.preventDefault();
  el['settings-status'].textContent = 'Saving…';
  try {
    if (!state.token) throw new Error('Local Stream could not load its local backend token. Reopen the panel or run the installer.');

    const updates = {
      outputFolder: state.pendingOutputFolder || state.settings?.outputFolder,
      defaultQuality: el['setting-default-quality'].value,
      allowFormatsRequireEncoding: el['setting-allow-encoding'].checked,
      youtubeBrowserSession: el['setting-browser-session'].checked,
      lightMode: el['setting-light-mode'].checked,
      pausePreviewWhenHidden: el['setting-pause-hidden'].checked
    };
    const youtubeKey = el['setting-youtube-key'].value.trim();
    if (youtubeKey) updates.youtubeApiKey = youtubeKey;
    else if (el['setting-clear-youtube'].checked) updates.youtubeApiKey = '';
    state.settings = await api('/api/settings', jsonOptions(updates));
    document.body.classList.toggle('light-mode', Boolean(state.settings.lightMode));
    el['quality-select'].value = state.settings.defaultQuality || 'best';
    el['setting-youtube-key'].value = '';
    el['setting-clear-youtube'].checked = false;
    el['settings-status'].textContent = state.settings.ytConfigured ? 'Saved. YouTube search is ready.' : 'Saved.';
    setQualityOptions();
    setBackendLabel('Backend ready', 'online');
    state.backendReady = true;
    await pollJobs();
    updateExportButton();
    showToast('Settings saved on this computer.');
  } catch (error) {
    el['settings-status'].textContent = error.message;
    setBackendLabel('Check settings', 'error');
  }
}

function setMeta(name, media) {
  const parts = [];
  if (media?.width && media?.height) parts.push(`${media.width} × ${media.height}`);
  if (media?.videoCodec) parts.push(media.videoCodec.toUpperCase());
  if (media?.audioCodec) parts.push(media.audioCodec.toUpperCase());
  if (Number.isFinite(media?.duration)) parts.push(formatTime(media.duration));
  el['media-title'].textContent = name || 'No local media selected';
  const slots = el['media-meta'].children;
  [0, 1, 2].forEach((index) => { slots[index].textContent = parts[index] || '—'; });
}

function setQualityOptions() {
  const previous = el['quality-select'].value;
  el['quality-select'].replaceChildren();
  const options = [['best', 'Best available · up to 4K']];
  const heights = state.media?.height
    ? [2160, 1440, 1080, 720, 480, 360].filter((height) => height <= state.media.height)
    : [2160, 1440, 1080, 720, 480, 360];
  heights.forEach((height) => options.push([String(height), height === 2160 ? '2160p · 4K' : `${height}p`]));
  options.forEach(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label;
    el['quality-select'].appendChild(option);
  });
  if (state.settings?.defaultQuality && options.some(([value]) => value === state.settings.defaultQuality)) el['quality-select'].value = state.settings.defaultQuality;
  else if (options.some(([value]) => value === previous)) el['quality-select'].value = previous;
}

function renderTimeline() {
  const loaded = state.duration > 0;
  const range = loaded ? normalizeRange(state.start, state.end, state.duration) : { start: 0, end: 0 };
  const startPercent = loaded ? range.start / state.duration * 100 : 0;
  const endPercent = loaded ? range.end / state.duration * 100 : 100;
  const playheadPercent = loaded ? clamp(state.playhead / state.duration * 100, 0, 100) : 0;
  el['selected-range'].style.left = `${startPercent}%`;
  el['selected-range'].style.width = `${Math.max(0, endPercent - startPercent)}%`;
  el['start-handle'].style.left = `${startPercent}%`;
  el['end-handle'].style.left = `${endPercent}%`;
  el.playhead.style.left = `${playheadPercent}%`;
  el['playhead-time'].textContent = formatTime(state.playhead);
  el['media-duration'].textContent = formatTime(state.duration);
  el['selected-duration'].textContent = formatTime(Math.max(0, range.end - range.start));
  el['start-input'].value = formatTime(range.start);
  el['end-input'].value = formatTime(range.end);
  [el['start-handle'], el['end-handle']].forEach((handle) => {
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', String(state.duration));
  });
  el['start-handle'].setAttribute('aria-valuenow', String(range.start));
  el['end-handle'].setAttribute('aria-valuenow', String(range.end));
  el['start-handle'].setAttribute('aria-valuetext', formatTime(range.start));
  el['end-handle'].setAttribute('aria-valuetext', formatTime(range.end));
  el['reset-range'].disabled = !loaded;
  el['set-start'].disabled = !loaded;
  el['set-end'].disabled = !loaded;
  el['start-input'].disabled = !loaded;
  el['end-input'].disabled = !loaded;
  el['start-handle'].disabled = !loaded;
  el['end-handle'].disabled = !loaded;
  updateExportButton();
}

function updateExportButton() {
  const isYouTube = Boolean(state.selectedYouTubeId);
  const hasSource = Boolean(state.sourcePath || isYouTube);
  const canStart = Boolean(state.backendReady && state.token && hasSource && state.duration > 0 && state.end - state.start >= 1 / 60);
  const hasVideo = isYouTube || Boolean(state.media?.hasVideo);
  const hasAudio = isYouTube || Boolean(state.media?.hasAudio);
  const qualityValue = el['quality-select'].value || 'best';
  const quality = qualityValue === 'best' ? 'up to 4K' : `${qualityValue}p`;
  el['export-video-detail'].textContent = `MP4 · H.264 · ${quality}`;
  el['export-audio-detail'].textContent = 'MP3';
  if (el['export-mp4-button']) el['export-mp4-button'].disabled = !(canStart && hasVideo);
  if (el['export-mp3-button']) el['export-mp3-button'].disabled = !(canStart && hasAudio);
  if (el['quality-select']) el['quality-select'].disabled = !hasVideo;
  if (el['export-note']) {
    if (!hasSource) el['export-note'].textContent = 'Choose a YouTube video or open a local media file.';
    else if (isYouTube && !state.duration) el['export-note'].textContent = 'Waiting for YouTube to report the video duration.';
    else if (!state.backendReady || !state.token) el['export-note'].textContent = 'Local Stream is not connected. Reopen the panel or run the installer.';
    else if (!hasVideo && !hasAudio) el['export-note'].textContent = 'This media has no supported audio or video stream.';
    else if (isYouTube) el['export-note'].textContent = 'Selected range · downloaded and converted locally';
    else el['export-note'].textContent = 'Accurate trim · processed locally · output duration verified';
  }
}

function showEditor() {
  el['search-area'].classList.add('is-hidden');
  el['browser-section'].classList.add('is-hidden');
  el['jobs-section'].classList.add('is-hidden');
  el['editor-section'].classList.remove('is-hidden');
  el['editor-section'].scrollIntoView({ block: 'start', behavior: 'auto' });
  el['editor-heading'].focus();
}

function returnToResults() {
  state.previewLoop = false;
  el['source-video'].pause();
  if (state.selectedYouTubeId) sendYouTubeCommand('pause');
  closeClipMenu();
  el['search-area'].classList.remove('is-hidden');
  el['editor-section'].classList.add('is-hidden');
  el['jobs-section'].classList.add('is-hidden');
  el['browser-section'].classList.remove('is-hidden');
  el['browser-section'].scrollIntoView({ block: 'start', behavior: 'auto' });
  el['browser-heading'].focus();
}

function showHistory() {
  state.previewLoop = false;
  el['source-video'].pause();
  if (state.selectedYouTubeId) sendYouTubeCommand('pause');
  closeClipMenu();
  el['search-area'].classList.add('is-hidden');
  el['browser-section'].classList.add('is-hidden');
  el['editor-section'].classList.add('is-hidden');
  el['jobs-section'].classList.remove('is-hidden');
  el['jobs-section'].scrollIntoView({ block: 'start', behavior: 'auto' });
  el['jobs-heading'].focus();
}

function setSearchMode(mode) {
  state.searchMode = mode === 'music' ? 'music' : 'video';
  el['mode-video'].classList.toggle('is-selected', state.searchMode === 'video');
  el['mode-music'].classList.toggle('is-selected', state.searchMode === 'music');
  el['mode-video'].setAttribute('aria-pressed', String(state.searchMode === 'video'));
  el['mode-music'].setAttribute('aria-pressed', String(state.searchMode === 'music'));
  el['browser-subtitle'].textContent = state.searchMode === 'music' ? 'YouTube music search' : 'YouTube video search';
  updateLoadMoreVisibility();
}

function updateLoadMoreVisibility() {
  const queryMatches = el['search-input'].value.trim() === state.searchQuery;
  const modeMatches = state.searchMode === state.resultsMode;
  el['load-more-results'].classList.toggle('is-hidden', !state.nextPageToken || !queryMatches || !modeMatches);
}

function seekPlayhead(seconds) {
  if (!state.duration || (!state.sourcePath && !state.selectedYouTubeId)) return;
  const next = clamp(Number(seconds) || 0, 0, state.duration);
  state.playhead = next;
  if (state.selectedYouTubeId) sendYouTubeCommand('seek', { seconds: next });
  else el['source-video'].currentTime = next;
  renderTimeline();
}

function setMarker(which, value, { silent = false } = {}) {
  if (!state.duration) return;
  const number = parseTime(value);
  if (!Number.isFinite(number)) {
    if (!silent) showToast('Enter seconds or a timestamp such as 01:23.500.', true);
    renderTimeline(); return;
  }
  if (which === 'start') {
    if (number < 0 || number >= state.end) {
      if (!silent) showToast('Start must be earlier than the end time.', true);
      renderTimeline(); return;
    }
    state.start = clamp(number, 0, Math.max(0, state.end - 1 / 60));
  } else {
    if (number - state.start < 1 / 60 || number > state.duration) {
      if (!silent) showToast('End must be later than the start and within the media duration.', true);
      renderTimeline(); return;
    }
    state.end = clamp(number, state.start + 1 / 60, state.duration);
  }
  renderTimeline();
}

function setInPoint() {
  if (!state.duration) return;
  state.start = clamp(state.playhead, 0, Math.max(0, state.duration - 1 / 60));
  state.end = Math.min(state.duration, state.start + 29);
  if (state.end - state.start < 1 / 60) state.start = Math.max(0, state.end - 1 / 60);
  renderTimeline(); closeClipMenu();
}

function setOutPoint() {
  if (!state.duration) return;
  state.end = clamp(state.playhead, 1 / 60, state.duration);
  state.start = Math.max(0, state.end - 29);
  if (state.end - state.start < 1 / 60) state.end = Math.min(state.duration, state.start + 1 / 60);
  renderTimeline(); closeClipMenu();
}

function closeClipMenu() {
  if (!el['clip-menu']) return;
  el['clip-menu'].classList.add('is-hidden');
  el['clip-menu-toggle'].setAttribute('aria-expanded', 'false');
}

function toggleClipMenu() {
  const opening = el['clip-menu'].classList.contains('is-hidden');
  el['clip-menu'].classList.toggle('is-hidden', !opening);
  el['clip-menu-toggle'].setAttribute('aria-expanded', String(opening));
}

async function openLocalFile() {
  try {
    const result = window.cep?.fs?.showOpenDialogEx(false, false, 'Open local media', '', ['*.*'], 'All files', 'Open');
    if (!result) throw new Error('CEP file picker is unavailable.');
    if (result.err !== 0) throw new Error(`CEP file picker failed (${result.err}).`);
    const filePath = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!filePath) return;
    const fileName = filePath.split(/[\\/]/).pop();
    await loadLocalMedia(filePath, fileUrlFromPath(filePath), fileName);
  } catch (error) {
    showToast(error.message || 'Could not open this media file.', true);
  }
}

function fileUrlFromPath(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const encoded = normalized.split('/').map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return `file:///${encoded}`;
}

async function loadLocalMedia(filePath, fileUrl, fileName) {
  state.previewLoop = false;
  state.sourcePath = filePath;
  state.sourceName = fileName || filePath.split(/[\\/]/).pop();
  state.media = null;
  state.duration = 0;
  state.start = 0;
  state.end = 0;
  state.playhead = 0;
  state.selectedYouTubeId = '';
  state.youtubeMeta = null;
  el['youtube-player'].classList.add('is-hidden');
  el['youtube-player'].setAttribute('src', 'about:blank');
  el['external-player-actions'].classList.add('is-hidden');
  el['source-video'].classList.remove('is-hidden');
  el['source-video'].src = fileUrl;
  el['preview-placeholder'].classList.add('is-hidden');
  el['clear-media'].disabled = false;
  setMeta(state.sourceName, null);
  el['media-meta'].children[0].textContent = 'Reading media…';
  renderTimeline();
  updateExportButton();
  showEditor();

  try {
    if (!await checkBackend()) throw new Error('Start the backend and connect it in Settings before exporting.');
    const info = await api('/api/analyze', jsonOptions({ path: state.sourcePath }));
    state.media = info;
    if (Number.isFinite(info.duration) && info.duration > 0) {
      state.duration = info.duration;
      state.start = 0;
      state.end = info.duration;
      state.playhead = Number.isFinite(el['source-video'].currentTime) ? el['source-video'].currentTime : 0;
    }
    setMeta(state.sourceName, info);
    setQualityOptions();
    renderTimeline();
  } catch (error) {
    showToast(error.message, true);
  }
}

function clearMedia() {
  state.previewLoop = false;
  closeClipMenu();
  state.sourcePath = '';
  state.sourceName = '';
  state.media = null;
  state.duration = 0;
  state.start = 0;
  state.end = 0;
  state.playhead = 0;
  state.selectedYouTubeId = '';
  state.youtubeMeta = null;
  el['source-video'].pause();
  el['source-video'].removeAttribute('src');
  el['source-video'].load();
  el['source-video'].classList.remove('is-hidden');
  el['youtube-player'].classList.add('is-hidden');
  el['youtube-player'].setAttribute('src', 'about:blank');
  el['external-player-actions'].classList.add('is-hidden');
  el['preview-placeholder'].classList.remove('is-hidden');
  el['clear-media'].disabled = true;
  setMeta('', null);
  renderTimeline();
  returnToResults();
}

function extractYouTubeId(input) {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (!host.endsWith('youtube.com') && !host.endsWith('youtube-nocookie.com')) return '';
    const watch = url.searchParams.get('v');
    if (watch) return watch;
    const parts = url.pathname.split('/').filter(Boolean);
    if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || '';
  } catch {}
  return '';
}

function showYouTube(video) {
  const id = typeof video === 'string' ? video : video.id;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) {
    showToast('That does not look like a valid YouTube video URL.', true);
    return;
  }
  state.selectedYouTubeId = id;
  state.youtubeMeta = typeof video === 'string' ? { id } : video;
  state.sourcePath = '';
  state.sourceName = typeof video === 'string' ? 'YouTube video' : video.title || 'YouTube video';
  state.media = { hasVideo: true, hasAudio: true, height: null };
  const videoDuration = Number(video?.duration);
  state.duration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 0;
  state.start = 0;
  state.end = state.duration;
  state.playhead = 0;
  state.youtubePlayerState = -1;
  state.previewLoop = false;
  el['source-video'].pause();
  el['source-video'].removeAttribute('src');
  el['source-video'].load();
  el['source-video'].classList.add('is-hidden');
  el['youtube-player'].classList.remove('is-hidden');
  el['external-player-actions'].classList.remove('is-hidden');
  const previewUrl = new URL('/youtube-preview', state.apiBase);
  previewUrl.searchParams.set('videoId', id);
  el['youtube-player'].setAttribute('src', previewUrl.href);
  el['preview-placeholder'].classList.add('is-hidden');
  el['clear-media'].disabled = false;
  const title = state.sourceName;
  setMeta(title, { duration: state.duration || undefined });
  el['media-meta'].children[0].textContent = 'YouTube';
  el['media-meta'].children[1].textContent = 'Embedded preview';
  el['media-meta'].children[2].textContent = 'Clip and download';
  renderTimeline();
  showEditor();
}

function sendYouTubeCommand(command, payload = {}) {
  if (!state.selectedYouTubeId || !el['youtube-player'].contentWindow) return;
  el['youtube-player'].contentWindow.postMessage({
    type: 'local-stream-player-command',
    videoId: state.selectedYouTubeId,
    command,
    ...payload
  }, '*');
}

function receiveYouTubePlayerMessage(event) {
  if (!state.selectedYouTubeId || event.source !== el['youtube-player'].contentWindow) return;
  let expectedOrigin;
  try { expectedOrigin = new URL(state.apiBase).origin; } catch { return; }
  if (event.origin !== expectedOrigin) return;
  const data = event.data;
  if (!data || data.type !== 'local-stream-player-state' || data.videoId !== state.selectedYouTubeId) return;
  const reportedDuration = Number(data.duration);
  if (Number.isFinite(reportedDuration) && reportedDuration > 0) {
    const previousDuration = state.duration;
    state.duration = reportedDuration;
    if (!previousDuration || state.end === previousDuration) state.end = reportedDuration;
    state.start = clamp(state.start, 0, Math.max(0, reportedDuration - 1 / 60));
    state.end = clamp(state.end, state.start + 1 / 60, reportedDuration);
  }
  const current = Number(data.currentTime);
  if (Number.isFinite(current)) state.playhead = clamp(current, 0, state.duration || Number.MAX_SAFE_INTEGER);
  state.youtubePlayerState = Number(data.playerState);
  if (state.previewLoop && state.youtubePlayerState === 1 && state.playhead >= state.end) {
    sendYouTubeCommand('seek', { seconds: state.start });
    sendYouTubeCommand('play');
    state.playhead = state.start;
  }
  renderTimeline();
}

function togglePreviewClip() {
  if (!state.duration) return showToast('Wait for YouTube to report the video duration.', true);
  state.previewLoop = !state.previewLoop;
  if (state.previewLoop) {
    seekPlayhead(state.start);
    sendYouTubeCommand('play');
    if (state.sourcePath) void el['source-video'].play().catch(() => {});
    showToast('Previewing the selected clip.');
  } else {
    if (state.sourcePath) el['source-video'].pause();
    else sendYouTubeCommand('pause');
    showToast('Clip preview stopped.');
  }
  closeClipMenu();
}

function openSelectedYouTubeInBrowser() {
  if (!state.selectedYouTubeId) return;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(state.selectedYouTubeId)}`;
  try {
    const result = state.csInterface?.openURLInDefaultBrowser(url);
    if (result !== undefined && result !== 0) throw new Error(`Premiere could not open your browser (error ${result}).`);
    if (result === undefined && !window.cep?.util?.openURLInDefaultBrowser) {
      window.open(url, '_blank', 'noopener');
    }
  } catch (error) {
    showToast(error.message || 'Could not open this video in your browser.', true);
  }
}

async function searchYouTube({ loadMore = false } = {}) {
  const queryText = el['search-input'].value.trim();
  if (!queryText || state.isSearching) return;
  if (loadMore && (queryText !== state.searchQuery || state.searchMode !== state.resultsMode)) loadMore = false;
  const pastedId = extractYouTubeId(queryText);
  if (!loadMore && pastedId) {
    state.nextPageToken = '';
    updateLoadMoreVisibility();
    showYouTube(pastedId);
    el['browser-subtitle'].textContent = 'Embedded YouTube preview';
    return;
  }
  if (!loadMore && /^https?:\/\//i.test(queryText)) {
    showToast('Paste a YouTube video URL or enter a search phrase.', true);
    return;
  }
  if (!loadMore) {
    state.searchQuery = queryText;
    state.resultsMode = state.searchMode;
    state.nextPageToken = '';
    state.loadedResultCount = 0;
    el['load-more-results'].classList.add('is-hidden');
    el['load-more-results'].disabled = false;
    el['load-more-results'].textContent = 'Load more results';
    el['result-count'].textContent = '';
    el['results'].replaceChildren();
  }
  if (loadMore && !state.nextPageToken) return;
  state.isSearching = true;
  el['search-button'].disabled = true;
  if (!loadMore) el['search-button'].textContent = '…';
  el['load-more-results'].disabled = true;
  el['load-more-results'].textContent = 'Loading…';
  el['browser-subtitle'].textContent = loadMore ? 'Loading more results…' : 'Searching YouTube…';
  try {
    if (!await checkBackend()) throw new Error('Local Stream could not connect. Reopen the panel or run the installer.');
    const response = await api('/api/youtube/search', jsonOptions({
      query: queryText,
      mode: state.searchMode,
      ...(loadMore ? { pageToken: state.nextPageToken } : {})
    }));
    const results = response.results || [];
    state.nextPageToken = response.nextPageToken || '';
    state.loadedResultCount = loadMore ? state.loadedResultCount + results.length : results.length;
    renderResults(results, { append: loadMore });
    updateLoadMoreVisibility();
  } catch (error) {
    if (loadMore) {
      el['browser-subtitle'].textContent = 'Official YouTube search results';
      showToast(error.message, true);
    } else {
      state.nextPageToken = '';
      state.loadedResultCount = 0;
      el['result-count'].textContent = '';
      el['browser-subtitle'].textContent = 'YouTube search';
      const message = document.createElement('li');
      message.className = 'empty-state';
      const title = document.createElement('strong'); title.textContent = error.message;
      const detail = document.createElement('span'); detail.textContent = error.message.includes('API key') ? 'Add a YouTube Data API v3 key under Settings. Search uses the official YouTube Data API.' : 'Check the backend connection and try again.';
      message.append(title, detail);
      el['results'].appendChild(message);
    }
  } finally {
    state.isSearching = false;
    el['search-button'].disabled = false;
    el['search-button'].textContent = 'Search';
    el['load-more-results'].disabled = false;
    el['load-more-results'].textContent = 'Load more results';
    updateLoadMoreVisibility();
  }
}

function renderResults(results, { append = false } = {}) {
  if (!append) el['results'].replaceChildren();
  el['result-count'].textContent = state.loadedResultCount ? String(state.loadedResultCount) : '';
  el['browser-subtitle'].textContent = state.loadedResultCount ? 'Official YouTube search results' : 'No results found';
  if (!results.length) {
    if (append) return;
    const empty = document.createElement('li'); empty.className = 'empty-state';
    const text = document.createElement('strong'); text.textContent = 'No videos found'; empty.appendChild(text);
    el['results'].appendChild(empty); return;
  }
  for (const item of results) {
    const card = document.createElement('li');
    card.className = 'result-card';
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'result-open';
    const thumb = document.createElement('span'); thumb.className = 'result-thumb';
    const image = document.createElement('img'); image.src = item.thumbnail; image.alt = ''; image.loading = 'lazy';
    thumb.appendChild(image);
    if (Number.isFinite(item.duration) && item.duration > 0) {
      const duration = document.createElement('span'); duration.className = 'result-duration'; duration.textContent = formatTime(item.duration); thumb.appendChild(duration);
    }
    const copy = document.createElement('div'); copy.className = 'result-copy';
    const title = document.createElement('div'); title.className = 'result-title'; title.textContent = item.title;
    const channel = document.createElement('div'); channel.className = 'result-channel'; channel.textContent = item.channel;
    const views = document.createElement('div'); views.className = 'result-views';
    views.textContent = item.views ? `${Number(item.views).toLocaleString()} views` : 'YouTube';
    copy.append(title, channel, views);
    open.append(thumb, copy);
    open.setAttribute('aria-label', `Preview ${item.title} by ${item.channel}`);
    open.addEventListener('click', () => showYouTube(item));
    const download = document.createElement('button');
    download.type = 'button'; download.className = 'result-action';
    const format = state.searchMode === 'music' ? 'mp3' : 'mp4';
    download.setAttribute('aria-label', `Download ${format === 'mp3' ? 'audio' : 'video'}: ${item.title}`);
    download.title = `Download ${format === 'mp3' ? 'audio' : 'video'}`; download.textContent = '↓';
    download.addEventListener('click', () => void queueYouTubeDownload(item, format));
    card.append(open, download);
    el['results'].appendChild(card);
  }
}

function timelinePosition(event) {
  const rect = el.timeline.getBoundingClientRect();
  return clamp((event.clientX - rect.left) / rect.width, 0, 1);
}

function handlePointerDown(which, event) {
  if (!state.duration) return;
  event.preventDefault(); event.stopPropagation();
  state.dragging = which;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  setMarker(which, timelinePosition(event) * state.duration, { silent: true });
}

function handleTimelinePointerMove(event) {
  if (!state.dragging || !state.duration) return;
  setMarker(state.dragging, timelinePosition(event) * state.duration, { silent: true });
}

function handleTimelinePointerUp() { state.dragging = null; }

function handleMarkerKey(which, event) {
  if (!state.duration) return;
  const step = event.shiftKey ? 1 : 0.1;
  let value = which === 'start' ? state.start : state.end;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') value -= step;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') value += step;
  else if (event.key === 'Home') value = which === 'start' ? 0 : state.start + 1 / 60;
  else if (event.key === 'End') value = which === 'end' ? state.duration : state.end - 1 / 60;
  else return;
  event.preventDefault(); setMarker(which, value, { silent: true });
}

async function exportClip(format) {
  const isYouTube = Boolean(state.selectedYouTubeId);
  if ((!state.sourcePath || !state.media) && !isYouTube) return;
  try {
    if (!await checkBackend()) throw new Error('Local Stream could not connect. Reopen the panel or run the installer.');
    const body = isYouTube ? {
      youtubeId: state.selectedYouTubeId,
      duration: state.duration,
      title: state.sourceName,
      start: state.start,
      end: state.end,
      format,
      quality: el['quality-select'].value,
      bitrate: el['bitrate-select'].value,
      allowFormatsRequireEncoding: Boolean(state.settings?.allowFormatsRequireEncoding)
    } : {
      path: state.sourcePath,
      title: state.sourceName.replace(/\.[^.]+$/, ''),
      start: state.start,
      end: state.end,
      format,
      quality: el['quality-select'].value,
      bitrate: el['bitrate-select'].value
    };
    const job = await api('/api/jobs', jsonOptions(body));
    showToast(`Download queued: ${job.title}`);
    await pollJobs();
  } catch (error) { showToast(error.message, true); }
}

async function queueYouTubeDownload(video, format) {
  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    showToast('YouTube did not provide a duration for this video, so a clip range cannot be created.', true);
    return;
  }
  try {
    if (!await checkBackend()) throw new Error('Local Stream could not connect. Reopen the panel or run the installer.');
    const job = await api('/api/jobs', jsonOptions({
      youtubeId: video.id,
      duration,
      title: video.title,
      start: 0,
      end: duration,
      format,
      quality: state.settings?.defaultQuality || 'best',
      bitrate: '192k',
      allowFormatsRequireEncoding: Boolean(state.settings?.allowFormatsRequireEncoding)
    }));
    showToast(`${format === 'mp3' ? 'Audio' : 'Video'} download queued: ${job.title}`);
    showHistory();
    await pollJobs();
  } catch (error) { showToast(error.message || 'Could not queue the download.', true); }
}

function humanBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function importIntoPremiere(path) {
  if (!path) throw new Error('The export file path is missing.');
  if (!state.csInterface) throw new Error('Premiere scripting bridge is not available.');
  const quotedPath = `"${String(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  return new Promise((resolve, reject) => {
    state.csInterface.evalScript(`$._LocalStream.importCompletedFile(${quotedPath})`, (result) => {
      if (!result || result === 'EvalScript error.') {
        reject(new Error('Premiere could not run the import script. Open a project and try again.'));
      } else if (result.indexOf('ERROR:') === 0) {
        reject(new Error(result.slice(6)));
      } else if (result.indexOf('OK') === 0) {
        resolve(true);
      } else {
        reject(new Error(`Premiere returned an unexpected import result: ${result}`));
      }
    });
  });
}

async function addCompletedJobToProject(job) {
  try {
    await importIntoPremiere(job.outputPath);
    Object.assign(job, await api(`/api/jobs/${job.id}/project-import`, jsonOptions({ status: 'added' })));
  } catch (error) {
    job.projectImportStatus = 'failed';
    job.projectImportError = error.message || 'Premiere could not add this export to the project.';
    try {
      Object.assign(job, await api(`/api/jobs/${job.id}/project-import`, jsonOptions({ status: 'failed', error: job.projectImportError })));
    } catch {}
    throw error;
  }
}

async function handleJobAction(action, id) {
  try {
    const job = (await api('/api/jobs')).find((item) => item.id === id);
    if (!job) throw new Error('Job is no longer in history.');
    if (action === 'add-to-project') {
      state.projectImportAttempts.add(id);
      await addCompletedJobToProject(job);
      showToast('Added to LocalStream Downloads. Drag it to the timeline.');
      await pollJobs();
    } else if (action === 'retry') {
      await api(`/api/jobs/${id}/retry`, jsonOptions({})); await pollJobs();
    } else if (action === 'cancel') {
      await api(`/api/jobs/${id}/cancel`, jsonOptions({})); await pollJobs();
    } else if (action === 'remove') {
      await api(`/api/jobs/${id}`, { method: 'DELETE' }); await pollJobs();
    }
  } catch (error) { showToast(error.message, true); }
}

function appendAction(container, text, action, id, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = text; button.dataset.action = action; button.dataset.id = id;
  if (extraClass) button.className = extraClass;
  container.appendChild(button);
}

function renderJobs(jobs) {
  renderDownloadProgress(jobs);
  el['jobs-list'].replaceChildren();
  el['job-count'].textContent = String(jobs.length);
  if (!jobs.length) {
    const empty = document.createElement('div'); empty.className = 'empty-jobs'; empty.textContent = 'Your exports will appear here.';
    el['jobs-list'].appendChild(empty); return;
  }
  for (const job of jobs) {
    const card = document.createElement('article'); card.className = 'job-card';
    const head = document.createElement('div'); head.className = 'job-head';
    const format = document.createElement('span'); format.className = 'job-format'; format.textContent = job.format.toUpperCase();
    const copy = document.createElement('div'); copy.className = 'job-copy';
    const title = document.createElement('div'); title.className = 'job-title'; title.textContent = job.title || job.outputName || 'Untitled export';
    const jobSourceLabel = job.sourceType === 'youtube' ? 'YouTube' : 'Local file';
    const subtitle = document.createElement('div'); subtitle.className = 'job-subtitle'; subtitle.textContent = `${formatTime(job.selectedDuration || 0)} · ${job.outputBytes ? humanBytes(job.outputBytes) : jobSourceLabel}`;
    copy.append(title, subtitle);
    const status = document.createElement('span'); status.className = `job-state ${job.status}`;
    if (job.status === 'completed') {
      status.textContent = job.projectImportStatus === 'added' ? 'Ready for timeline' : job.projectImportStatus === 'pending' ? 'Adding to project…' : 'Downloaded';
    } else if (job.status === 'processing' || job.status === 'downloading') {
      status.textContent = `${job.status === 'processing' ? 'Processing' : 'Downloading'} ${job.progress || 0}%`;
    } else {
      status.textContent = job.status === 'queued' ? 'Queued' : job.status === 'failed' ? 'Failed' : 'Cancelled';
    }
    head.append(format, copy, status);
    card.appendChild(head);
    if (job.status === 'completed') {
      const placement = document.createElement('div'); placement.className = 'job-placement';
      if (job.projectImportStatus === 'added') placement.textContent = 'Added to LocalStream Downloads · drag it to the timeline.';
      else if (job.projectImportStatus === 'pending') placement.textContent = 'Download complete · adding it to LocalStream Downloads…';
      else placement.textContent = 'Download complete · add it to LocalStream Downloads to use it on the timeline.';
      card.appendChild(placement);
      if (job.projectImportStatus === 'failed' && job.projectImportError) {
        const importError = document.createElement('div'); importError.className = 'job-error';
        importError.textContent = `Could not add to Premiere: ${job.projectImportError}`;
        card.appendChild(importError);
      }
    }
    if (['queued', 'processing', 'downloading'].includes(job.status)) {
      const progress = document.createElement('div'); progress.className = 'job-progress';
      const fill = document.createElement('span'); fill.style.width = `${job.status === 'queued' ? 0 : Math.max(2, job.progress || 0)}%`; progress.appendChild(fill); card.appendChild(progress);
    }
    if (job.error) { const message = document.createElement('div'); message.className = 'job-error'; message.textContent = job.error; card.appendChild(message); }
    const actions = document.createElement('div'); actions.className = 'job-actions';
    if (job.status === 'completed') {
      if (!['added', 'pending'].includes(job.projectImportStatus)) appendAction(actions, 'Add to project', 'add-to-project', job.id, 'import-action');
      appendAction(actions, 'Remove', 'remove', job.id);
    } else if (job.status === 'queued' || job.status === 'processing' || job.status === 'downloading') {
      appendAction(actions, 'Cancel', 'cancel', job.id);
    } else {
      appendAction(actions, 'Retry', 'retry', job.id);
      appendAction(actions, 'Remove', 'remove', job.id);
    }
    card.appendChild(actions);
    el['jobs-list'].appendChild(card);
  }
}

function renderDownloadProgress(jobs) {
  const current = jobs.find((job) => ['downloading', 'processing'].includes(job.status))
    || jobs.find((job) => job.status === 'queued');
  if (!current) {
    el['download-progress'].classList.add('is-hidden');
    return;
  }
  const queuedCount = jobs.filter((job) => job.status === 'queued').length;
  const progress = current.status === 'queued' ? 0 : clamp(Number(current.progress) || 0, 0, 100);
  const step = current.status === 'queued' ? 'Queued' : current.status === 'processing' ? 'Processing' : 'Downloading';
  el['download-progress'].classList.remove('is-hidden');
  el['download-progress-label'].textContent = `${step} · ${current.title || 'Media export'}`;
  el['download-progress-percent'].textContent = current.status === 'queued' ? 'Waiting' : `${progress}%`;
  el['download-progress-track'].setAttribute('aria-valuenow', String(progress));
  el['download-progress-track'].setAttribute('aria-valuetext', current.status === 'queued' ? 'Queued' : `${progress}% ${step.toLowerCase()}`);
  el['download-progress-fill'].style.width = `${progress}%`;
  el['download-progress-queue'].textContent = current.status === 'queued'
    ? `${queuedCount} ${queuedCount === 1 ? 'job' : 'jobs'} in queue`
    : queuedCount ? `${queuedCount} more waiting` : '';
}

async function pollJobs() {
  if (!state.token || !state.backendReady) return;
  try {
    const jobs = await api('/api/jobs', { timeoutMs: 6000 });
    const newlyCompleted = [];
    for (const job of jobs) {
      const previousStatus = state.observedJobStatuses.get(job.id);
      if (state.jobsPrimed && job.status === 'completed' && previousStatus !== 'completed') newlyCompleted.push(job);
      state.observedJobStatuses.set(job.id, job.status);
    }
    state.jobsPrimed = true;
    renderJobs(jobs);
    let importStateChanged = false;
    for (const job of jobs) {
      if (job.status !== 'completed' || job.projectImportStatus !== 'pending' || state.projectImportAttempts.has(job.id)) continue;
      state.projectImportAttempts.add(job.id);
      importStateChanged = true;
      try {
        await addCompletedJobToProject(job);
      } catch {}
    }
    for (const job of newlyCompleted) {
      const importFailed = job.projectImportStatus === 'failed';
      const message = importFailed
        ? `Download complete, but it could not be added to Premiere: ${job.projectImportError || 'Open Downloads to retry.'}`
        : 'Download complete. Added to LocalStream Downloads and ready for the timeline.';
      showToast(message, importFailed, { duration: importFailed ? 8000 : 6000 });
      playCompletionBell();
    }
    if (importStateChanged) renderJobs(jobs);
  } catch (error) {
    if (error.message.includes('authorized')) setBackendLabel('Check token', 'error');
  }
}

function bindEvents() {
  el['settings-toggle'].addEventListener('click', openSettings);
  el['settings-close'].addEventListener('click', closeSettings);
  document.addEventListener('keydown', trapSettingsFocus);
  el['toast-close'].addEventListener('click', () => {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
    el.toast.classList.remove('is-visible');
  });
  el['settings-form'].addEventListener('submit', saveSettings);
  el['search-button'].addEventListener('click', searchYouTube);
  el['search-input'].addEventListener('input', updateLoadMoreVisibility);
  el['search-input'].addEventListener('keydown', (event) => { if (event.key === 'Enter') searchYouTube(); });
  document.addEventListener('pointerdown', primeCompletionAudio, { once: true });
  document.addEventListener('keydown', primeCompletionAudio, { once: true });
  el['load-more-results'].addEventListener('click', () => void searchYouTube({ loadMore: true }));
  el['mode-video'].addEventListener('click', () => setSearchMode('video'));
  el['mode-music'].addEventListener('click', () => setSearchMode('music'));
  el['history-toggle'].addEventListener('click', showHistory);
  el['open-file'].addEventListener('click', openLocalFile);
  el['clear-media'].addEventListener('click', clearMedia);
  el['open-youtube-browser'].addEventListener('click', openSelectedYouTubeInBrowser);
  el['back-to-results'].addEventListener('click', returnToResults);
  el['back-to-browse'].addEventListener('click', returnToResults);
  el['export-mp4-button'].addEventListener('click', () => void exportClip('mp4'));
  el['export-mp3-button'].addEventListener('click', () => void exportClip('mp3'));
  el['quality-select'].addEventListener('change', updateExportButton);
  el['settings-status'].textContent = '';
  el['choose-output-folder'].addEventListener('click', () => {
    const result = window.cep?.fs?.showOpenDialogEx(true, true, 'Choose download location', state.pendingOutputFolder || '', [], 'Folder', 'Choose');
    if (!result) return showToast('CEP folder picker is unavailable.', true);
    if (result.err !== 0) return showToast(`Folder picker failed (${result.err}).`, true);
    const folder = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!folder) return;
    state.pendingOutputFolder = folder;
    el['setting-output-label'].textContent = folder;
  });
  el['clip-menu-toggle'].addEventListener('click', toggleClipMenu);
  el['set-start'].addEventListener('click', setInPoint);
  el['set-end'].addEventListener('click', setOutPoint);
  el['preview-clip'].addEventListener('click', togglePreviewClip);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.trim-toolbar')) closeClipMenu();
  });
  window.addEventListener('message', receiveYouTubePlayerMessage);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.settings?.pausePreviewWhenHidden !== false) {
      el['source-video'].pause();
      if (state.selectedYouTubeId) sendYouTubeCommand('pause');
      state.previewLoop = false;
    }
  });

  el['source-video'].addEventListener('loadedmetadata', () => {
    const duration = Number(el['source-video'].duration);
    if (Number.isFinite(duration) && duration > 0) {
      if (!state.media || state.duration <= 0) {
        state.duration = duration;
        state.start = 0;
        state.end = duration;
      }
      renderTimeline();
    }
  });
  el['source-video'].addEventListener('timeupdate', () => {
    state.playhead = Number(el['source-video'].currentTime) || 0;
    if (state.previewLoop && state.playhead >= state.end) {
      el['source-video'].currentTime = state.start;
      state.playhead = state.start;
    }
    renderTimeline();
  });
  el['source-video'].addEventListener('error', () => {
    if (state.sourcePath) showToast('Premiere preview could not decode this file. The backend may still support exporting it.', true);
  });

  el['timeline'].addEventListener('click', (event) => {
    if (event.target.closest('.range-handle') || state.dragging || !state.duration || (!state.sourcePath && !state.selectedYouTubeId)) return;
    seekPlayhead(timelinePosition(event) * state.duration);
  });
  el['timeline'].addEventListener('keydown', (event) => {
    if (event.target !== el['timeline'] || !state.duration || (!state.sourcePath && !state.selectedYouTubeId)) return;
    const step = event.shiftKey ? 1 : 0.1;
    let next = state.playhead;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += step;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = state.duration;
    else return;
    event.preventDefault(); seekPlayhead(next);
  });
  el['start-handle'].addEventListener('pointerdown', (event) => handlePointerDown('start', event));
  el['end-handle'].addEventListener('pointerdown', (event) => handlePointerDown('end', event));
  el['timeline'].addEventListener('pointermove', handleTimelinePointerMove);
  el['timeline'].addEventListener('pointerup', handleTimelinePointerUp);
  el['timeline'].addEventListener('pointercancel', handleTimelinePointerUp);
  el['start-handle'].addEventListener('keydown', (event) => handleMarkerKey('start', event));
  el['end-handle'].addEventListener('keydown', (event) => handleMarkerKey('end', event));
  el['start-input'].addEventListener('change', () => setMarker('start', el['start-input'].value));
  el['end-input'].addEventListener('change', () => setMarker('end', el['end-input'].value));
  el['reset-range'].addEventListener('click', () => {
    if (!state.duration) return;
    state.previewLoop = false;
    state.start = 0; state.end = state.duration; renderTimeline(); closeClipMenu();
  });
  el['jobs-list'].addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) void handleJobAction(button.dataset.action, button.dataset.id);
  });
}

async function connectBackend() {
  try {
    state.apiBase = safeApiBase(state.apiBase);
    setBackendLabel('Starting backend…');
    const connection = await LocalStreamBackend.connect({ apiBase: state.apiBase, token: state.token });
    if (connection.token && connection.token !== state.token) {
      state.token = connection.token;
      localStorage.setItem('local-stream-token', state.token);
    }
    localStorage.setItem('local-stream-api', state.apiBase);
    await checkBackend();
    await pollJobs();
  } catch (error) {
    state.backendReady = false;
    setBackendLabel('Backend setup needed', 'error');
    updateExportButton();
    showToast(error.message, true);
  }
}

function initialize() {
  if (state.initialized) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
    return;
  }
  state.initialized = true;
  if (typeof CSInterface === 'function') state.csInterface = new CSInterface();
  cacheElements();
  el['footer-version'].textContent = '0.2.0 · Premiere CEP';
  bindEvents();
  renderTimeline();
  void connectBackend();
  state.pollTimer = setInterval(pollJobs, 1800);
}

if (document.readyState !== 'loading') initialize();
else document.addEventListener('DOMContentLoaded', initialize, { once: true });
