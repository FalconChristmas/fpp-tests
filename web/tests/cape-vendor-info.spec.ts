import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// What the pages show about the cape comes from media/tmp/cape-info.json,
// which cape detection unpacks from the cape's EEPROM -- an image anyone can
// write, or upload as a virtual EEPROM.  These tests write that file
// directly, as detection would have published it.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PIXEL_STRINGS = `${MEDIA}/config/co-pixelStrings.json`;

function writeJson(path: string, value: unknown) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(value), path);
}

async function setSetting(request: APIRequestContext, name: string, value: string) {
  const r = await request.put(`/api/settings/${name}`, { data: value });
  expect(r.ok(), await r.text()).toBe(true);
}

async function getSetting(request: APIRequestContext, name: string): Promise<string> {
  return (await (await request.get(`/api/settings/${name}`)).json()).value ?? '';
}

const VENDOR_SETTINGS = ['FetchVendorLogos', 'SendVendorSerial', 'hideExternalURLs'];

function cape(vendor: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { id: 'FppTestsCape', name: 'fpp-tests cape', version: '1.0', serialNumber: 'SN0001',
           cs: 'c5', vendor: { name: 'fpp-tests vendor', ...vendor }, ...extra };
}

test.describe('cape vendor links', () => {
  let saved: Record<string, string> = {};

  test.beforeEach(async ({ request }) => {
    saved = {};
    for (const name of VENDOR_SETTINGS) {
      saved[name] = await getSetting(request, name);
    }
    await setSetting(request, 'hideExternalURLs', '0');
  });

  test.afterEach(async ({ request }) => {
    inPlayer('rm', '-f', CAPE_INFO);
    for (const [name, value] of Object.entries(saved)) {
      await request.put(`/api/settings/${name}`, { data: value });
    }
  });

  test('an EEPROM\'s vendor URLs reach the header logo as data', async ({ page, request }) => {
    // Regression: 9d00d30ad.  menu.inc echoed the logo URL raw into a JS
    // string literal on every page, so a quote in it ran the EEPROM's script
    // everywhere in the UI, and a javascript: landing page became the
    // logo's href.
    writeJson(CAPE_INFO, cape({
      url: 'https://vendor.invalid/',
      landingPage: 'javascript:window.__fppTestsVendor=2',
      image: "https://vendor.invalid/logo.png?x='+(window.__fppTestsVendor=1)+'",
    }));
    await setSetting(request, 'FetchVendorLogos', '1');
    await setSetting(request, 'SendVendorSerial', '1');
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.goto('/index.php');
    await page.waitForLoadState('load');
    // The control: the logo block is there, so its script ran.
    await expect(page.locator('#capeVendorLink')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__fppTestsVendor)).toBeUndefined();
    const href = (await page.locator('#capeVendorLink').getAttribute('href')) ?? '';
    expect(href).not.toMatch(/^\s*javascript:/i);
    expect(dialogs).toEqual([]);
  });

  test('Cape Info shows the vendor\'s fields as text', async ({ request }) => {
    // Regression: 9d00d30ad.  The vendor name, URL, phone, e-mail and forum
    // were echoed into the page unescaped.
    writeJson(CAPE_INFO, cape({ name: '<i id="fpp-tests-vendor">V</i>', url: 'https://vendor.invalid/',
                                phone: '<b id="fpp-tests-phone">1</b>', forum: 'javascript:alert(1)' }));
    const html = await (await request.get('/cape-info.php')).text();
    expect(html, 'the control: the vendor section is on the page').toContain('Vendor&nbsp;Name');
    expect(html).not.toContain('<i id="fpp-tests-vendor">');
    expect(html).not.toContain('<b id="fpp-tests-phone">');
    expect(html).not.toContain('href="javascript:alert(1)"');
  });

  test('the vendor link carries the serial only when logos and the serial are both allowed', async ({ request }) => {
    // Regression: 9d00d30ad.  Cape Info added the serial to the vendor link
    // on SendVendorSerial alone, though the privacy text says denying the
    // logo denies it too.
    writeJson(CAPE_INFO, cape({ url: 'https://vendor.invalid/', image: 'https://vendor.invalid/logo.png' }));
    const vendorHref = async () => {
      const html = await (await request.get('/cape-info.php')).text();
      const m = html.match(/Vendor&nbsp;URL:<\/b><\/td><td><a href="([^"]*)"/);
      expect(m, 'no Vendor URL row on Cape Info').not.toBeNull();
      return m![1];
    };
    await setSetting(request, 'FetchVendorLogos', '0');
    await setSetting(request, 'SendVendorSerial', '1');
    expect(await vendorHref()).not.toContain('sn=');

    await setSetting(request, 'FetchVendorLogos', '1');
    await setSetting(request, 'SendVendorSerial', '0');
    expect(await vendorHref()).not.toContain('sn=');

    await setSetting(request, 'SendVendorSerial', '1');
    expect(await vendorHref(), 'the control: both allowed').toContain('sn=SN0001');
  });
});

