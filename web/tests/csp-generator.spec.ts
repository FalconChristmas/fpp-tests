import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';
import { writeFile, readFile } from './pw-helpers';

// scripts/ManageApacheContentPolicy.sh: what it builds the player's
// Content-Security-Policy from (its DEFAULT_VALUES, the override file in the
// media directory, the cape's vendor hosts), and the two ends that act on what
// it writes to etc/apache2.csp -- Apache, which must still start with it and
// serves it on every page, and the browser, which lets a page load and connect
// to what it names and nothing else.
//
// Every test puts the generated file, the override file and the cape file back
// and reloads Apache, so later specs see the policy run-web.sh generated.

test.skip(!container, 'changes the player\'s own CSP files and reloads its Apache');

const SCRIPT = '/opt/fpp/scripts/ManageApacheContentPolicy.sh';
const CSP_FILE = '/opt/fpp/etc/apache2.csp';
const OVERRIDES = '/home/fpp/media/config/csp_allowed_domains.json';
const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';

type Directives = Record<string, string[]>;

function parse(header: string): Directives {
  const out: Directives = {};
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

async function servedHeader(request: APIRequestContext, path = '/index.php'): Promise<string> {
  return (await request.get(path)).headers()['content-security-policy'] ?? '';
}

async function served(request: APIRequestContext, path = '/index.php'): Promise<Directives> {
  return parse(await servedHeader(request, path));
}

// Apache's graceful restart hands requests to new children over a moment;
// poll the served header rather than read it once.
async function reloadApache(request: APIRequestContext, until: (d: Directives) => boolean, message: string) {
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(async () => until(await served(request)), { message, timeout: 15_000 }).toBe(true);
}

// Run fn with the generated policy, the override file and the cape file saved,
// and put all three back (and Apache on the original policy) afterwards.
async function keepingPolicy<T>(request: APIRequestContext, fn: () => Promise<T>): Promise<T> {
  const before = await servedHeader(request);
  expect(before, 'run-web.sh\'s player serves a generated CSP').toContain('connect-src');
  try {
    return await keepingFile(CSP_FILE, () => keepingFile(OVERRIDES, () => keepingFile(CAPE_INFO, fn)));
  } finally {
    inPlayer('apache2ctl', 'graceful');
    await expect.poll(() => servedHeader(request), { message: 'the original policy is served again', timeout: 15_000 }).toBe(before);
  }
}

function runScript(...args: string[]): string {
  return inPlayer('sh', '-c', `cd /tmp && ${SCRIPT} ${args.map((a) => `'${a}'`).join(' ')} 2>&1; echo "rc=$?"`);
}

// What the browser does with the served policy: each probe loads an image, a
// font or a fetch() from a page and reports whether the page saw a CSP
// violation for it.  Everything that passes the policy and leaves the player
// is aborted, so nothing reaches the network either way.
type Probe = { kind: 'img' | 'font' | 'fetch'; url: string };

async function blocked(page: Page, probes: Probe[]): Promise<Record<string, boolean>> {
  return page.evaluate(async (list) => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
    const out: Record<string, boolean> = {};
    for (const p of list) {
      seen.length = 0;
      let url = p.url;
      if (url === 'blob:') url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      if (p.kind === 'img') {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = url;
        });
      } else if (p.kind === 'font') {
        await new FontFace('fpp-tests-probe', `url(${url})`).load().catch(() => {});
      } else {
        await fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 150));
      out[`${p.kind} ${p.url}`] = seen.length > 0;
    }
    return out;
  }, probes);
}

async function openProbePage(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await page.route((url) => url.origin !== origin, (route) => route.abort());
  await page.goto('/about.php');
}

const DATA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DATA_FONT = 'data:font/woff2;base64,d09GMgABAAAAAA==';
// A host no directive names (TEST-NET-1): the control every probe is judged against.
const NOWHERE = 'http://192.0.2.77';

