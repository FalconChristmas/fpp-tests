import { test, expect } from './fixtures';

// Regression: c03fa1d3e ("Don't modify total_duration when returning a
// playlist via API").  GET /api/playlist/<name> turned the playlist's
// playlistInfo.total_duration into human_playtime() text ("00m:08s") before
// returning it, so whatever read the playlist back -- the editor, xLights, a
// script that POSTs it again -- got a string where it had stored seconds.

test('a playlist read back from the API has its total duration in seconds', async ({ request }) => {
  const NAME = 'fpp-tests-total-duration';
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: {
      name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [],
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 8 }],
      playlistInfo: { total_duration: 8, total_items: 1 },
    },
  });
  expect(r.ok(), await r.text()).toBe(true);
  try {
    const got = await (await request.get(`/api/playlist/${NAME}`)).json();
    // The control: it is the playlist that was saved.
    expect(got.mainPlaylist).toHaveLength(1);
    expect(got.playlistInfo.total_duration).toBe(8);
  } finally {
    await request.delete(`/api/playlist/${NAME}`);
  }
});