test.describe('About Cape', () => {
  let hadStrings = false;

  test.beforeEach(() => {
    hadStrings = inPlayer('sh', '-c', `test -e ${PIXEL_STRINGS} && echo yes || echo no`).trim() === 'yes';
    if (hadStrings) {
      inPlayer('cp', '-a', PIXEL_STRINGS, `${PIXEL_STRINGS}.fpp-tests`);
    }
    writeJson(PIXEL_STRINGS, { channelOutputs: [{ type: 'DPIPixels', enabled: 0, subType: '', outputs: [] }] });
  });

  test.afterEach(() => {
    inPlayer('rm', '-f', CAPE_INFO);
    if (hadStrings) {
      inPlayer('mv', '-f', `${PIXEL_STRINGS}.fpp-tests`, PIXEL_STRINGS);
    } else {
      inPlayer('rm', '-f', PIXEL_STRINGS);
    }
  });

  test('a cape that provides no outputs is not credited with an output driver', async ({ request }) => {
    // Regression: 5d29f5f5b.  "Output Driver" showed the box's pixel string
    // driver for any cape, one that declares "provides": [] (an audio/OLED/RTC
    // hat) included.
    const driverRow = async (provides?: string[]) => {
      writeJson(CAPE_INFO, cape({}, provides === undefined ? {} : { provides }));
      return (await (await request.get('/cape-info.php')).text()).includes('Output&nbsp;Driver');
    };
    expect(await driverRow([]), 'an output driver for a cape that provides none').toBe(false);
    expect(await driverRow(['strings']), 'the control: a cape that drives strings').toBe(true);
    expect(await driverRow(), 'no "provides" is unknown, not none').toBe(true);
  });
});

test('the cape/firmware mismatch is read from its own lines, whatever comes before', async ({ page }) => {
  // Regression: 0354d3c83.  The re-flash confirmation took lines 2 and 3 of
  // the output, which a vendor URL upgrade fills with wget's log, so it
  // asked whether to replace "Resolving ..." with "Connecting to ...".
  // (Red on the parent because ParseCapeFirmwareMismatch() is new there.)
  await page.goto('/index.php');
  const parse = (txt: string) => page.evaluate((t) => (window as any).ParseCapeFirmwareMismatch(t), txt);
  const out = 'Downloading https://vendor.invalid/x.bin\n\nResolving vendor.invalid...\nConnecting to vendor.invalid...\n' +
    'Cape does not match new firmware.\nCape: TestCape-A   Version: 1.0\nFirmware: TestCape-B   Version: 2.0\n';
  expect(await parse(out)).toEqual({ cape: 'Cape: TestCape-A   Version: 1.0', firmware: 'Firmware: TestCape-B   Version: 2.0' });
  expect(await parse('Resolving vendor.invalid...\nCape does not match new firmware.\n')).toBeNull();
  expect(await parse('Upgrade complete.\n')).toBeNull();
});
