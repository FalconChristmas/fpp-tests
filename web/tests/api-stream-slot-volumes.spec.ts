import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// GET /api/pipewire/audio/stream/volumes: what config/pipewire-stream-slots.json
// holds, or no slots when it holds nothing usable.

test.skip(!container, "keeps the run-web.sh container's stream slot config");

const FILE = `${MEDIA}/config/pipewire-stream-slots.json`;
let before: string | undefined;
test.beforeEach(() => { before = exists(FILE) ? readFile(FILE) : undefined; });
test.afterEach(() => {
  if (before === undefined) inPlayer('rm', '-f', FILE);
  else putFile(FILE, before);
});

const volumes = async (request: any) => (await request.get('/api/pipewire/audio/stream/volumes')).json();

test('the volumes stored are what it answers', async ({ request }) => {
  const stored = { slots: { 1: { volume: 42 }, 3: { volume: 7 } } };
  putFile(FILE, JSON.stringify(stored));
  expect(await volumes(request)).toEqual(JSON.parse(JSON.stringify(stored)));
});

test('a missing file, broken JSON and JSON with no slots all answer no slots', async ({ request }) => {
  inPlayer('rm', '-f', FILE);
  expect(await volumes(request), 'no file').toEqual({ slots: [] });
  putFile(FILE, '{ not json');
  expect(await volumes(request), 'broken JSON').toEqual({ slots: [] });
  putFile(FILE, '{"other": 1}');
  expect(await volumes(request), 'no slots key').toEqual({ slots: [] });
});