test('add and remove put a domain into the policy Apache serves, and take it out again', async ({ request }) => {
  // Feature: 43d02cee5 (the script: `add <directive> <source>` records the
  // source in the override file, and the header is the defaults plus every
  // override), 8da8f6b56 (the override file is the media directory's
  // config/csp_allowed_domains.json, where cape detection writes too), and
  // 602320a77 (add/remove reload Apache, so the new policy is served without
  // a restart).  The player has no systemd: the systemctl here sends
  // `reload apache2` to the real Apache and hands every other call on.
  const added = 'https://added.fpp-tests.invalid';
  await keepingPolicy(request, async () => {
    const state = '/tmp/fpp-tests-csp-systemctl';
    inPlayer('sh', '-c', `rm -rf ${state} && mkdir -p ${state} && cp -a /usr/bin/systemctl ${state}/systemctl.real && : > ${state}/calls`);
    writeFile('/usr/bin/systemctl', `#!/bin/sh
echo "$*" >> ${state}/calls
case "$*" in
  "is-active --quiet apache2") exit 0 ;;
  "reload apache2") exec apache2ctl graceful ;;
esac
exec ${state}/systemctl.real "$@"
`);
    inPlayer('chmod', '755', '/usr/bin/systemctl');
    try {
      expect((await served(request))['connect-src']).not.toContain(added);

      const addOut = runScript('add', 'connect-src', added);
      expect(JSON.parse(readFile(OVERRIDES))['connect-src'], addOut).toContain(added);
      await expect.poll(async () => (await served(request))['connect-src'], {
        message: `Apache serves the added source without being restarted by hand: ${addOut}`, timeout: 15_000,
      }).toContain(added);

      const removeOut = runScript('remove', 'connect-src', added);
      expect(JSON.parse(readFile(OVERRIDES))['connect-src'], removeOut).not.toContain(added);
      await expect.poll(async () => (await served(request))['connect-src'], {
        message: `Apache stops serving the removed source: ${removeOut}`, timeout: 15_000,
      }).not.toContain(added);

      const calls = inPlayer('cat', `${state}/calls`).split('\n').filter((l) => l);
      expect(calls.filter((c) => c === 'reload apache2')).toHaveLength(2);
    } finally {
      inPlayer('sh', '-c', `[ -e ${state}/systemctl.real ] && cp -a ${state}/systemctl.real /usr/bin/systemctl; rm -rf ${state}`);
    }
  });
});

test('a missing override file is made from the template, with every directive add accepts', async ({ request }) => {
  // Feature: 230298cc7 (the override file's template is in the script, which
  // writes it when the file is missing -- a fresh player, or one whose media
  // was reset; `add` accepts only a directive the file already has) and
  // c869cbd1b (font-src is one of them).
  const font = 'https://fonts.fpp-tests.invalid';
  await keepingPolicy(request, async () => {
    inPlayer('rm', '-f', OVERRIDES);
    const out = runScript('regenerate-norestart');
    const overrides = JSON.parse(readFile(OVERRIDES) || '{}');
    expect(Object.keys(overrides).sort(), out).toEqual(
      ['connect-src', 'default-src', 'font-src', 'img-src', 'object-src', 'script-src', 'style-src']);
    expect(Object.values(overrides).every((v) => Array.isArray(v) && v.length === 0)).toBe(true);

    const addOut = runScript('add', 'font-src', font);
    expect(addOut).toContain(`Domain '${font}' added under 'font-src'.`);
    await reloadApache(request, (d) => (d['font-src'] ?? []).includes(font), `font-src gains the added host: ${addOut}`);
    expect((await served(request))['font-src']).toEqual(expect.arrayContaining(["'self'", 'data:', font]));
  });
});

