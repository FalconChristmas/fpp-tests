import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
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

// A cape's vendor block -- name, URL, landing page, phone, e-mail, forum, logo
// and the header logo -- comes from its EEPROM, which anyone can write (an
// unsigned EEPROM, or an uploaded cape-eeprom.bin).  fppcapedetect copies it
// into media/tmp/cape-info.json and config.php puts that in $settings for
// every page.  Fixed in fpp 9d00d30ad ("Cape vendor URLs: build them in one
// place and escape what the EEPROM says"):
//
//   - menu.inc echoed the header logo URL into a JavaScript string literal on
//     every page, and the landing page into an href, unescaped; Cape Info
//     printed every vendor field as markup.  A crafted EEPROM ran script on
//     every page of the UI.
//   - a javascript: or data: URL went straight into an href or src.
//   - the two pages built the vendor URLs separately and had drifted: Cape
//     Info's link carried the serial on SendVendorSerial alone, so a user who
//     denied logos (FetchVendorLogos 0) and clicked the vendor link sent it.
//     Now CapeVendorUrls() builds both: nothing unless FetchVendorLogos is 1,
//     sn/id/cs (urlencoded) on both only when SendVendorSerial is 1 too, and
//     hideExternalURLs blanks the link.
//
// As above, cape-info.json is written in the player.  The settings file and
// cape-info.json are put back after each test (the suite runs one test at a
// time), so no other test sees a cape.
//
// The page's CSP is bypassed so the browser can fetch the logo (answered here
// by a route) and the test can see the URL it asks the vendor for.  On a
// player the vendor's host is in img-src anyway: ManageApacheContentPolicy.sh
// adds it from cape-info.json, but this CSP was generated before the test
// wrote the file.  script-src allows inline script either way, so bypassing it
// changes nothing about whether a payload runs.
//
// Not checked: 9d00d30ad also closes the e-mail row's missing </a>.  The
// parser closes an open <a> at the end of its table cell, so the page that
// results is the same either way and there is nothing a browser can tell.
//
// The description sits in the table beside the vendor block and was missed:
// Cape Info printed it as markup whenever the cape named a vendor (or was
// called "Unknown"), and escaped it otherwise.  Fixed separately
// (9ab8c9e9f); the Cape Info test below carries a description payload,
// so it fails on 9d00d30ad itself and passes with that fix.

const SETTINGS = '/home/fpp/media/settings';
const SAVED = '/tmp/fpp-tests-cape-vendor-settings.saved';
const VENDOR = 'https://vendor.fpp-tests.invalid';
// Script that marks, by name, the field it came from if it ever runs.
const run = (field: string) => `window.__fppTestsCape_${field}=1`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function writeCapeInfo(info: object) {
  inPlayer('sh', '-c', `mkdir -p "$(dirname "$1")" && printf '%s' "$2" > "$1" && chmod 644 "$1"`,
    'sh', CAPE_INFO, JSON.stringify(info));
}

async function privacy(request: APIRequestContext, logos: 0 | 1, serial: 0 | 1) {
  for (const [name, value] of [['FetchVendorLogos', logos], ['SendVendorSerial', serial]] as const) {
    const r = await request.put(`/api/settings/${name}?skipApply=1`, { data: String(value) });
    expect(r.ok(), `${name}: ${await r.text()}`).toBe(true);
  }
}

