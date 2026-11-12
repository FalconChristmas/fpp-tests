import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// POST /api/audio/cardaliases stores the names a user gives the sound cards
// ({"aliases": {"<card id>": "<name>"}}, www/api/controllers/audioaliases.php
// SaveAudioCardAliases); every audio list in the UI shows them.  The whole set
// is replaced by a save.  The file in the config folder is read back.

test.skip(!container, "keeps the run-web.sh container's alias file");

const FILE = `${MEDIA}/config/audio-card-aliases.json`;
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });
const stored = () => JSON.parse(readFile(FILE));
let before: string | undefined;

test.beforeEach(() => { before = exists(FILE) ? readFile(FILE) : undefined; });
test.afterEach(() => { if (before === undefined) inPlayer('rm', '-f', FILE); else putFile(FILE, before); });

const SEEDED = JSON.stringify({ aliases: { 'fpp-tests-card-a': 'Front of house', 'fpp-tests-card-b': 'Garage' } });

test('aliases are stored trimmed, an empty one is dropped, and an over-long one is cut at 128', async ({ request }) => {
  const r = await request.post('/api/audio/cardaliases', { data: { aliases: {
    'fpp-tests-card-a': '  Stage left  ',
    'fpp-tests-card-b': '',
    '  fpp-tests-card-c ': 'x'.repeat(200),
    ['k'.repeat(129)]: 'a card id nobody has',
    '   ': 'no card',
  } } });
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: 'ok', count: 2 });
  expect(stored()).toEqual({ aliases: { 'fpp-tests-card-a': 'Stage left', 'fpp-tests-card-c': 'x'.repeat(128) } });

  // A card that is not plugged in still shows, with its alias, so it can be renamed or cleared.
  const got = await (await request.get('/api/audio/cardaliases')).json();
  expect(got.aliases).toEqual({ 'fpp-tests-card-a': 'Stage left', 'fpp-tests-card-c': 'x'.repeat(128) });
  expect(got.cards).toContainEqual({ cardNum: -1, cardId: 'fpp-tests-card-a', cardName: '(not currently connected)', alias: 'Stage left' });
});

test('a save replaces the whole set, and an empty set clears it', async ({ request }) => {
  putFile(FILE, SEEDED);
  let r = await request.post('/api/audio/cardaliases', { data: { aliases: { 'fpp-tests-card-b': 'Shed' } } });
  expect(await r.json()).toEqual({ status: 'ok', count: 1 });
  expect(stored()).toEqual({ aliases: { 'fpp-tests-card-b': 'Shed' } });
  r = await request.post('/api/audio/cardaliases', { data: { aliases: {} } });
  expect(await r.json()).toEqual({ status: 'ok', count: 0 });
  expect((await (await request.get('/api/audio/cardaliases')).json()).aliases).toEqual([]);
});

test('a body that is not JSON is refused and the aliases stay', async ({ request }) => {
  putFile(FILE, SEEDED);
  for (const body of ['{"aliases": {', '', '"all"', '7']) {
    const r = await request.post('/api/audio/cardaliases', raw(body));
    expect(r.status(), body).toBe(400);
    expect(readFile(FILE), body).toBe(SEEDED);
  }
});

test('an alias file that cannot be read as aliases is no aliases, not an error', async ({ request }) => {
  for (const content of ['', 'not json', '{"aliases": "x"}', '[]']) {
    putFile(FILE, content);
    const r = await request.get('/api/audio/cardaliases');
    expect(r.status(), content).toBe(200);
    expect((await r.json()).aliases, content).toEqual([]);
  }
});

for (const [what, body] of [
  ['an object with no aliases in it', '{}'],
  ['a misspelt key', '{"alias": {"fpp-tests-card-a": "New"}}'],
  ['a list', '[]'],
  ['aliases that are not an object', '{"aliases": "none"}'],
] as const) {
  test(`${what} does not clear the saved aliases`, async ({ request }) => {
    test.fail(true, 'anything that decodes to an array is saved as "no aliases" (FUTURE.md)');
    putFile(FILE, SEEDED);
    const r = await request.post('/api/audio/cardaliases', raw(body));
    expect(readFile(FILE), `the aliases were replaced (answer ${r.status()} ${await r.text()})`).toBe(SEEDED);
    expect(r.status()).toBe(400);
  });
}
