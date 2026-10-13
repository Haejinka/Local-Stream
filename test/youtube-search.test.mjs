import test from 'node:test';
import assert from 'node:assert/strict';
import { isYouTubeVideoSearchItem } from '../backend/lib.mjs';

test('YouTube search only accepts video results with usable video IDs', () => {
  const video = { id: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' } };
  const channel = { id: { kind: 'youtube#channel', channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' } };
  const playlist = { id: { kind: 'youtube#playlist', playlistId: 'PL123' } };

  assert.equal(isYouTubeVideoSearchItem(video), true);
  assert.equal(isYouTubeVideoSearchItem(channel), false);
  assert.equal(isYouTubeVideoSearchItem(playlist), false);
  assert.equal(isYouTubeVideoSearchItem({ id: { kind: 'youtube#video', videoId: 'bad-id' } }), false);
  assert.equal(isYouTubeVideoSearchItem({ snippet: { title: 'Channel without an ID' } }), false);
});
