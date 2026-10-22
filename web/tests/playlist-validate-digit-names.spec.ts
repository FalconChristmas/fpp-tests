import { test, expect } from './fixtures';

// A playlist whose name is all digits, as validated for the Playlists page.

test('a playlist named with digits only is validated like any other', async ({ request }) => {
  // Regression: 2c9eb5b08 (#3131).  PHP turns an all-digit array key such as
  // "2026" into an int; the validator passed that on, the file lookup refused a
  // non-string, and the playlist came back as "Playlist file could not be
  // read", under a numeric name.
  const name = '2026';
  const playlist = {
    name, desc: 'fpp-tests digits', repeat: 0, loopCount: 0, leadIn: [],
    mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 1 }], leadOut: [],
  };
  try {
    const saved = await request.post(`/api/playlist/${name}`, { data: playlist });
    expect(saved.ok(), `saving ${name}: ${saved.status()}`).toBe(true);
    const all = await (await request.get('/api/playlists/validate')).json();
    const p = all.find((x: { name: unknown }) => String(x.name) === name);
    expect(p, JSON.stringify(all)).toBeTruthy();
    expect(p.name, JSON.stringify(p)).toBe(name);
    expect(p.valid, JSON.stringify(p)).toBe(true);
  } finally {
    await request.delete(`/api/playlist/${name}`);
  }
});