test('pages may show blob: and data: images and use data: fonts, and nothing from elsewhere', async ({ page, baseURL }) => {
  // Feature: 00d9e3617 (img-src blob:), db42a0970 (img-src data:) and
  // c869cbd1b (font-src 'self' data:, for WLED's UI through the proxy, whose
  // icon font is inline; without font-src a data: font falls under
  // default-src 'self' and is refused).  The control is the same image and
  // font from a host the policy doesn't name.
  await openProbePage(page, baseURL!);
  const result = await blocked(page, [
    { kind: 'img', url: DATA_PNG },
    { kind: 'img', url: 'blob:' },
    { kind: 'img', url: `${NOWHERE}/x.png` },
    { kind: 'font', url: DATA_FONT },
    { kind: 'font', url: `${NOWHERE}/x.woff2` },
  ]);
  const r = JSON.stringify(result, null, 1);
  expect(result[`img ${NOWHERE}/x.png`], `the control: ${r}`).toBe(true);
  expect(result[`font ${NOWHERE}/x.woff2`], `the control: ${r}`).toBe(true);
  expect(result[`img ${DATA_PNG}`], r).toBe(false);
  expect(result['img blob:'], r).toBe(false);
  expect(result[`font ${DATA_FONT}`], r).toBe(false);
});

test('connect-src names the hosts the UI talks to and refuses any other', async ({ page, baseURL }) => {
  // Feature: cef4858c5 (connect-src is an explicit list again, after
  // 58bcbfb3c had opened it to '*'; remote players' lists come through the
  // player's /proxy/ instead) and 0b862ed56 (https://api.falconplayer.com,
  // which Cape Info's browser-side signing talks to -- see the signing test
  // below for the page itself).  The update check's fallback to
  // fppstats.falconchristmas.com/api/fpp_commits (c4fed817a: the source is the
  // host, not that one path) is allowed too.
  await openProbePage(page, baseURL!);
  const result = await blocked(page, [
    { kind: 'fetch', url: `${NOWHERE}/` },
    { kind: 'fetch', url: 'https://api.falconplayer.com/api/fpp/eeprom/sign' },
    { kind: 'fetch', url: 'https://fppstats.falconchristmas.com/api/fpp_commits?v=1' },
  ]);
  const r = JSON.stringify(result, null, 1);
  expect(result[`fetch ${NOWHERE}/`], r).toBe(true);
  expect(result['fetch https://api.falconplayer.com/api/fpp/eeprom/sign'], r).toBe(false);
  expect(result['fetch https://fppstats.falconchristmas.com/api/fpp_commits?v=1'], r).toBe(false);
});

