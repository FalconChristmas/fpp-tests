import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, readFile } from './settings-file';
import { usesPipewireConfig } from './pw-config-files';

// POST /api/pipewire/audio/routing is the Routing Matrix's Save: for each
// input group named, which output groups it feeds and at what level, written
// into pipewire-input-groups.json (www/api/controllers/pipewire.php
// SaveRoutingMatrix; the matrix's own round trip is in
// pw-input-groups-routing.spec.ts).  What it does with a save it cannot use.
// Nothing is applied: the file is the receiving end.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const FILE = 'pipewire-input-groups.json';
const write = usesPipewireConfig(FILE);
const path = `${MEDIA}/config/${FILE}`;
const stored = () => JSON.parse(readFile(path));
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });

const mics = { id: 1, name: 'Mics', enabled: true, members: [{ type: 'capture' }], outputs: [5], routing: { '5': { volume: 80, mute: false } } };
const music = { id: 2, name: 'Music', enabled: true, members: [], outputs: [5, 6], routing: { '5': { volume: 100, mute: false }, '6': { volume: 40, mute: true } } };
const seed = () => write(FILE, { somethingElse: 'kept', inputGroups: [mics, music] });

test('the groups a save names get its routes, clamped to 0-100, and the others keep theirs', async ({ request }) => {
  seed();
  const r = await request.post('/api/pipewire/audio/routing', { data: { routes: [
    { inputGroupId: 1, outputGroupId: 5, connected: false, volume: 250, mute: true },
    { inputGroupId: 1, outputGroupId: 6, connected: true, volume: -4 },
    { inputGroupId: 1, outputGroupId: 7, connected: true },
    { inputGroupId: 9, outputGroupId: 5, connected: true, volume: 50 },   // no such input group
  ] } });
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: 'OK', message: 'Routing matrix saved' });
  expect(stored()).toEqual({ somethingElse: 'kept', inputGroups: [
    { ...mics, outputs: [6, 7], routing: { '5': { volume: 100, mute: true }, '6': { volume: 0, mute: false }, '7': { volume: 100, mute: false } } },
    music,
  ] });
});

test('a save with no routes, or with no input groups to route, is refused and changes nothing', async ({ request }) => {
  seed();
  const before = readFile(path);
  for (const body of ['{"route": []}', '{"routes": [', '', '7']) {
    const r = await request.post('/api/pipewire/audio/routing', raw(body));
    expect(r.status(), body).toBe(400);
    expect(await r.json(), body).toEqual({ status: 'error', message: 'Missing routes array' });
  }
  expect(readFile(path)).toBe(before);

  write(FILE, { groups: [] });
  let r = await request.post('/api/pipewire/audio/routing', { data: { routes: [{ inputGroupId: 1, outputGroupId: 5, connected: true }] } });
  expect(await r.json()).toEqual({ status: 'error', message: 'Invalid input groups config' });
  expect(stored()).toEqual({ groups: [] });

  inPlayer('rm', '-f', path);
  r = await request.post('/api/pipewire/audio/routing', { data: { routes: [{ inputGroupId: 1, outputGroupId: 5, connected: true }] } });
  expect(await r.json()).toEqual({ status: 'error', message: 'No input groups configured' });
  expect(exists(path), 'an input groups file was made').toBe(false);
});

for (const [what, routes] of [
  ['routes that are not a list', 'everything'],
  ['a route that is not an object', [{ inputGroupId: 2, outputGroupId: 5, connected: true }, 'x']],
  ['a route with no output group', [{ inputGroupId: 1, connected: true, volume: 30 }]],
] as const) {
  test(`${what} is refused, and the saved routing stays`, async ({ request }) => {
    test.fail(true, 'only "there is a routes key" is checked before the routes are used (FUTURE.md)');
    seed();
    const before = readFile(path);
    const r = await request.post('/api/pipewire/audio/routing', { data: { routes } });
    const text = await r.text();
    expect(text).not.toContain('Fatal error');
    expect(readFile(path), `the routing was rewritten (answer ${r.status()} ${text.slice(0, 100)})`).toBe(before);
    expect(r.status()).toBe(400);
  });
}
