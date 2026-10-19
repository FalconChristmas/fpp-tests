import { test, expect } from './fixtures';

// Events became Command Presets in FPP 5: fppd turns each event file into a
// preset named after the event. /api/events/{id}/trigger still asked fppd for
// the "Trigger Event" command that went with them -- and through its read-only
// /commands/ route -- so it answered 200 and fired nothing. Fixed in fpp 9bee8610d
// ("fix(api): an event trigger fires its Command Preset; remoteAction's dead
// upgradeOS goes").
//
// scripts/web_serve.py seeds events/01_01.fevt, named "fpp-tests event", whose
// converted preset sets the user variable fppTestsEvent to 1.

async function variable(request: import('@playwright/test').APIRequestContext, name: string) {
  const r = await request.get('/api/variables');
  expect(r.ok()).toBe(true);
  const vars = await r.json();
  return vars?.[name]?.value;
}

test('an event trigger fires the Command Preset the event became', async ({ request }) => {
  const presets = await request.get('/api/commandPresets?names=true');
  expect(await presets.json()).toContain('fpp-tests event');
  expect(await variable(request, 'fppTestsEvent')).toBeUndefined();

  const r = await request.post('/api/events/01_01/trigger');
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: 'OK' });
  await expect.poll(() => variable(request, 'fppTestsEvent'), { timeout: 10_000 }).toBe('1');
});

test('an event trigger for no such event is a 404', async ({ request }) => {
  const r = await request.post('/api/events/99_99/trigger');
  expect(r.status()).toBe(404);
  expect((await r.json()).status).toBe('ERROR');
});

test('remoteAction has no upgradeOS action', async ({ request }) => {
  // It pointed at /upgradeOS, no .php, and so could only ever 404 on the
  // remote; an OS upgrade of another player is a MultiSync job. 192.0.2.1 is
  // TEST-NET-1: nothing answers there, so contacting it can't succeed.
  const r = await request.post('/api/remoteAction?ip=192.0.2.1&action=upgradeOS');
  expect(r.status()).toBe(400);
  expect((await r.json()).details).toBe('Invalid action given: upgradeOS');
});
