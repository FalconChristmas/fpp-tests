import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Playlist names with a space or a plus sign in them, and robots.txt.

const playlist = (name: string) => ({
  name, desc: 'fpp-tests odd names', repeat: 0, loopCount: 0,
  leadIn: [], mainPlaylist: [], leadOut: [],
});

for (const name of ['fpp tests spaced', 'fpp-tests+plus']) {
  test(`a playlist named "${name}" can be read, added to and deleted`, async ({ request }) => {
    // Regression: 3378ce7e8 (names were not url-decoded, so a space never
    // matched its file) and de74a1810 (a plus sign could not be deleted: urldecode
    // turned it into a space).
    const url = `/api/playlist/${encodeURIComponent(name)}`;
    try {
      const saved = await request.post(url, { data: playlist(name) });
      expect(saved.ok(), `POST ${url}: ${saved.status()} ${await saved.text()}`).toBe(true);
      // The file is under the name as sent: a plus sign did not become a space.
      if (container) {
        expect(inPlayer('sh', '-c', `test -e "/home/fpp/media/playlists/${name}.json" && echo there || echo missing`).trim()).toBe('there');
      }
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

test('a playlist name is decoded once: encoded once it is found, encoded again it is another name', async ({ request }) => {
  // a2c6be1f5.  3378ce7e8 decoded the name in the handlers on top of the web server's and
  // the router's decode, so a name encoded three times was found too, and
  // one holding "%41" was not.  The path is now decoded once (no client was
  // found that over-encodes); api-path-decoded-once.spec.ts has the "%41" case.
  const name = 'fpp tests thrice';
  const once = `/api/playlist/${encodeURIComponent(name)}`;
  const thrice = `/api/playlist/${encodeURIComponent(encodeURIComponent(encodeURIComponent(name)))}`;
  try {
    expect((await request.post(once, { data: playlist(name) })).ok()).toBe(true);
    const got = await request.get(once);
    expect(got.status()).toBe(200);
    expect((await got.json()).name).toBe(name);
    expect((await request.get(thrice)).status(), `GET ${thrice}`).toBe(404);
  } finally {
    await request.delete(once);
  }
});

test('robots.txt asks crawlers to index nothing', async ({ request }) => {
  // Regression: fecaa3b21.  An exposed player could be listed by search engines.
  const r = await request.get('/robots.txt');
  expect(r.status()).toBe(200);
  const body = await r.text();
  expect(body).toMatch(/User-agent:\s*\*/);
  expect(body).toMatch(/Disallow:\s*\/\s*$/m);
});
