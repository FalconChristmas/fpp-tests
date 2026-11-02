import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// A string cape hides the E1.31 and LED Panels tabs of Channel Outputs, but
// not once an output of that type is enabled in the saved config.

test.skip(!container, 'gives the run-web.sh container a cape and output config');

const INFO = '/home/fpp/media/tmp/cape-info.json';
let kept: string | null = null;
let uiLevel = '0';
let savedUniverses: string | null = null;
let savedPanels: string | null = null;

async function get(request: APIRequestContext, name: string) {
  const r = await request.get(`/api/channel/output/${name}`);
  const t = await r.text();
  return r.ok() && !t.includes('File not found') ? t : null;
}
async function put(request: APIRequestContext, name: string, body: string | null) {
  await request.post(`/api/channel/output/${name}`, { data: Buffer.from(body ?? '{"channelOutputs": []}') });
}

test.beforeEach(async ({ request }) => {
  const out = inPlayer('sh', '-c', `if [ -e ${INFO} ]; then echo yes; cat ${INFO}; else echo no; fi`);
  kept = out.startsWith('yes\n') ? out.slice(4) : null;
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  savedUniverses = await get(request, 'universeOutputs');
  savedPanels = await get(request, 'panelOutputs');
  inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && printf '%s' '${JSON.stringify(
    { id: 'fpp-tests', name: 'fpp-tests strings cape', provides: ['strings'] })}' > ${INFO}`);
  await request.put('/api/settings/uiLevel', { data: '0' });
});
test.afterEach(async ({ request }) => {
  inPlayer('sh', '-c', kept === null ? `rm -f ${INFO}` : `printf '%s' '${kept.replace(/'/g, "'\\''")}' > ${INFO}`);
  await put(request, 'universeOutputs', savedUniverses);
  await put(request, 'panelOutputs', savedPanels);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

test('an enabled E1.31 output brings back the E1.31 tab on a string cape', async ({ page, request }) => {
  // Regression: 669e5ce51.  A string cape hides the E1.31 / ArtNet / DDP tab
  // unless an output of that type is enabled; populateUniverseData shows it.
  await put(request, 'universeOutputs', JSON.stringify({ channelOutputs: [{
    type: 'universes', enabled: 0, interface: 'eth0', threaded: 1, startChannel: 1, channelCount: -1, universes: [] }] }));
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#tab-LEDPanels-LI')).toBeHidden();
  await expect(page.locator('#tab-e131-LI')).toBeHidden();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#tab-e131-LI')).toBeHidden();

  await put(request, 'universeOutputs', JSON.stringify({ channelOutputs: [{
    type: 'universes', enabled: 1, interface: 'eth0', threaded: 1, startChannel: 1, channelCount: -1, universes: [] }] }));
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#tab-e131-LI')).toBeVisible();
});