test('the cape\'s vendor hosts are allowed for its images and connections', async ({ request, page, baseURL }) => {
  // Feature: 216818085 (the hosts of the cape's header image, vendor logo,
  // vendor site and landing page, read from the media directory's
  // tmp/cape-info.json, go into img-src as bare origins) and 3421c3968 (and
  // into connect-src, which 58bcbfb3c had commented out).
  const cape = {
    header_cape_image: 'https://hdr.fpp-tests.invalid/img/cape.png',
    vendor: {
      url: 'https://shop.fpp-tests.invalid/store/',
      image: 'https://img.fpp-tests.invalid/logos/logo.png',
      landingPage: 'https://land.fpp-tests.invalid/welcome?cape=1',
    },
  };
  const origins = ['https://hdr.fpp-tests.invalid', 'https://shop.fpp-tests.invalid', 'https://img.fpp-tests.invalid', 'https://land.fpp-tests.invalid'];
  await keepingPolicy(request, async () => {
    writeFile(CAPE_INFO, cape);
    const out = runScript('regenerate-norestart');
    await reloadApache(request, (d) => (d['img-src'] ?? []).includes('https://img.fpp-tests.invalid')
      || (d['connect-src'] ?? []).includes('https://shop.fpp-tests.invalid'), `the cape's hosts are in the policy: ${out}`);
    const d = await served(request);
    expect(d['img-src'], 'img-src').toEqual(expect.arrayContaining(origins));
    expect(d['connect-src'], 'connect-src').toEqual(expect.arrayContaining(origins));
    // Origins only: no path of the cape's URLs is in the policy.
    expect(await servedHeader(request)).not.toMatch(/fpp-tests\.invalid\//);

    // The receiving end: the browser loads the vendor's logo and reaches its
    // site, and still refuses a host the cape doesn't name.
    await openProbePage(page, baseURL!);
    const result = await blocked(page, [
      { kind: 'img', url: cape.vendor.image },
      { kind: 'img', url: cape.header_cape_image },
      { kind: 'fetch', url: cape.vendor.url },
      { kind: 'fetch', url: cape.vendor.landingPage },
      { kind: 'img', url: 'https://other.fpp-tests.invalid/logo.png' },
    ]);
    const r = JSON.stringify(result, null, 1);
    expect(result['img https://other.fpp-tests.invalid/logo.png'], `the control: ${r}`).toBe(true);
    expect(result[`img ${cape.vendor.image}`], r).toBe(false);
    expect(result[`img ${cape.header_cape_image}`], r).toBe(false);
    expect(result[`fetch ${cape.vendor.url}`], r).toBe(false);
    expect(result[`fetch ${cape.vendor.landingPage}`], r).toBe(false);
  });
});

test('a player whose media directory is not /home/fpp/media reads its cape from there', async () => {
  // Regression: f6f09b40a.  The cape file was read from
  // /home/fpp/media/tmp/cape-info.json whatever the media directory, so a
  // player with its media elsewhere (www/media_root.txt) never got its cape's
  // hosts.  Here the script runs from a copy of scripts/ in a tree whose
  // media_root.txt names a directory of the test's own.
  const tree = '/tmp/fpp-tests-csp-tree';
  const media = '/tmp/fpp-tests-csp-media';
  try {
    inPlayer('sh', '-c', `rm -rf ${tree} ${media} && mkdir -p ${tree}/www ${tree}/etc ${media}/config ${media}/tmp`
      + ` && cp -a /opt/fpp/scripts ${tree}/ && printf %s ${media} > ${tree}/www/media_root.txt`);
    writeFile(`${media}/tmp/cape-info.json`, { vendor: { url: 'https://shop.fpp-tests.invalid/', image: 'https://img.fpp-tests.invalid/logo.png' } });
    // The control: the device path has no cape file, so only the media
    // directory's can put these hosts in.
    expect(inPlayer('sh', '-c', `[ -e ${CAPE_INFO} ] && echo present || echo absent`).trim()).toBe('absent');
    const out = inPlayer('sh', '-c', `cd /tmp && ${tree}/scripts/ManageApacheContentPolicy.sh regenerate-norestart 2>&1`);
    const generated = readFile(`${tree}/etc/apache2.csp`);
    const header = generated.match(/Header set Content-Security-Policy "([^"]*)"/)?.[1] ?? '';
    expect(header, out).toContain('connect-src');
    const d = parse(header);
    expect(d['img-src'], generated).toEqual(expect.arrayContaining(['https://img.fpp-tests.invalid', 'https://shop.fpp-tests.invalid']));
    // The override file is the media directory's too.
    expect(inPlayer('sh', '-c', `[ -e ${media}/config/csp_allowed_domains.json ] && echo present || echo absent`).trim()).toBe('present');
  } finally {
    inPlayer('rm', '-rf', tree, media);
  }
});

test('an override with a % in it cannot stop Apache from starting', async ({ request }) => {
  // Regression: b88b5445c (issue 2729).  A link-local IPv6 remote that an
  // older backup page wrote into connect-src (http://fe80::1%wlan0) went into
  // the Header directive as is, and mod_headers reads "%w" as a format
  // specifier: Apache refused the config and would not start.  Remote IP
  // entries with a zone are now pruned from the override file like the rest,
  // and any token with a % or " is dropped from the generated header.
  await keepingPolicy(request, async () => {
    const overrides = JSON.parse(readFile(OVERRIDES));
    overrides['connect-src'] = ['http://fe80::1%wlan0', 'http://[fe80::2%eth0]:8080', 'https://kept.fpp-tests.invalid'];
    overrides['img-src'] = ['https://pct%41.fpp-tests.invalid', 'https://img-kept.fpp-tests.invalid'];
    writeFile(OVERRIDES, overrides);
    const out = runScript('regenerate-norestart');

    // The receiving end: Apache takes the config and serves the policy.
    expect(inPlayer('sh', '-c', 'apache2ctl -t 2>&1; echo rc=$?'), out).toContain('rc=0');
    expect(readFile(CSP_FILE)).not.toContain('%');
    // And the zoned remote addresses are gone from the override file too.
    expect(JSON.parse(readFile(OVERRIDES))['connect-src']).toEqual(['https://kept.fpp-tests.invalid']);
    await reloadApache(request, (d) => (d['connect-src'] ?? []).includes('https://kept.fpp-tests.invalid'), 'the regenerated policy is served');
    const d = await served(request);
    expect(d['img-src']).toContain('https://img-kept.fpp-tests.invalid');
    expect(d['img-src'].join(' ')).not.toContain('pct');
  });
});