// Answers every request to the vendor with a 1x1 PNG, and records them.
async function vendorHost(page: Page) {
  const asked: string[] = [];
  await page.route((url) => url.origin === VENDOR, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  return asked;
}

// Opens a page and lets it finish loading; what the vendor is asked from here
// on goes into a fresh `asked`.
async function load(page: Page, path: string, asked: string[] = []) {
  asked.length = 0;
  await page.goto(path);
  await page.waitForLoadState('load');
}

// The header loads its logo after the page's load event and adds it to the
// link once it has loaded.
async function expectHeaderLogo(page: Page, asked: string[], url: string) {
  await expect.poll(() => asked, { message: 'the header logo was not fetched from the vendor', timeout: 15_000 })
    .toContain(new URL(url).href);
  await expect(page.locator('#capeVendorLink img.logo')).toHaveCount(1);
}

// The fields whose script ran on this page.
async function ran(page: Page) {
  return page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__fppTestsCape_')).sort());
}

// PHP's urlencode(): everything but [A-Za-z0-9_.-] is %XX, a space is '+'.
function phpUrlencode(s: string) {
  return encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

// The value cell of the Cape Info vendor table row with this label.
function vendorRow(page: Page, label: string) {
  return page.locator('#eeprom-about .aboutRight tr').filter({ has: page.locator('b', { hasText: new RegExp(`^${label.replace(' ', '.')}:$`) }) });
}

const BASE = {
  name: 'fpp-tests cape',
  id: '1234',
  version: '1.0',
  serialNumber: '0042',
};

test.describe('cape vendor URLs from a crafted EEPROM', () => {
  test.use({ bypassCSP: true });

  test.beforeEach(() => {
    // A player with no cape has no cape-info.json; one left behind would be
    // overwritten and then deleted, so refuse to start rather than lose it.
    expect(inPlayer('sh', '-c', `test -e ${CAPE_INFO} && echo present || echo absent`).trim()).toBe('absent');
    inPlayer('cp', '-p', SETTINGS, SAVED);
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    // Nothing saved means beforeEach refused, and the cape-info.json is not ours.
    inPlayer('sh', '-c', `test -e ${SAVED} || exit 0; rm -f ${CAPE_INFO} && cp -p ${SAVED} ${SETTINGS} && rm -f ${SAVED}`);
  });

  for (const [what, image] of [
    ['a quote', `${VENDOR}/header.png?x=';${run('header_cape_image')};//`],
    ['a </script>', `${VENDOR}/header.png?x=</script><script>${run('header_cape_image')}</script>`],
  ]) {
    test(`a header logo URL with ${what} in it stays a string on every page`, async ({ page, request }) => {
      const landing = `${VENDOR}/landing?x="><img src=x onerror=${run('landingPage')}>`;
      writeCapeInfo({
        ...BASE,
        header_cape_image: image,
        vendor: { name: 'fpp-tests', url: `${VENDOR}/`, landingPage: landing, image: `${VENDOR}/logo.png` },
      });
      await privacy(request, 1, 0);
      const asked = await vendorHost(page);
      for (const path of ['/index.php', '/about.php']) {
        await load(page, path, asked);
        expect(await ran(page), `the header's vendor URLs ran as script on ${path}`).toEqual([]);
        // The control: the URL reached the browser whole, as a string, and the
        // landing page whole, as the link.
        await expectHeaderLogo(page, asked, image);
        await expect(page.locator('#capeVendorLink')).toHaveAttribute('href', landing);
      }
    });
  }

  test('Cape Info shows what the EEPROM says about the vendor as text', async ({ page, request }) => {
    // Regression: 9ab8c9e9f for the description, beside the vendor block.
    const description = `<img src=x onerror=${run('description')}><b id="fpp-tests-description">d</b>`;
    const vendor = {
      name: `<img src=x onerror=${run('name')}>`,
      url: `${VENDOR}/?"><img src=x onerror=${run('url')}>`,
      landingPage: `${VENDOR}/landing?x='"><img src=x onerror=${run('landingPage')}>`,
      phone: `</td><img src=x onerror=${run('phone')}>`,
      email: `x"><img src=x onerror=${run('email')}>@example.com`,
      forum: `${VENDOR}/forum?x="><img src=x onerror=${run('forum')}>`,
      image: `${VENDOR}/logo.png?x="><img src=x onerror=${run('image')}>`,
    };
    writeCapeInfo({ ...BASE, description, vendor });
    await privacy(request, 1, 0);
    const asked = await vendorHost(page);
    // An <img>'s error event comes before the page's load event.
    await load(page, '/cape-info.php', asked);
    await expect(page.locator('#eeprom-about .aboutRight')).toHaveCount(1);
    expect(await ran(page), 'vendor fields ran as markup').toEqual([]);
    await expect(page.locator('#fpp-tests-description')).toHaveCount(0);
    // The control: the description is on the page, whole, as text.
    await expect(page.locator('#eeprom-about .aboutLeft td[colspan="2"]')).toHaveText(description);

    // The control: each field is on the page, whole, where it belongs.
    await expect(vendorRow(page, 'Vendor Name').locator('td').nth(1)).toHaveText(vendor.name);
    await expect(vendorRow(page, 'Phone Number').locator('td').nth(1)).toHaveText(vendor.phone);
    const url = vendorRow(page, 'Vendor URL').locator('a');
    await expect(url).toHaveText(vendor.url);
    await expect(url).toHaveAttribute('href', vendor.landingPage);
    const email = vendorRow(page, 'E-mail').locator('a');
    await expect(email).toHaveText(vendor.email);
    await expect(email).toHaveAttribute('href', `mailto:${vendor.email}`);
    const forum = vendorRow(page, 'Support Forum').locator('a');
    await expect(forum).toHaveText(vendor.forum);
    await expect(forum).toHaveAttribute('href', vendor.forum);
    // The only image in the block is the logo, from the vendor's URL as given.
    const imgs = page.locator('#eeprom-about .aboutRight img');
    await expect(imgs).toHaveCount(1);
    await expect(imgs).toHaveAttribute('src', vendor.image);
    await expect(imgs.locator('xpath=..')).toHaveAttribute('href', vendor.landingPage);
    await expect.poll(() => asked).toContain(new URL(vendor.image).href);
  });

  test('javascript: and data: vendor URLs never reach an href or src', async ({ page, request }) => {
    const vendor = {
      name: 'fpp-tests',
      url: `javascript:${run('url')}`,
      forum: `javascript:${run('forum')}`,
      image: 'data:image/png;base64,' + PNG.toString('base64'),
    };
    writeCapeInfo({ ...BASE, header_cape_image: `JavaScript:${run('header_cape_image')}`, vendor });
    await privacy(request, 1, 0);

    // The header has a logo only when there is a web URL to fetch it from.
    await page.goto('/index.php');
    await expect(page.locator('#header_Time')).toHaveCount(1);
    await expect(page.locator('.capeVendor')).toHaveCount(0);

    await page.goto('/cape-info.php');
    const block = page.locator('#eeprom-about .aboutRight');
    // The control: the rows are there, with the URLs shown as text.
    await expect(vendorRow(page, 'Vendor URL').locator('a')).toHaveText(vendor.url);
    await expect(vendorRow(page, 'Support Forum').locator('a')).toHaveText(vendor.forum);
    for (const a of await block.locator('a').all()) {
      expect(await a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data):/i);
    }
    await expect(block.locator('img')).toHaveCount(0);
  });

  test.describe('the vendor URLs follow the privacy settings', () => {
    // Values that need encoding, and a landing page that already has a query.
    const info = {
      name: 'fpp-tests cape',
      version: '1.0',
      serialNumber: 'SN 42&x=1#y',
      id: 'id/1+2',
      // No quote here: the parent's header script breaks on one, which the
      // escaping tests above cover, and these are about which values go out.
      cs: 'c+s=&',
      vendor: {
        name: 'fpp-tests',
        url: `${VENDOR}/`,
        landingPage: `${VENDOR}/landing?from=fpp`,
        email: 'support@example.com',
        forum: `${VENDOR}/forum`,
        image: `${VENDOR}/logo.png`,
      },
      header_cape_image: `${VENDOR}/header.png`,
    };
    const q = `sn=${phpUrlencode(info.serialNumber)}&id=${phpUrlencode(info.id)}&cs=${phpUrlencode(info.cs)}`;

    test('logos denied: no logo, and the serial is not on the link', async ({ page, request }) => {
      writeCapeInfo(info);
      // The old bug: the serial allowed, logos denied, and Cape Info's link
      // still carried the serial.
      await privacy(request, 0, 1);
      await page.goto('/index.php');
      await expect(page.locator('#header_Time')).toHaveCount(1);
      await expect(page.locator('.capeVendor')).toHaveCount(0);

      await page.goto('/cape-info.php');
      const link = vendorRow(page, 'Vendor URL').locator('a');
      // The control: the row is there.
      await expect(link).toHaveText(info.vendor.url);
      const href = await link.getAttribute('href') ?? '';
      for (const leak of ['sn=', 'id=', 'cs=', '42', 'SN']) {
        expect(href, `the link sends ${leak}`).not.toContain(leak);
      }
      await expect(page.locator('#eeprom-about .aboutRight img')).toHaveCount(0);
    });

    // The baseline for the other three, and the one case where the old code
    // already did the right thing, so it passes before 9d00d30ad as well.
    test('logos allowed, serial denied: plain URLs', async ({ page, request }) => {
      writeCapeInfo(info);
      await privacy(request, 1, 0);
      const asked = await vendorHost(page);
      await load(page, '/index.php', asked);
      await expectHeaderLogo(page, asked, info.header_cape_image);
      await expect(page.locator('#capeVendorLink')).toHaveAttribute('href', info.vendor.landingPage);

      await load(page, '/cape-info.php', asked);
      await expect(vendorRow(page, 'Vendor URL').locator('a')).toHaveAttribute('href', info.vendor.landingPage);
      const img = page.locator('#eeprom-about .aboutRight img');
      await expect(img).toHaveAttribute('src', info.vendor.image);
      await expect(img.locator('xpath=..')).toHaveAttribute('href', info.vendor.landingPage);
      // Everything the vendor was asked for here (this page has the header
      // logo too) is the plain URL.
      await expect.poll(() => asked).toContain(info.vendor.image);
      for (const u of asked) expect(u).not.toContain('?');
    });

    test('logos and serial allowed: sn, id and cs, urlencoded, on the logos and the links', async ({ page, request }) => {
      writeCapeInfo(info);
      await privacy(request, 1, 1);
      const asked = await vendorHost(page);
      await load(page, '/index.php', asked);
      await expectHeaderLogo(page, asked, `${info.header_cape_image}?${q}`);
      await expect(page.locator('#capeVendorLink')).toHaveAttribute('href', `${info.vendor.landingPage}&${q}`);

      await page.goto('/cape-info.php');
      await expect(vendorRow(page, 'Vendor URL').locator('a')).toHaveAttribute('href', `${info.vendor.landingPage}&${q}`);
      const img = page.locator('#eeprom-about .aboutRight img');
      await expect(img).toHaveAttribute('src', `${info.vendor.image}?${q}`);
      await expect(img.locator('xpath=..')).toHaveAttribute('href', `${info.vendor.landingPage}&${q}`);
    });

    test('hideExternalURLs: no link to follow, the logo is still shown', async ({ page, request }) => {
      writeCapeInfo(info);
      await privacy(request, 1, 1);
      // hideExternalURLs is not stored: config.php sets it for a kiosk's own
      // browser and for a request that carries this header.
      await page.setExtraHTTPHeaders({ 'Hide-External-Links': 'true' });
      const asked = await vendorHost(page);
      await load(page, '/index.php', asked);
      await expectHeaderLogo(page, asked, `${info.header_cape_image}?${q}`);
      await expect(page.locator('#capeVendorLink')).toHaveAttribute('href', '');

      await page.goto('/cape-info.php');
      await expect(vendorRow(page, 'Vendor URL').locator('a')).toHaveAttribute('href', '');
      const img = page.locator('#eeprom-about .aboutRight img');
      await expect(img).toHaveAttribute('src', `${info.vendor.image}?${q}`);
      await expect(img.locator('xpath=..')).toHaveAttribute('href', '');
      // E-mail and forum are external links too, so their rows go; the
      // control is that the block itself is still drawn.
      await expect(vendorRow(page, 'Vendor Name')).toHaveCount(1);
      await expect(vendorRow(page, 'E-mail')).toHaveCount(0);
      await expect(vendorRow(page, 'Support Forum')).toHaveCount(0);
    });
  });
});
