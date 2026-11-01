import { test, expect } from './fixtures';
import { container } from './container';
import { MEDIA, keepingFile } from './privacy-helpers';

// Saving the Pixel Overlay Models (POST /api/models) raises the restart flag
// and leaves fppd's running models alone: framebuffers and the like may still
// be in use, so they are picked up at the next fppd start.
//
// Regression: b93a077df ("Set the restart flag if overlay models change
// instead of trying to reload").  The save reloaded the model map in the
// running fppd, which swapped models out from under their users.

test.skip(!container, 'rewrites the models file inside the run-web.sh container');

const FILE = `${MEDIA}/config/model-overlays.json`;
const NAME = 'fpp-tests-restart-flag';
const restartFlag = async (request: any) =>
  String((await (await request.get('/api/settings/restartFlag')).json()).value ?? '0');
const listed = async (request: any) =>
  ((await (await request.get('/api/models')).json()) as any[]).map((m) => m.Name);

test('saving the models asks for an fppd restart and does not reload them in the running fppd', async ({ request }) => {
  await keepingFile(FILE, async () => {
    try {
      await request.put('/api/settings/restartFlag', { data: '0' });
      expect(await listed(request)).not.toContain(NAME);

      const r = await request.post('/api/models', { data: { models: [{
        Name: NAME, Type: 'Channel', ChannelCount: 30, StartChannel: 1, ChannelCountPerNode: 3,
        StringCount: 1, StrandsPerString: 1, Orientation: 'horizontal', StartCorner: 'TL',
      }] } });
      expect(r.ok(), await r.text()).toBe(true);

      await expect.poll(() => restartFlag(request), { message: 'the restart flag after a models save', timeout: 10_000 }).toBe('1');
      expect(await listed(request), 'fppd reloaded the models in place').not.toContain(NAME);
    } finally {
      await request.put('/api/settings/restartFlag', { data: '0' });
    }
  });
});