test('Cape Info signs through the browser under the player\'s own policy when the player is offline', async ({ request, page }) => {
  // Feature: 0b862ed56.  When the player can't reach the signing API but the
  // browser can, Cape Info checks the API from the browser (a no-cors fetch,
  // afcf89ea3) and then posts the signing packet to it from the browser.
  // Both are connect-src requests to https://api.falconplayer.com; without it
  // in the policy the check is refused, the signing form stays hidden and
  // nothing can be signed.  The player's own requests and the signing API are
  // answered here; the policy is the one Apache serves.
  //
  // The cape: an unsigned virtual EEPROM on a licensed output driver, which is
  // when the signing form is drawn.  The player is made offline for the API by
  // pointing its name at a closed port.
  const pixelStrings = '/home/fpp/media/config/co-pixelStrings.json';
  try {
    await keepingFile('/etc/hosts', () => keepingFile(CAPE_INFO, () => keepingFile(pixelStrings, async () => {
      inPlayer('sh', '-c', 'echo "127.0.0.1 api.falconplayer.com" >> /etc/hosts');
      writeFile(CAPE_INFO, { serialNumber: 'FPP-INTERNAL', name: 'fpp-tests cape', id: 'fpp-tests' });
      writeFile(pixelStrings, { channelOutputs: [{ type: 'DPIPixels', enabled: 1, outputs: [] }] });

      const violations: string[] = [];
      page.on('console', (m) => { if (/Content Security Policy/.test(m.text()) && /falconplayer/i.test(m.text())) violations.push(m.text()); });
      const api: string[] = [];
      await page.route(/^https:\/\/api\.falconplayer\.com\//i, (route) => {
        api.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ Status: 'OK', key: 'signed' }) });
      });
      await page.route(/\/api\/cape\/eeprom\/signingData/, (route) => route.fulfill({ json: route.request().method() === 'GET'
        ? { key: 'FPPAFK-AAAAAA-BBBBBB-CCCCCC-DDDDDD', order: '123', eeprom: '' } : { Status: 'OK' } }));
      page.on('dialog', (d) => d.accept());

      await page.goto('/cape-info.php');
      await page.click('#eeprom-signature-tab');
      await expect(page.locator('#eeprom-signature')).toContainText('Unsigned');
      // The browser's reachability check went through, so the form is shown.
      await expect(page.locator('#orderNumber'), `CSP: ${violations.join('\n')}`).toBeVisible({ timeout: 10_000 });
      await page.fill('#orderNumber', '123');
      await page.fill('#licenseKey', 'FPPAFK-AAAAAA-BBBBBB-CCCCCC-DDDDDD');
      await page.click('input[value="Sign EEPROM"]');
      await expect(page.locator('#upgradeText')).toContainText('Signing Complete', { timeout: 15_000 });
      expect(api).toEqual(expect.arrayContaining(['GET /js/internetTest.js', 'POST /api/fpp/eeprom/sign']));
      expect(violations).toEqual([]);
    })));
  } finally {
    // A signed EEPROM asks for a reboot.
    await request.put('/api/settings/rebootFlag', { data: '0' });
  }
});
