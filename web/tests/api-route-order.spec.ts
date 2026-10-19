import { test, expect } from './fixtures';

// A playlist named "start" (in any case) is saved by POST /api/playlist/start,
// and an item can be inserted into it.
//
// limonade compiles each ':param' segment of a route to an optional group and
// matches case-insensitively, first registered route first, so
// POST /playlist/:PlaylistName/start also matches POST /playlist/start. fpp
// 77efc7561 registered the new POST start routes above POST
// /playlist/:PlaylistName, and saving such a playlist started an unnamed one
// instead. Fixed in fpp 361c319e2 ("fix(api): a POST to a playlist or sequence
// named "start" reaches its own route"), which puts them below it, as the GET
// routes already were.

const playlist = (name: string) => ({
  name, desc: 'fpp-tests route order', repeat: 0, loopCount: 0,
  leadIn: [], mainPlaylist: [], leadOut: [],
});

for (const name of ['start', 'Start']) {
  test(`a playlist named "${name}" is saved, not started`, async ({ request }) => {
    try {
      const saved = await request.post(`/api/playlist/${name}`, { data: playlist(name) });
      expect(saved.ok(), `POST /api/playlist/${name}: ${saved.status()} ${await saved.text()}`).toBe(true);

      const got = await request.get(`/api/playlist/${name}`);
      expect(got.status(), `GET /api/playlist/${name} after saving it`).toBe(200);
      expect((await got.json()).desc).toBe('fpp-tests route order');

      const item = { type: 'pause', enabled: 1, playOnce: 0, duration: 1 };
      const inserted = await request.post(`/api/playlist/${name}/mainPlaylist/item`, { data: item });
      expect(inserted.ok(), `POST /api/playlist/${name}/mainPlaylist/item: ${inserted.status()}`).toBe(true);
      const after = await (await request.get(`/api/playlist/${name}`)).json();
      expect(after.mainPlaylist?.length, 'the inserted item').toBe(1);
    } finally {
      await request.delete(`/api/playlist/${name}`);
    }
  });
}
