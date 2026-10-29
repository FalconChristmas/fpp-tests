import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// Saving Channel Inputs (channelinputs.php) needs no fppd restart: fppd
// watches ci-universes.json and ci-dmx.json and reloads its bridge inputs
// when they change.  So the page must not raise the restart flag (and the
// "restart FPPD" banner) for them, and fppd must take the new inputs as it
// runs.

test.skip(!container, 'changes the player\'s input config');

const FAKE_PORT = '/dev/ttyUSB9';
let madePort = false;
let before: { universes: string | null; dmx: string | null } = { universes: null, dmx: null };

async function config(request: APIRequestContext, name: string) {
  const r = await request.get(`/api/channel/output/${name}`);
  return r.ok() ? r.text() : null;
}
async function restore(request: APIRequestContext, name: string, body: string | null) {
  await request.post(`/api/channel/output/${name}`, { data: Buffer.from(body ?? '{"channelInputs": []}') });
}
const restartFlag = async (request: APIRequestContext) =>
  String((await (await request.get('/api/settings/restartFlag')).json()).value ?? '0');

test.beforeEach(async ({ request }) => {
  before = { universes: await config(request, 'universeInputs'), dmx: await config(request, 'dmxInputs') };
  await request.put('/api/settings/restartFlag', { data: '0' });
  madePort = inPlayer('sh', '-c', '[ -e "$1" ] && echo there || { touch "$1"; echo made; }', 'sh', FAKE_PORT).trim() === 'made';
});
test.afterEach(async ({ request }) => {
  await restore(request, 'universeInputs', before.universes);
  await restore(request, 'dmxInputs', before.dmx);
  await request.put('/api/settings/restartFlag', { data: '0' });
  if (madePort) inPlayer('rm', '-f', FAKE_PORT);
});

test('saving E1.31 and DMX inputs asks for no restart, and fppd takes the new universe at once', async ({ page, request }) => {
  // Regression: 5a4440168.  Both saves set the restart flag, so the page
  // told the user to restart fppd after every change to the inputs.
  await restore(request, 'universeInputs', JSON.stringify({ channelInputs: [{
    type: 'universes', enabled: 1, startChannel: 1, channelCount: -1, timeout: 1000,
    universes: [{ active: 1, description: 'fpp-tests input', id: 7101, startChannel: 1, universeCount: 1,
                  channelCount: 512, type: 0, address: '', priority: 0 }],
  }] }));
  await expect.poll(async () => ((await (await request.get('/api/fppd/e131stats')).json()).universes ?? [])
    .map((u: any) => String(u.id)), { timeout: 10_000 }).toContain('7101');

  page.on('dialog', (d) => d.accept());
  await page.goto('/channelinputs.php');
  const rows = page.locator('#tblUniversesBody > tr');
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  const univ = rows.first().locator('input.txtUniverse');
  await expect(univ).toHaveValue('7101');
  await univ.fill('7102');
  await univ.dispatchEvent('change');
  await expect(page.locator('#btnSaveUniverses')).toBeEnabled();
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === '/api/channel/output/universeInputs');
  await page.locator('#btnSaveUniverses').click();
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('#jGrowl')).toContainText('E1.31 Universes Saved');

  // fppd, still the same process, listens for the new universe.
  await expect.poll(async () => ((await (await request.get('/api/fppd/e131stats')).json()).universes ?? [])
    .map((u: any) => String(u.id)), { timeout: 10_000, message: 'fppd\'s input universes after the save' }).toEqual(['7102']);

  // DMX: the stand-in serial port has a row.
  await page.locator('#tab-dmx-tab').click();
  await expect(page.locator('#btnSaveDMX')).toBeEnabled({ timeout: 15_000 });
  const dmxSaved = page.waitForResponse((r) => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === '/api/channel/output/dmxInputs');
  await page.locator('#btnSaveDMX').click();
  expect((await dmxSaved).ok()).toBe(true);
  await expect(page.locator('#jGrowl')).toContainText('DMX Inputs Saved');

  // Neither save raised the restart flag, here or on the player.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => String((window as any).settings.restartFlag))).toBe('0');
  expect(await restartFlag(request)).toBe('0');
});
