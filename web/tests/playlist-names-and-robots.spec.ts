import { test, expect } from './fixtures';

// Playlist names with a space or a plus sign in them, and robots.txt.

const playlist = (name: string) => ({
  name, desc: 'fpp-tests odd names', repeat: 0, loopCount: 0,
  leadIn: [], mainPlaylist: [], leadOut: [],
});

for (const name of ['fpp tests spaced', 'fpp-tests+plus']) {
  test(`a playlist named "${name}" can be read, added to and deleted`, async ({ request }) => {
    // Regression: 3378ce7e8 (names were not url-decoded, so a space never
    // matched its file) and de74a1810 (a plus sign could not be deleted).
    const url = `/api/playlist/${encodeURIComponent(name)}`;
    try {
      const saved = await request.post(url, { data: playlist(name) });
      expect(saved.ok(), `POST ${url}: ${saved.status()} ${await saved.text()}`).toBe(true);
      const got = await request.get(url);
      expect(got.status(), `GET ${url}`).toBe(200);
      const item = { type: 'pause', enabled: 1, playOnce: 0, duration: 1 };
      const inserted = await request.post(`${url}/mainPlaylist/item`, { data: item });
      expect(inserted.ok(), `POST ${url}/mainPlaylist/item: ${inserted.status()}`).toBe(true);
      const after = await (await request.get(url)).json();
      expect(after.mainPlaylist?.length).toBe(1);
      const del = await request.delete(url);
      expect(del.ok(), `DELETE ${url}: ${del.status()}`).toBe(true);
      expect((await request.get(url)).status(), 'after the delete').toBe(404);
    } finally {
      await request.delete(url);
    }
  });
}

test('robots.txt asks crawlers to index nothing', async ({ request }) => {
  // Regression: fecaa3b21.  An exposed player could be listed by search engines.
  const r = await request.get('/robots.txt');
  expect(r.status()).toBe(200);
  const body = await r.text();
  expect(body).toMatch(/User-agent:\s*\*/);
  expect(body).toMatch(/Disallow:\s*\/\s*$/m);
});
