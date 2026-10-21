import { test, expect } from './fixtures';
import { container } from './container';
import { routePluginList } from './plugin-backfill';

// The Plugins page's view of the plugin list: what it recommends, what it
// says about a plugin, and the install dialog.  The list (fetched by the
// browser from GitHub) is served by the test, so these plugins are made up
// and nothing is installed.

test.skip(!container, 'serves the plugin list to the page (run-web.sh)');

const RAW = 'https://raw.githubusercontent.com/fpp-tests';
const compatible = [{ minFPPVersion: '10.0', maxFPPVersion: '0', branch: 'master' }];
const untested = [{ minFPPVersion: '9.0', maxFPPVersion: '0', branch: 'master' }];

type Listing = { name: string; info: Record<string, unknown>; date?: string; owner?: string };
async function serveList(page: any, plugins: Listing[]) {
  const list: unknown[][] = [];
  const infos: Record<string, unknown> = {};
  for (const p of plugins) {
    const url = `${RAW.replace('fpp-tests', p.owner || 'fpp-tests')}/${p.name}/master/pluginInfo.json`;
    list.push(p.date ? [p.name, url, '', p.date] : [p.name, url]);
    infos[url] = {
      name: `${p.name} title`, repoName: p.name, srcURL: `https://github.com/fpp-tests/${p.name}.git`,
      versions: compatible, ...p.info,
    };
  }
  await routePluginList(page, list, infos);
}

async function setNoticeAcknowledged(request: any, value: string) {
  await request.put('/api/settings/pluginNoticeAcknowledged', { data: value });
}

async function openPage(page: any, cards: string[]) {
  await page.goto('/plugins.php');
  for (const c of cards) {
    await expect(page.locator(`[id="row-${c}"]`)).toBeAttached({ timeout: 20_000 });
  }
}

test('the detail popup says when a plugin joined the plugin list, and a fork gets no date', async ({ page }) => {
  // Feature: 74146431f.  The listing's date (4th field) shows as "Listed
  // <Mon YYYY>", matched on the repository the code comes from, so a
  // same-named fork from another repository is not given it.
  await serveList(page, [
    { name: 'fpp-tests-dated', info: {}, date: '2026-03-15' },
    { name: 'fpp-tests-fork', info: { srcURL: 'https://github.com/someone-else/fpp-tests-fork.git' }, date: '2026-04-15' },
  ]);
  await openPage(page, ['fpp-tests-dated', 'fpp-tests-fork']);
  const dialog = page.locator('#pluginDetailDialog');
  await page.evaluate(() => (window as any).ShowPluginDetail('fpp-tests-dated'));
  await expect(dialog.locator('.pluginListedChip')).toHaveText(/Listed Mar 2026/);
  await page.evaluate(() => (window as any).CloseModalDialog('pluginDetailDialog'));
  await expect(dialog).toBeHidden();
  await page.evaluate(() => (window as any).ShowPluginDetail('fpp-tests-fork'));
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.pluginListedChip')).toHaveCount(0);
});

