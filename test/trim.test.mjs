import test from 'node:test';
import assert from 'node:assert/strict';
import '../plugin/trim.js';
import { formatTimestamp, parseIsoDuration, sanitizeFilename, validateTrim, youtubeJobTitle } from '../backend/lib.mjs';

const { formatTime, parseTime, normalizeRange } = globalThis.LocalStreamTrim;

test('fractional timestamp input is parsed while the player rounds displayed time', () => {
  assert.equal(parseTime('02:15'), 135);
  assert.equal(parseTime('00:03:40.125'), 220.125);
  assert.equal(parseTime('14.75'), 14.75);
  assert.equal(parseTime('not time'), Number.NaN);
  assert.equal(formatTime(59.9999), '01:00');
  assert.equal(formatTimestamp(3599.9999), '01:00:00.000');
});

test('range helpers keep marker order and clamp values to the source duration', () => {
  assert.deepEqual(normalizeRange(-2, 100, 20), { start: 0, end: 20 });
  assert.deepEqual(normalizeRange(9.999, 10, 10), { start: 10 - 1 / 60, end: 10 });
  assert.deepEqual(validateTrim(135, 220, 600), { start: 135, end: 220, duration: 85 });
  assert.throws(() => validateTrim(220, 135, 600), /Choose a clip range/);
  assert.throws(() => validateTrim(0, 601, 600), /Choose a clip range/);
});

test('filename and YouTube duration helpers sanitize display values', () => {
  assert.equal(sanitizeFilename('A:/b?c*'), 'A b c');
  assert.equal(parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseIsoDuration('P3D'), null);
});

test('pasted YouTube links use the downloaded video title for output names', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(youtubeJobTitle('YouTube video', 'A real &amp; useful title', id), 'A real & useful title');
  assert.equal(youtubeJobTitle('YouTube video', '', id), id);
  assert.equal(youtubeJobTitle('Search result title', 'Another title', id), 'Search result title');
  assert.equal(youtubeJobTitle('Untitled video', 'A:/b?c*', id), 'A b c');
});
