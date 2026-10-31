import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// A unicast universe's address on the E1.31 / ArtNet / DDP tab of Channel
// Outputs (co-universes.php).  fppd reads an address with no letters in it
// with inet_addr() (UDPOutputData::toInetAddr), which takes an octet with a
// leading zero as octal: "10.0.0.010" sends to 10.0.0.8.

test.skip(!container, "changes the player's output config");

const config = (address: string) => ({ channelOutputs: [{ type: 'universes', enabled: 1, interface: 'eth0',
  threaded: 1, startChannel: 1, channelCount: -1, universes: [{ active: 1, description: 'fpp-tests zeros', id: 1,
    startChannel: 1, universeCount: 1, channelCount: 510, type: 1, address, priority: 0, monitor: 0, deDuplicate: 0 }] }] });

const stored = async (request: APIRequestContext) =>
  (await (await request.get('/api/channel/output/universeOutputs')).json()).channelOutputs[0].universes[0].address;

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}'),
  });
});

test('a unicast address with a leading zero in an octet is refused', async ({ page, request }) => {
  // Regression: 427204159 (found checking b170bbca9, #2011).  The
  // universes page calls validateIPaddress() with hostnames allowed, and
  // "10.0.0.010" -- digits and dots -- passed the hostname pattern, so the
  // leading-zero check that commit added never applied here.  It was
  // saved, and fppd sent that universe to 10.0.0.8.
  const r = await request.post('/api/channel/output/universeOutputs', { data: config('10.0.0.5') });
  expect(r.ok()).toBe(true);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  const ip = page.locator('#tblUniversesBody > tr').first().locator('input.txtIP');
  await expect(ip).toHaveValue('10.0.0.5', { timeout: 15_000 });
  await ip.fill('10.0.0.010');
  await ip.dispatchEvent('change');
  await page.locator('#frmUniverses input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await page.waitForTimeout(3000);
  expect(await stored(request)).toBe('10.0.0.5');
});

test('a unicast hostname is still saved', async ({ page, request }) => {
  // The other side of 427204159: names, including ones with digits in
  // them, are still allowed; only an all-digits-and-dots address must be
  // a dotted quad.
  const r = await request.post('/api/channel/output/universeOutputs', { data: config('10.0.0.5') });
  expect(r.ok()).toBe(true);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  const ip = page.locator('#tblUniversesBody > tr').first().locator('input.txtIP');
  await expect(ip).toHaveValue('10.0.0.5', { timeout: 15_000 });
  await ip.fill('controller-2.example.test');
  await ip.dispatchEvent('change');
  await page.locator('#frmUniverses input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(() => stored(request), { timeout: 5_000 }).toBe('controller-2.example.test');
});
