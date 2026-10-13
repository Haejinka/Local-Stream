import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../backend/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const token = 'f319ac20c9b3473aa349a897184bc234a7acda9d75a6dc6d';
const ffmpeg = process.env.LOCAL_STREAM_TEST_FFMPEG || (process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg');
const ffprobe = process.env.LOCAL_STREAM_TEST_FFPROBE || (process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffprobe.exe' : 'ffprobe');

async function getUnusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForHealth(base, child, getOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${getOutput()}`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Backend did not become ready: ${getOutput()}`);
}

async function request(base, apiToken, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json();
  return { response, data };
}

async function waitForJob(base, jobId, expected) {
  const deadline = Date.now() + 40_000;
  let latest;
  while (Date.now() < deadline) {
    const { response, data } = await request(base, token, '/api/jobs');
    assert.equal(response.status, 200);
    latest = data.find((job) => job.id === jobId);
    if (latest && ['completed', 'failed', 'cancelled'].includes(latest.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(latest, `job ${jobId} should appear in history`);
  assert.equal(latest.status, expected, latest.error || 'job did not finish in the expected state');
  return latest;
}

test('localhost API analyzes, trims, converts, verifies, retries, and persists local media jobs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-stream-test-'));
  const dataDir = path.join(root, 'app-data');
  const mediaDir = path.join(root, 'input');
  const sourcePath = path.join(mediaDir, 'Synthetic Source.mp4');
  await fs.mkdir(mediaDir, { recursive: true });
  await runProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', sourcePath
  ], { timeoutMs: 30_000 });

  const port = await getUnusedPort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(project, 'backend', 'server.mjs')], {
    cwd: project,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOCAL_STREAM_DATA_DIR: dataDir, LOCAL_STREAM_PORT: String(port), LOCAL_STREAM_TOKEN: token, USERPROFILE: root, LOCALAPPDATA: dataDir }
  });
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-6000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitForHealth(base, child, () => output);
  const unauth = await request(base, '', '/api/jobs');
  assert.equal(unauth.response.status, 401);
  const wrongToken = await request(base, 'short', '/api/jobs');
  assert.equal(wrongToken.response.status, 401);

  const analysis = await request(base, token, '/api/analyze', { method: 'POST', body: { path: sourcePath } });
  assert.equal(analysis.response.status, 200, analysis.data.error);
  assert.equal(analysis.data.hasVideo, true);
  assert.equal(analysis.data.hasAudio, true);
  assert.ok(Math.abs(analysis.data.duration - 4) < 0.1);

  const invalidTrim = await request(base, token, '/api/jobs', {
    method: 'POST', body: { path: sourcePath, start: 2, end: 1, format: 'mp4' }
  });
  assert.equal(invalidTrim.response.status, 400);

  const mp4Created = await request(base, token, '/api/jobs', {
    method: 'POST', body: { path: sourcePath, title: 'Trim check', start: 0.625, end: 2.375, format: 'mp4', quality: 'best' }
  });
  assert.equal(mp4Created.response.status, 202, mp4Created.data.error);
  const mp4Job = await waitForJob(base, mp4Created.data.id, 'completed');
  assert.equal(path.extname(mp4Job.outputPath).toLowerCase(), '.mp4');
  assert.ok(Math.abs(mp4Job.verifiedDuration - 1.75) < 0.35);
  assert.ok((await fs.stat(mp4Job.outputPath)).size > 256);
  const thumbnailResponse = await fetch(`${base}/api/jobs/${mp4Job.id}/thumbnail`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(thumbnailResponse.status, 200);
  assert.match(thumbnailResponse.headers.get('content-type') || '', /^image\/jpeg/);
  const thumbnail = Buffer.from(await thumbnailResponse.arrayBuffer());
  assert.ok(thumbnail.length > 256);
  assert.equal(thumbnail.subarray(0, 2).toString('hex'), 'ffd8');
  const mp4Probe = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp4Job.outputPath]);
  assert.ok(Math.abs(Number(mp4Probe.stdout.trim()) - 1.75) < 0.35);

  const mp3Created = await request(base, token, '/api/jobs', {
    method: 'POST', body: { path: sourcePath, title: 'Audio check', start: 1.125, end: 3.5, format: 'mp3', bitrate: '256k' }
  });
  assert.equal(mp3Created.response.status, 202, mp3Created.data.error);
  const mp3Job = await waitForJob(base, mp3Created.data.id, 'completed');
  assert.equal(path.extname(mp3Job.outputPath).toLowerCase(), '.mp3');
  assert.ok(Math.abs(mp3Job.verifiedDuration - 2.375) < 0.35);
  assert.ok((await fs.stat(mp3Job.outputPath)).size > 256);
  const audioThumbnail = await fetch(`${base}/api/jobs/${mp3Job.id}/thumbnail`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(audioThumbnail.status, 404);

  const badBinarySetting = await request(base, token, '/api/settings', {
    method: 'POST', body: { ffmpegPath: path.join(root, 'missing-ffmpeg.exe') }
  });
  assert.equal(badBinarySetting.response.status, 200);
  const failedCreated = await request(base, token, '/api/jobs', {
    method: 'POST', body: { path: sourcePath, start: 0, end: 1, format: 'mp3' }
  });
  assert.equal(failedCreated.response.status, 202);
  const failedJob = await waitForJob(base, failedCreated.data.id, 'failed');
  assert.match(failedJob.error, /spawn|ENOENT|not found/i);
  await request(base, token, '/api/settings', { method: 'POST', body: { ffmpegPath: '' } });
  const retried = await request(base, token, `/api/jobs/${failedJob.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retried.response.status, 202);
  const retriedJob = await waitForJob(base, failedJob.id, 'completed');
  assert.ok(retriedJob.outputPath);

  const youtubeWithoutKey = await request(base, token, '/api/youtube/search', { method: 'POST', body: { query: 'example' } });
  assert.equal(youtubeWithoutKey.response.status, 409);
  assert.match(youtubeWithoutKey.data.error, /YouTube Data API v3 key/);

  const settingsOnDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  const savedJobs = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
  assert.equal(settingsOnDisk.ffmpegPath, '');
  assert.ok(savedJobs.some((job) => job.id === mp4Job.id && job.status === 'completed'));
  assert.ok(savedJobs.some((job) => job.id === mp3Job.id && job.status === 'completed'));
});