test('the first install shows the plugin notice once, and a plugin with no disclosure says so in red', async ({ page, request }) => {
  // Feature: 6b4a27930 (a one-time notice about plugins, recorded as the FPP
  // major it was acknowledged under, instead of a warning in every install
  // dialog).  Regression: 92a73ade3 (a plugin with no privacy disclosure got
  // a quiet grey line; now a red warning and "Install anyway").
  await setNoticeAcknowledged(request, '');
  try {
    await serveList(page, [{ name: 'fpp-tests-nodisc', info: {} }]);
    await openPage(page, ['fpp-tests-nodisc']);
    const install = page.locator('[id="row-fpp-tests-nodisc"] [data-plugin-action="install"]').first();
    const notice = page.locator('#pluginNoticeDialog');
    const dialog = page.locator('#confirmInstallDialog');

    await install.click();
    await expect(notice).toBeVisible();
    await notice.locator('button', { hasText: 'Continue' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.fpp-major-callout')).toContainText('No privacy disclosure');
    await expect(dialog.locator('.modal-footer button', { hasText: 'Install anyway' })).toBeVisible();
    await dialog.locator('.modal-footer button', { hasText: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    const major = String(await page.evaluate(() => (window as any).FPP_MAJOR_VERSION));
    await expect.poll(async () => (await (await request.get('/api/settings/pluginNoticeAcknowledged')).json()).value).toBe(major);

    // Acknowledged, on a fresh load of the page: straight to the install
    // dialog.
    await openPage(page, ['fpp-tests-nodisc']);
    await install.click();
    await expect(dialog).toBeVisible();
    await expect(notice).toBeHidden();
    await dialog.locator('.modal-footer button', { hasText: 'Cancel' }).click();

    // Acknowledged under an older major: asked again.
    await setNoticeAcknowledged(request, String(Number(major) - 1));
    await openPage(page, ['fpp-tests-nodisc']);
    await install.click();
    await expect(notice).toBeVisible();
  } finally {
    await setNoticeAcknowledged(request, '');
  }
});

test('the install dialog names the plugin a nested dependency is for', async ({ page, request }) => {
  // Regression: 2813b9b1d.  Every dependency was "(a plugin this one depends
  // on)", so a dependency of a dependency was attributed to the plugin being
  // installed.
  const disclosed = { privacy: { sends: [], collects: [], sensors: [], remoteAccess: 'none', systemChanges: [], closedCode: false } };
  await setNoticeAcknowledged(request, '99');
  try {
    await serveList(page, [
      { name: 'fpp-tests-dep-a', info: { ...disclosed, dependencies: { plugins: ['fpp-tests-dep-b'] } } },
      { name: 'fpp-tests-dep-b', info: { ...disclosed, dependencies: { plugins: ['fpp-tests-dep-c'] } } },
      { name: 'fpp-tests-dep-c', info: { ...disclosed } },
    ]);
    await openPage(page, ['fpp-tests-dep-a', 'fpp-tests-dep-b', 'fpp-tests-dep-c']);
    await page.locator('[id="row-fpp-tests-dep-a"] [data-plugin-action="install"]').first().click();
    const deps = page.locator('#confirmInstallDialog .pluginInstallDependency');
    await expect(deps).toHaveCount(2);
    await expect(deps.nth(0)).toContainText('(a plugin this one depends on)');
    await expect(deps.nth(1)).toContainText('(a plugin fpp-tests-dep-b title depends on)');
    await expect(page.locator('#confirmInstallDialog')).toContainText(/fpp-tests-dep-b title[\s\S]*fpp-tests-dep-c title/);
  } finally {
    await setNoticeAcknowledged(request, '');
  }
});

test('the privacy lights say what a disclosure says, and no more', async ({ page }) => {
  // Regression: 92a73ade3 (no disclosure at all is red, every light "not
  // disclosed"), 1e62280c9 (a missing key is grey "not disclosed", not
  // green; an always-on send to a public host or over http:// is red, to a
  // LAN address or a .local name amber; stored GPIO readings are amber, a
  // stored camera red; "serial port" is not a hardware id), f00270532 (lan
  // and internet-authenticated remote access each say what they are, an
  // unknown value is the generic amber, and nothing claims "off by
  // default"), caf4a3067 (installButtonFor stays, for pages outside FPP),
  // c81ebe8d2 (every chip reads "light: state", so a green one can't be
  // taken for the undeclared one).
  await serveList(page, []);
  await page.goto('/plugins.php');
  await page.waitForFunction(() => !!(window as any).FPPPluginPrivacy);
  const r = await page.evaluate(() => {
    const P = (window as any).FPPPluginPrivacy;
    const base = { sends: [], collects: [], sensors: [], remoteAccess: 'none', systemChanges: [], closedCode: false };
    const light = (block: any, id: string) => {
      const l = P.evaluate(block).lights.find((x: any) => x.id === id);
      return { level: l.level, label: l.label, state: l.state };
    };
    const send = (to: string) => light({ ...base, sends: [{ what: 'show status', to, why: 'a dashboard', alwaysOn: true }] }, 'send');
    const none = P.evaluate(null);
    const { remoteAccess, ...noRemote } = base;
    return {
      button: P.installButtonFor({}),
      none: { red: none.red, headline: none.headline.text, levels: none.lights.map((l: any) => l.level) },
      missingKey: light(noRemote, 'remote'),
      allGreen: P.evaluate(base).lights.map((l: any) => l.level),
      publicHost: send('stats.example.com'),
      plainHttp: send('http://203.0.113.9/api'),
      lanIp: send('192.168.1.20'),
      dotLocal: send('projector.local'),
      serialPort: light({ ...base, sends: [{ what: 'the serial port name', to: 'your MQTT broker', why: 'x', alwaysOn: false }] }, 'send'),
      gpioKept: light({ ...base, sensors: [{ type: 'gpio-input', stored: true }] }, 'camera'),
      cameraKept: light({ ...base, sensors: [{ type: 'camera', stored: true }] }, 'camera'),
      lan: light({ ...base, remoteAccess: 'lan' }, 'remote'),
      authed: light({ ...base, remoteAccess: 'internet-authenticated' }, 'remote'),
      unknown: light({ ...base, remoteAccess: 'carrier-pigeon' }, 'remote'),
      html: P.stripHtml(P.evaluate({ ...base, remoteAccess: 'lan' })) + P.detailsHtml(P.evaluate({ ...base, remoteAccess: 'lan' })),
      chips: Array.from(new DOMParser().parseFromString(P.stripHtml(P.evaluate({ ...base, remoteAccess: 'lan' })), 'text/html').body.querySelectorAll('button, .badge, span'))
        .map((e: any) => e.textContent.trim()).filter((t: string) => /: /.test(t)),
    };
  });
  expect(r.button).toMatchObject({ text: 'Install' });
  expect(r.none).toEqual({ red: true, headline: 'No privacy disclosure', levels: ['r', 'r', 'r', 'r', 'r', 'r'] });
  expect(r.allGreen).toEqual(['g', 'g', 'g', 'g', 'g', 'g']);
  expect(r.missingKey).toMatchObject({ level: 'n', state: 'not disclosed' });
  expect(r.publicHost.level).toBe('r');
  expect(r.plainHttp.level).toBe('r');
  expect(r.lanIp.level).toBe('a');
  expect(r.dotLocal.level).toBe('a');
  expect(r.serialPort.level).toBe('a');
  expect(r.serialPort.label).not.toMatch(/identif/i);
  expect(r.gpioKept.level).toBe('a');
  expect(r.cameraKept.level).toBe('r');
  expect(r.lan).toMatchObject({ level: 'a', label: 'Listens on your network' });
  expect(r.authed).toMatchObject({ level: 'a', label: 'Reachable from the internet, with a login' });
  expect(r.unknown).toMatchObject({ level: 'a', label: 'Listens for connections' });
  expect(r.html).not.toMatch(/off by default|off until you enable/i);
  expect(r.chips).toEqual(expect.arrayContaining(['Sends data: none', 'Remote access: on your network', 'Source: all published']));
});
