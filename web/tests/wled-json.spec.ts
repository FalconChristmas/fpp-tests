import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// /json/*: the WLED-compatible JSON shim (www/json/), which shows the player
// to the WLED apps as a WLED node with one segment per overlay model.  The
// shim asks the player's own API for the models, effects and status, and
// turns a segment's on/off into the model's overlay state.  run-web.sh's
// player has one overlay model, fpp-tests-matrix (10x5).

test.skip(!container, 'needs the overlay model run-web.sh seeds the player with');

const MODEL = 'fpp-tests-matrix';

async function command(request: APIRequestContext, name: string, ...args: string[]) {
  const r = await request.post('/api/command', { data: { command: name, args } });
  expect(r.ok(), await r.text()).toBe(true);
}
const modelState = async (request: APIRequestContext) =>
  (await (await request.get(`/api/overlays/model/${MODEL}`)).json()).isActive;
async function json(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  expect(r.ok()).toBe(true);
  expect(r.headers()['content-type']).toBe('application/json');
  // Any page may call it: the apps' web views do.
  expect(r.headers()['access-control-allow-origin']).toBe('*');
  return r.json();
}

let uiLevel = '0';
let description = '';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  description = String((await (await request.get('/api/settings/HostDescription')).json()).value ?? '');
  await request.put('/api/settings/uiLevel', { data: '3' });
});
test.afterEach(async ({ request }) => {
  await command(request, 'Overlay Model Effect', MODEL, 'Enabled', 'Stop Effects');
  await request.put(`/api/overlays/model/${MODEL}/state`, { data: { State: 0 } });
  await request.put('/api/settings/HostDescription?skipBackup=1', { data: description });
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

test("/json/info describes the player as a WLED node: its name, version, address and the models' pixels", async ({ request }) => {
  const status = await (await request.get('/api/system/status')).json();
  const effects = await (await request.get('/api/overlays/effects')).json();
  const info = await json(request, '/json/info');
  expect(info).toMatchObject({ brand: 'FPP', product: 'FalconPlayer', ver: status.version, arch: status.platform,
    fxcount: effects.length, palcount: 1, ws: -1 });
  // The pixels are the overlay models': one 10x5 model, one segment.
  expect(info.leds).toMatchObject({ count: 50, maxseg: 1, seglc: [1] });
  // The MAC is eth0's, as WLED gives it: lower case, no colons.
  const mac = inPlayer('cat', '/sys/class/net/eth0/address').trim();
  expect(info.mac).toBe(mac.replace(/:/g, '').toLowerCase());
  expect(info.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  // Named by the host description when there is a real one, else by the
  // host name: the default description, "FPP", says less, and so does none.
  // fppd reports the current setting, which the player holds as "".
  expect(status.host_description).toBe('');
  expect(info.name).toBe(status.host_name);
});

test('/json/info is named by a host description set since fppd started', async ({ request }) => {
  // The description comes from fppd's status, which reports the current
  // HostDescription, so a new one shows without a restart.
  await request.put('/api/settings/HostDescription?skipBackup=1', { data: 'Stage Left' });
  await expect.poll(async () => (await json(request, '/json/info')).name, { timeout: 3000 }).toBe('Stage Left');
});

test('/json/state has a segment per overlay model, on while it is enabled or running an effect', async ({ request }) => {
  const state = await json(request, '/json/state');
  expect(state.on).toBe(false);
  expect(state.seg).toHaveLength(1);
  expect(state.seg[0]).toMatchObject({ id: 0, n: MODEL, start: 0, stop: 50, len: 50, on: false, fx: 0, sel: true });

  // An effect running on the model: the segment is on, its fx is the effect's
  // index in /json/eff.
  const effects = await json(request, '/json/eff');
  expect(effects).toEqual(await (await request.get('/api/overlays/effects')).json());
  const desc = await (await request.get('/api/overlays/effects/Bars')).json();
  await command(request, 'Overlay Model Effect', MODEL, 'Enabled', 'Bars', ...desc.args.map((a: any) => String(a.default ?? '')));
  await expect.poll(async () => (await json(request, '/json/state')).seg[0]).toMatchObject({ on: true, fx: effects.indexOf('Bars') });
  expect((await json(request, '/json/state')).on).toBe(true);

  // /json is the same state, info and effects in one, and the one palette.
  const all = await json(request, '/json');
  expect(Object.keys(all)).toEqual(['state', 'info', 'effects', 'palettes']);
  expect(all.state.seg[0]).toMatchObject({ n: MODEL, on: true });
  expect(all.effects).toEqual(effects);
  expect(all.palettes).toEqual(['Default']);
});

test('a segment turned on or off through /json/state enables or disables its model', async ({ request }) => {
  const post = async (body: unknown) => {
    const r = await request.post('/json/state', { data: body });
    expect(r.ok()).toBe(true);
    return r.json();
  };
  // A segment by id; the answer is the state after it.
  let state = await post({ seg: [{ id: 0, on: true }] });
  expect(state.seg[0].on).toBe(true);
  expect(await modelState(request)).toBe(1);
  // The whole node off: every model.
  state = await post({ on: false });
  expect(state.on).toBe(false);
  expect(await modelState(request)).toBe(0);
  state = await post({ on: true });
  expect(await modelState(request)).toBe(1);
  // A segment that is not there, a segment change with no on in it, and a
  // body that is not JSON change nothing, and still answer with the state.
  await post({ on: false });
  for (const body of [{ seg: [{ id: 5, on: true }] }, { seg: [{ id: 0, fx: 3 }] }]) {
    expect((await post(body)).seg[0].on).toBe(false);
  }
  const bad = await request.post('/json/state', { data: 'not json', headers: { 'Content-Type': 'application/json' } });
  expect(bad.ok()).toBe(true);
  expect((await bad.json()).seg[0].n).toBe(MODEL);
  expect(await modelState(request)).toBe(0);

  // The apps' preflight is answered.
  const pre = await request.fetch('/json/state', { method: 'OPTIONS' });
  expect(pre.ok()).toBe(true);
  expect(pre.headers()['access-control-allow-origin']).toBe('*');
});

test('the palette, node and live endpoints answer as a WLED node with none of those does', async ({ request }) => {
  expect(await json(request, '/json/pal')).toEqual(['Default']);
  expect(await json(request, '/json/nodes')).toEqual([]);
  expect(await json(request, '/json/live')).toEqual({ leds: [], n: 1 });
  const palx = await json(request, '/json/palx');
  expect(palx.m).toBe(0);
  expect(palx.p).toBeDefined();
});

test("/json/palx gives its palettes as WLED does, keyed by the palette's id", async ({ request }) => {
  // WLED answers {"m":..,"p":{"0":[...],...}}, an object keyed by palette id,
  // and the shim means to ('0' => ...).  PHP turns a key of "0" into 0, and
  // json_encode() writes the array as a list: "p":[[...]].  In FUTURE.md.
  test.fail(true, 'json_encode writes the one palette as a list (FUTURE.md)');
  const palx = await json(request, '/json/palx');
  expect(Array.isArray(palx.p)).toBe(false);
  expect(palx.p['0']).toEqual([[0, 255, 255, 255], [255, 255, 255, 255]]);
});

// /win: WLED's older HTTP API (www/win/index.php), which answers every
// request with an XML status frame and takes the power from T=.
test('/win answers with the XML status frame, and T= turns every model off, on or over', async ({ request }) => {
  const win = async (query = '') => {
    const r = await request.get(`/win${query}`);
    expect(r.ok()).toBe(true);
    expect(r.headers()['content-type']).toBe('text/xml; charset=utf-8');
    expect(r.headers()['access-control-allow-origin']).toBe('*');
    expect(r.headers()['cache-control']).toContain('no-store');
    return r.text();
  };
  const field = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);

  // Off: no brightness, the one segment's colours, the node's name.
  let xml = await win();
  expect(xml.startsWith('<?xml version="1.0" ?>\n<vs>\n')).toBe(true);
  expect(xml.trimEnd().endsWith('</vs>')).toBe(true);
  const status = await (await request.get('/api/system/status')).json();
  expect(field(xml, 'ac')).toEqual(['0']);
  expect(field(xml, 'cl')).toEqual(['255', '255', '255']);
  expect(field(xml, 'cs')).toEqual(['0', '0', '0']);
  expect(field(xml, 'fx')).toEqual(['0']);
  expect(field(xml, 'ds')).toEqual([status.host_name]);

  // T=1 is on; the frame in the same answer already says so.
  xml = await win('?T=1');
  expect(field(xml, 'ac')).toEqual(['255']);
  expect(await modelState(request)).toBe(1);
  // T=2 is the other way from wherever it is.
  xml = await win('?T=2');
  expect(field(xml, 'ac')).toEqual(['0']);
  expect(await modelState(request)).toBe(0);
  xml = await win('?T=2');
  expect(field(xml, 'ac')).toEqual(['255']);
  expect(await modelState(request)).toBe(1);
  // A brightness alone is accepted and changes nothing.
  xml = await win('?A=10');
  expect(field(xml, 'ac')).toEqual(['255']);
  expect(await modelState(request)).toBe(1);
  // T=0 is off, by POST too.
  const posted = await request.post('/win', { form: { T: '0' } });
  expect(posted.ok()).toBe(true);
  expect(field(await posted.text(), 'ac')).toEqual(['0']);
  expect(await modelState(request)).toBe(0);

  // A model running an effect counts as on, and its effect is the frame's.
  const effects = await json(request, '/json/eff');
  const desc = await (await request.get('/api/overlays/effects/Bars')).json();
  await command(request, 'Overlay Model Effect', MODEL, 'Enabled', 'Bars', ...desc.args.map((a: any) => String(a.default ?? '')));
  await expect.poll(async () => field(await win(), 'fx')).toEqual([String(effects.indexOf('Bars'))]);
  expect(field(await win(), 'ac')).toEqual(['255']);
});
