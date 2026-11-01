import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// Saving Channel Outputs needs no fppd restart: fppd watches the output
// config files and reloads its outputs when they change.  So a save from
// the E1.31, Other and PWM tabs must not raise the restart flag (and the
// "restart FPPD" banner), and fppd must take the new config as it runs.
//
// Regression: a8360fefe.  Each of these saves (and the Pixel Strings and
// LED Panels ones) set the restart flag, so the page told the user to
// restart fppd after every change to the outputs.

test.skip(!container, 'changes the player\'s output config');

const MEDIA = '/home/fpp/media';
const LOG = `${MEDIA}/logs/fppd.log`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PWM_FILE = `${MEDIA}/tmp/pwm/FppTestsPWM.json`;
const PWM_CONFIG = `${MEDIA}/config/co-pwm.json`;

const restartFlag = async (request: APIRequestContext) =>
  String((await (await request.get('/api/settings/restartFlag')).json()).value ?? '0');
const logMark = () => parseInt(inPlayer('sh', '-c', `wc -c < ${LOG}`).trim(), 10);
const logSince = (mark: number) => inPlayer('sh', '-c', `tail -c +${mark + 1} ${LOG}`);
function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let kept: Record<string, string | null> = {};
let universes: string | null = null;
let other: string | null = null;

test.beforeEach(async ({ request }) => {
  const u = await request.get('/api/channel/output/universeOutputs');
  universes = u.ok() ? await u.text() : null;
  const o = await request.get('/api/channel/output/co-other');
  other = o.ok() ? await o.text() : null;
  kept = { [CAPE_INFO]: readFile(CAPE_INFO), [PWM_FILE]: readFile(PWM_FILE), [PWM_CONFIG]: readFile(PWM_CONFIG) };
  await request.put('/api/settings/restartFlag', { data: '0' });
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/universeOutputs', { data: Buffer.from(universes ?? '{"channelOutputs": []}') });
  await request.post('/api/channel/output/co-other', { data: Buffer.from(other ?? '{"channelOutputs": []}') });
  for (const [p, content] of Object.entries(kept)) {
    if (content === null) inPlayer('rm', '-f', p); else writeFile(p, content);
  }
  await request.put('/api/settings/restartFlag', { data: '0' });
});

test('saving E1.31 outputs asks for no restart, and fppd reloads them at once', async ({ page, request }) => {
  const seeded = await request.post('/api/channel/output/universeOutputs', { data: { channelOutputs: [{
    type: 'universes', enabled: 1, interface: 'eth0', threaded: 3, pacingRate: 90, startChannel: 1, channelCount: -1,
    universes: [{ active: 1, description: 'fpp-tests universe', id: 1, startChannel: 1, universeCount: 1,
                  channelCount: 510, type: 0, address: '', priority: 0, monitor: 1, deDuplicate: 0 }],
  }] } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#tblUniversesBody tr')).toHaveCount(1, { timeout: 15_000 });
  const save = page.locator('#frmUniverses input[value="Save"]:not(.Zebra_Pin_Clone *)');
  await expect(save).toBeEnabled();
  const mark = logMark();
  await save.click();
  await expect(page.locator('#jGrowl')).toContainText('E1.31 Universes Saved');
  // fppd, still the same process, reloaded its outputs for the new file.
  await expect.poll(() => logSince(mark), { timeout: 15_000 }).toMatch(/Channel Outputs|channel output/i);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => String((window as any).settings.restartFlag))).toBe('0');
  expect(await restartFlag(request)).toBe('0');
});

test('saving an Other output asks for no restart, and fppd reloads it at once', async ({ page, request }) => {
  const seeded = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'GenericUDP', enabled: 1, startChannel: 1, channelCount: 3, address: '127.0.0.1', port: 9999,
    tokenData: '{data}', description: '' }] } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-other-DMXSerial-tab').click();
  const row = page.locator('#tblOther-DMXSerial > tbody > tr').first();
  await expect(row).toContainText('Generic UDP', { timeout: 15_000 });
  await row.locator('input.count').fill('6');
  const mark = logMark();
  await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect(page.locator('#jGrowl')).toContainText('Channel Output Configuration Saved');
  await expect.poll(() => logSince(mark), { timeout: 15_000 }).toMatch(/GenericUDPOutput: Determined range needed 0 - 5/);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => String((window as any).settings.restartFlag))).toBe('0');
  expect(await restartFlag(request)).toBe('0');
});

test('saving PWM outputs asks for no restart', async ({ page, request }) => {
  // The tab exists only with a signed cape that provides PWM: give the
  // container one for the length of the test, as pwm-save-config.spec.ts does.
  writeFile(CAPE_INFO, JSON.stringify({ id: 'FppTestsPWM', name: 'fpp-tests PWM', version: '1.0', serialNumber: 'SN0001',
    provides: ['all', 'pwm'], verifiedKeyId: 'ft' }));
  writeFile(PWM_FILE, JSON.stringify({ name: 'FppTestsPWM', longName: 'fpp-tests 2-port PWM cape', driver: 'PCA9685',
    outputs: [{ label: 'Port 1' }, { label: 'Port 2' }] }));
  writeFile(PWM_CONFIG, '{}');
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  test.skip((await page.locator('#tab-pwm-tab').count()) === 0, 'no PWM cape, so no PWM tab');
  await page.locator('#tab-pwm-tab').click();
  const save = page.locator('#savePWMButton');
  await expect(save).toBeEnabled({ timeout: 15_000 });
  const description = page.locator('[id^="pwmDescription"]').first();
  await description.fill('fpp-tests servo');
  await description.dispatchEvent('change');
  await save.click();
  await expect(page.locator('#jGrowl')).toContainText('PWM/Servo Output Configuration Saved');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => String((window as any).settings.restartFlag))).toBe('0');
  expect(await restartFlag(request)).toBe('0');
});
