import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, keepingFile } from './privacy-helpers';

// The usage statistics payload counts the player's models (GET
// /api/statistics/usage?force=1, "models": {"count": n}), from fppd's
// /api/models.  A player with a huge model list is not asked for all of it:
// the statistics collector reads the answer only when it is within 50KB
// (fetch_api_with_limit), and reports no models otherwise.
//
// Regression: 3173a9f23 ("Limit model size when downloading stats").  The
// collector read the whole body whatever its size.  fppd only reads
// model-overlays.json at start, so each case saves the models and restarts
// fppd (quickly, in place) before the payload is asked for.

test.skip(!container, 'rewrites the models file and restarts fppd inside the run-web.sh container');
test.setTimeout(180_000);

const FILE = `${MEDIA}/config/model-overlays.json`;

function models(count: number) {
  return {
    models: Array.from({ length: count }, (_, i) => ({
      Name: `fpp-tests-model-${i}`, Type: 'Channel', ChannelCount: 30, StartChannel: 1 + i * 30,
      ChannelCountPerNode: 3, StringCount: 1, StrandsPerString: 1, Orientation: 'horizontal',
      StartCorner: 'TL', Description: 'x'.repeat(30),
    })),
  };
}

// Save the models, restart fppd, and wait until /api/models shows them.
async function useModels(request: any, count: number) {
  const r = await request.post('/api/models', { data: models(count) });
  expect(r.ok(), await r.text()).toBe(true);
  const restart = await request.get('/api/system/fppd/restart?quick=1');
  expect(restart.ok()).toBe(true);
  await expect.poll(async () => {
    try {
      const list = await (await request.get('/api/models', { timeout: 5_000 })).json();
      return list.filter((m: any) => m.Name.startsWith('fpp-tests-model-')).length;
    } catch { return -1; }
  }, { timeout: 90_000, intervals: [1000] }).toBe(count);
}

async function statsModels(request: any) {
  const r = await request.get('/api/statistics/usage?force=1', { timeout: 60_000 });
  const text = await r.text();
  expect(r.ok(), text).toBe(true);
  return JSON.parse(text).models;
}

test('the models are counted when their list is small and left out when it is over 50KB', async ({ request }) => {
  await keepingFile(FILE, async () => {
    try {
      // The control: a short list is counted.
      await useModels(request, 5);
      expect((await statsModels(request)).count).toBe(5);

      // A list of about 80KB of JSON, which fppd serves whole.
      await useModels(request, 300);
      const body = await (await request.get('/api/models')).text();
      expect(body.length, 'the model list the collector would read').toBeGreaterThan(60_000);
      expect((await statsModels(request)).count, 'an oversized model list was read and counted').toBe(0);
    } finally {
      await request.put('/api/settings/restartFlag', { data: '0' });
    }
  });
  // fppd is left running with the models the file had before.
  await request.get('/api/system/fppd/restart?quick=1');
  await expect.poll(async () => {
    try { return (await request.get('/api/fppd/status', { timeout: 5_000 })).ok(); } catch { return false; }
  }, { timeout: 90_000, intervals: [1000] }).toBe(true);
});
