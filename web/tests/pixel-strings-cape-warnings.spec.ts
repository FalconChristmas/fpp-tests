import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The cape warnings and limits on the Pixel Strings tab (see
// pixel-strings-more.spec.ts, whose harness this repeats): the player claims
// to be a BeagleBone or a Pi for the length of each test (config.php reads
// /etc/fpp/platform), the cape is put where cape detection unpacks it from
// the EEPROM (media/tmp/cape-info.json and media/tmp/strings), and the string
// config is written where the page loads it from.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsStrings.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const BBB_CONFIG = `${MEDIA}/config/co-bbbStrings.json`;
const PI_CONFIG = `${MEDIA}/config/co-pixelStrings.json`;
const SETTINGS_FILE = `${MEDIA}/settings`;

const CAPE = {
  name: 'FppTestsStrings', longName: 'fpp-tests string cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }],
  groups: [{ start: 1, count: 3 }],
};
// Signed by the FPP project's own key but with no licensed ports: the page
// limits every port past the licensed count to 50 pixels and says so.
const CAPE_INFO_JSON = {
  id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'fp',
};

const vstring = (startChannel: number, pixelCount: number) => ({
  description: 'fpp-tests', startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
});

function stringsConfig(type: string, enabled: number, pixels: number[]) {
  return {
    channelOutputs: [{
      type, subType: 'FppTestsStrings', pinoutVersion: '1.x', enabled,
      startChannel: 1, channelCount: -1, outputCount: pixels.length,
      outputs: pixels.map((n, i) => ({
        portNumber: i, protocol: 'ws2811', differentialType: 0, virtualStrings: [vstring(i * 600, n)],
      })),
    }],
  };
}

function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, BBB_CONFIG, PI_CONFIG, SETTINGS_FILE]) saved[p] = read(p);
  write(CAPE_FILE, JSON.stringify(CAPE));
  write(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

test('a hidden licence warning can be brought back with View Cape Warnings', async ({ page, request }) => {
  // Regression: 111066208.  Hide on the "cape is licensed for N outputs" box
  // wrote HideLicenseWarning=1 and left no way to read the warning again.  The
  // link that shows it again writes 0, and Hide writes 1.
  write(PLATFORM, 'BeagleBone Black');
  write(BBB_CONFIG, JSON.stringify(stringsConfig('BBB48String', 1, [50, 50, 50])));
  const puts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/settings/HideLicenseWarning')) puts.push(r.postData() ?? '');
  });
  await openStrings(page);
  const box = page.locator('#capeWarningsDiv');
  const link = page.locator('#capeWarningsSpan');
  await expect(box, 'the control: the warning shows until it is hidden').toBeVisible();
  await expect(box).toContainText('not signed');
  await expect(link).toBeHidden();

  await box.locator('input[value="Hide"]').click();
  await expect(box).toBeHidden();
  await expect(link).toBeVisible();
  await expect.poll(() => puts).toEqual(['1']);
  expect((await (await request.get('/api/settings/HideLicenseWarning')).json()).value).toBe('1');

  await link.locator('a').click();
  await expect(box).toBeVisible();
  await expect(link).toBeHidden();
  await expect.poll(() => puts).toEqual(['1', '0']);
  expect((await (await request.get('/api/settings/HideLicenseWarning')).json()).value).toBe('0');
});

test('a saved config with Pixel Strings enabled shows the tab a cape without strings left hidden', async ({ page }) => {
  // Regression: 2ca43c1e3.  The tab is hidden when the cape provides no
  // strings, and loading a configuration that had Pixel Strings enabled left
  // it hidden, so the enabled output could not be reached.
  write(PLATFORM, 'BeagleBone Black');
  write(CAPE_INFO, JSON.stringify({ ...CAPE_INFO_JSON, provides: ['panels'] }));
  write(BBB_CONFIG, JSON.stringify(stringsConfig('BBB48String', 0, [50, 50, 50])));
  await page.goto('/channeloutputs.php');
  const li = page.locator('#tab-strings-LI');
  await expect(li, 'the control: disabled, the tab stays hidden').toBeHidden();

  // (A different length, so the page's cached copy of the config is not reused.)
  write(BBB_CONFIG, JSON.stringify(stringsConfig('BBB48String', 1, [50, 50, 50, 50])));
  await page.goto('/channeloutputs.php?enabled');
  await expect(li).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#PixelString_enable')).toBeChecked();
});

test('outputs past the licensed count are not limited to 50 pixels on a driver that needs no licence', async ({ page, request }) => {
  // Regression: 447336725.  The check for too many pixels on unlicensed
  // outputs ran for every driver, so a Pi's third output (the Pi licenses two)
  // was flagged on a driver that has no licence at all, and Save was refused.
  write(PLATFORM, 'Raspberry Pi');
  // Unsigned for the page's purposes: no key at all, so the Pi's two free outputs apply.
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001', provides: ['strings'] }));
  const third = page.locator('#PixelString tr[id$="_Output_0_2_0"] input.vsPixelCount');

  // The control: on a licensed driver the same layout is refused.
  write(CAPE_FILE, JSON.stringify({ ...CAPE, driver: 'DPIPixels' }));
  write(PI_CONFIG, JSON.stringify(stringsConfig('DPIPixels', 1, [50, 50, 100])));
  await openStrings(page);
  await expect(third).toHaveClass(/inputError/);

  write(CAPE_FILE, JSON.stringify({ ...CAPE, driver: 'spixels' }));
  write(PI_CONFIG, JSON.stringify(stringsConfig('spixels', 1, [50, 50, 100])));
  await page.goto('/channeloutputs.php?spixels');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await expect(third).toHaveValue('100');
  await expect(third).not.toHaveClass(/inputError/);
  await page.locator('#PixelString tr[id$="_Output_0_2_0"] input.vsDescription').fill('third-saved');
  await page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => {
    const c = await (await request.get('/api/channel/output/co-pixelStrings')).json();
    return c.channelOutputs?.[0]?.outputs?.[2]?.virtualStrings?.[0]?.description;
  }, { timeout: 15_000 }).toBe('third-saved');
});
