import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// The read side of the old events API (www/api/controllers/events.php):
//   GET /api/events        every event file, parsed, keyed by its id
//   GET /api/events/ids    id -> "MM / mm - name", for a list to pick from
//   GET /api/events/<id>   the event file itself
// The files are the .fevt files of the events folder; events.spec.ts has the
// trigger that works.  These are still what a plugin or an old remote asks.

test.skip(!container, 'seeds event files inside the run-web.sh container');

const DIR = `${MEDIA}/events`;
const named = { majorId: 61, minorId: 2, name: 'fpp-tests events read', command: 'Volume Set', args: ['70'] };
const unnamed = { majorId: 61, minorId: 3, name: '' };

const clean = () => inPlayer('sh', '-c', `rm -f -- "${DIR}"/61_0?.fevt "${DIR}"/fpp-tests-events-* "${MEDIA}"/fpp-tests-events-*`);
test.beforeEach(() => {
  inPlayer('mkdir', '-p', DIR);
  clean();
  putFile(`${DIR}/61_02.fevt`, JSON.stringify(named));
  putFile(`${DIR}/61_03.fevt`, JSON.stringify(unnamed));
  putFile(`${DIR}/61_04.fevt`, 'not json at all');
  // Not an event file: never listed.
  putFile(`${DIR}/fpp-tests-events-notes.txt`, JSON.stringify(named));
});
test.afterEach(clean);

test('the list has every event file by id, parsed, and nothing else in the folder', async ({ request }) => {
  const r = await request.get('/api/events');
  expect(r.status()).toBe(200);
  const all = await r.json();
  expect(all['61_02']).toEqual(named);
  expect(all['61_03']).toEqual(unnamed);
  // A file that does not parse is listed, with nothing in it.
  expect(all).toHaveProperty('61_04', null);
  expect(Object.keys(all).filter((k) => k.includes('fpp-tests-events'))).toEqual([]);
});

test('the id list names each event, and falls back to the id for one with no name', async ({ request }) => {
  const ids = await (await request.get('/api/events/ids')).json();
  expect(ids['61_02']).toBe('61 / 02 - fpp-tests events read');
  expect(ids['61_03']).toBe('61_03');
  expect(ids['61_04']).toBe('61_04');
  expect(Object.keys(ids).filter((k) => k.includes('fpp-tests-events'))).toEqual([]);
});

test('one event is served as its file, and an id that is not an event file is a 404', async ({ request }) => {
  const one = await request.get('/api/events/61_02');
  expect(one.status()).toBe(200);
  expect(await one.json()).toEqual(named);
  expect(await (await request.get('/api/events/61_04')).text()).toBe('not json at all');

  expect((await request.get('/api/events/61_09')).status()).toBe(404);
  // Only .fevt files, and only the events folder's.
  expect((await request.get('/api/events/fpp-tests-events-notes.txt')).status()).toBe(404);
  putFile(`${MEDIA}/fpp-tests-events-out.fevt`, 'OUTSIDE');
  for (const id of ['..%252Ffpp-tests-events-out', '..%5Cfpp-tests-events-out', '%2E%2E%2Ffpp-tests-events-out']) {
    const r = await request.get(`/api/events/${id}`);
    expect(r.status(), id).toBeGreaterThanOrEqual(400);
    expect(await r.text(), id).not.toContain('OUTSIDE');
  }
});

test('a missing event is answered without the path of the events folder', async ({ request }) => {
  test.fail(true, 'the 404 is limonade\'s HTML page, naming the file it looked for (FUTURE.md)');
  const r = await request.get('/api/events/61_09');
  expect(r.status()).toBe(404);
  expect(await r.text()).not.toMatch(/\/[\w.-]+\/events\/61_09\.fevt/);
});

test('triggering an event whose Command Preset is gone, or that has no name, says which', async ({ request }) => {
  // fppd makes the preset from the event file when it starts; these files
  // arrived after that, so there is none.
  let r = await request.post('/api/events/61_02/trigger');
  expect(r.status()).toBe(404);
  expect(await r.json()).toEqual({ status: 'ERROR', message: 'No Command Preset named "fpp-tests events read" (from event 61_02)' });
  for (const id of ['61_03', '61_04']) {
    r = await request.post(`/api/events/${id}/trigger`);
    expect(r.status(), id).toBe(404);
    expect(await r.json(), id).toEqual({ status: 'ERROR', message: `No event ${id}` });
  }
  r = await request.post('/api/events/61%3F02/trigger');
  expect(r.status()).toBe(400);
  expect(await r.json()).toEqual({ status: 'ERROR', message: 'Invalid event id' });
});
