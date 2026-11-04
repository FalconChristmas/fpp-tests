import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// GET /api/pipewire/audio/routing/presets/names: the Pipewire routing presets
// saved on the player, for the pickers that name one.

test.skip(!container, "puts presets in the run-web.sh container's config");

const DIR = `${MEDIA}/config/routing-presets`;
const NAMES = ['fpp-tests-b', 'fpp-tests-a'];

test.afterEach(() => {
  inPlayer('rm', '-f', ...NAMES.map((n) => `${DIR}/${n}.json`), `${DIR}/fpp-tests-c.txt`);
});

test('the names are sorted, without .json, and only of .json files', async ({ request }) => {
  inPlayer('mkdir', '-p', DIR);
  for (const n of NAMES) putFile(`${DIR}/${n}.json`, '{}');
  putFile(`${DIR}/fpp-tests-c.txt`, 'not a preset');
  const names: string[] = await (await request.get('/api/pipewire/audio/routing/presets/names')).json();
  expect(names.filter((n) => n.includes('fpp-tests'))).toEqual(['fpp-tests-a', 'fpp-tests-b']);
});
