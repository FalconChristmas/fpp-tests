import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { container, inPlayer } from './container';

// Smaller page behaviors from FPP 10.1/10.2, one or two tests each.

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('release notes markdown is rendered with only safe markup', async ({ page }) => {
  // Feature: 51524c8c5.  about.php's OS release notes went through an inline
  // converter that emitted <a href="$2"> unchecked (javascript: links) and
  // left the rest of a hostile release body to the page; MarkdownToSafeHtml()
  // escapes everything and links only http(s).
  await page.goto('/index.php');
  const html = await page.evaluate(() =>
    (window as any).MarkdownToSafeHtml(
      '# Title\r\n\r\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> **bold** [ok](https://example.com/a_b)\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n'));
  const doc = await page.evaluate((h) => {
    const d = document.createElement('div');
    d.innerHTML = h;
    return {
      tags: [...d.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()),
      hrefs: [...d.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      text: d.textContent,
    };
  }, html);
  expect(doc.tags).not.toContain('img');
  expect(doc.tags).toContain('table');
  expect(doc.tags).toContain('strong');
  expect(doc.hrefs).toEqual(['https://example.com/a_b']);
  expect(doc.text).toContain('<img src=x onerror=alert(1)>');

  // One very long line of the kind that makes a backtracking pattern crawl.
  const ms = await page.evaluate(() => {
    const t = Date.now();
    (window as any).MarkdownToSafeHtml('*_'.repeat(50000) + '[' .repeat(20000));
    return Date.now() - t;
  });
  expect(ms).toBeLessThan(2000);
});

test.describe('the cape vendor logo', () => {
  test.skip(!container, 'seeds cape info inside the run-web.sh container');
  // The player's CSP only names a vendor's host once the cape is detected at
  // boot; the test cape here is added afterwards, so it is not what is tested.
  test.use({ bypassCSP: true });
  const INFO = '/home/fpp/media/tmp/cape-info.json';

  test.afterEach(async ({ request }) => {
    inPlayer('rm', '-f', INFO);
    await request.put('/api/settings/FetchVendorLogos', { data: '0' });
  });

  test('loads from a host that sends no CORS headers', async ({ page, request }) => {
    // Regression: 694c2ff06.  The header logo was fetched with an
    // XMLHttpRequest, which most vendor hosts' missing
    // Access-Control-Allow-Origin blocks, so it never appeared.  The vendor
    // host is a server here on another port: another origin to the page.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    let served = 0;
    const vendor = http.createServer((req, res) => {
      served++;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
    });
    await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
    const { port } = vendor.address() as AddressInfo;
    try {
      inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && cat > ${INFO} <<'EOF'
{"id":"fpp-tests","name":"fpp-tests cape","serialNumber":"1","vendor":{"name":"fpp-tests","url":"http://127.0.0.1:${port}/","image":"http://127.0.0.1:${port}/logo.png"}}
EOF`);
      await request.put('/api/settings/FetchVendorLogos', { data: '1' });
      await page.goto('/index.php');
      await expect.poll(() => served).toBeGreaterThan(0);
      await expect(page.locator('#capeVendorLink img.logo')).toHaveCount(1);
    } finally {
      vendor.close();
    }
  });
});

// A canned api/system/updateStatus answer: no update of any kind.
function noUpdate(checked: boolean) {
  return {
    status: 'OK', branchUpgradeAvailable: false, branchUpgradeTarget: '', branchUpgradeVersion: '',
    isMajorVersionUpgrade: false, commitUpdateAvailable: false, remoteCommit: '', currentBranch: 'master',
    localCommit: 'abc1234', versionUnknown: false, isEndOfLife: false, latestMajorVersion: 10, checked,
  };
}

async function answerUpdateStatus(page: Page, body: object): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/api/system/updateStatus*', (route: Route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: body });
  });
  return asked;
}

test('the upgrade page says the check failed, not "Up to Date", when no update source answered', async ({ page }) => {
  // Regression: c4022c009.  A check that reached neither fppstats nor the git
  // remote came back with every "update available" field false, and the page
  // showed that as Up to Date.
  await answerUpdateStatus(page, noUpdate(false));
  await page.goto('/about.php');
  await expect(page.locator('#fppVersionStatusBadge')).toHaveText('Check Failed');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await answerUpdateStatus(page, noUpdate(true));
  await page.goto('/about.php');
  await expect(page.locator('#fppVersionStatusBadge')).toHaveText('Up to Date');
});

test('the upgrade page and the menu share one update check', async ({ page }) => {
  // Regression: 7f7ff9345.  about.php fetched api/system/updateStatus itself
  // as well as the menu's check; the server can answer two requests half a
  // second apart from either side of a cache refresh, so the two views could
  // disagree on the same page.
  const asked = await answerUpdateStatus(page, { ...noUpdate(true), commitUpdateAvailable: true, remoteCommit: 'def5678' });
  await page.goto('/about.php');
  await expect(page.locator('#fppVersionStatusBadge')).toHaveText('Update Available');
  await expect(page.locator('#navbarUpdateAvail')).toBeVisible();
  await page.waitForTimeout(2000);
  expect(asked).toHaveLength(1);
});

test('selecting a tab neither scrolls the page nor adds to history', async ({ page }) => {
  // Regression: 77f8f68fb.  The shared tab wiring assigned location.hash,
  // which scrolled the pane to the top of the window and pushed a history
  // entry per click, and then called scrollToTop().
  // Short enough that every pane scrolls 200 px: the System pane in Docker
  // has only a few hundred pixels more than this since 7e5913f47 dropped
  // its empty headings.
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto('/settings.php#settings-playback');
  await page.waitForLoadState('load');
  await expect(page.locator('#settings-playback-tab')).toHaveClass(/active/);
  const before = await page.evaluate(() => history.length);
  for (const tab of ['ui', 'system', 'services']) {
    // The pane being left fills in as it loads; scroll once it is tall enough.
    await expect.poll(() => page.evaluate(() => { window.scrollTo(0, 200); return window.scrollY; })).toBe(200);
    await page.evaluate((t) => (document.querySelector(`#settings-${t}-tab`) as HTMLElement).click(), tab);
    await expect(page.locator(`#settings-${tab}-tab`)).toHaveClass(/active/);
    await page.waitForTimeout(500);
    // Where it was, unless the new pane is too short to stay there.
    const { y, max } = await page.evaluate(() => ({ y: window.scrollY, max: document.scrollingElement!.scrollHeight - innerHeight }));
    expect(y, `after selecting ${tab}`).toBe(Math.min(200, max));
    expect(y, `after selecting ${tab}`).toBeGreaterThan(0);
    expect(new URL(page.url()).hash).toBe(`#settings-${tab}`);
  }
  // settings.php records the tab once itself; the shared wiring added a second
  // entry per click.
  expect(await page.evaluate(() => history.length) - before).toBeLessThanOrEqual(3);
});

test('a settings tab shows a spinner while it loads, and says so when it fails', async ({ page }) => {
  // Feature: 741efbd94 (#2871).  The theme had no .spinner-border at all, so
  // the one spinner on the page was invisible; each tab now gets its own
  // while its content loads, and an error if it never does.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/settings-system.php', async (route) => {
    await held;
    await route.fulfill({ status: 500, body: 'fpp-tests' });
  });
  await page.goto('/settings.php#settings-system');
  const spinner = page.locator('#settings-system .spinner-border');
  await expect(spinner).toBeVisible();
  expect(await spinner.evaluate((e) => getComputedStyle(e).animationName)).toBe('spinner-border');
  release();
  await expect(page.locator('#settings-system')).toContainText('Failed to load this settings page');
});

test('finishing setup with nothing reboot-worthy changed asks for no reboot', async ({ page }) => {
  // Regression: ce026dca7.  recordPromptedSettings() puts every control the
  // wizard showed into pendingSettings, and needsReboot() asked only whether a
  // reboot-flagged one was there, so the end of every setup raised the
  // reboot flag.
  await page.goto('/initialSetup.php');
  await page.waitForLoadState('load');
  const rebootSettings = await page.evaluate(() => (window as any).rebootSettings as string[]);
  expect(rebootSettings).toContain('HostName');
  expect(await page.evaluate(() => {
    (window as any).recordPromptedSettings();
    return (window as any).needsReboot();
  })).toBe(false);

  // The control: changing one does.
  expect(await page.evaluate(() => {
    (document.getElementById('HostName') as HTMLInputElement).value = 'fpp-tests-renamed';
    (window as any).recordPromptedSettings();
    return (window as any).needsReboot();
  })).toBe(true);
});

test.describe('Channel Outputs with a panel cape', () => {
  test.skip(!container, 'seeds cape info inside the run-web.sh container');
  const INFO = '/home/fpp/media/tmp/cape-info.json';
  test.afterEach(async ({ request }) => {
    inPlayer('rm', '-f', INFO);
    await request.put('/api/settings/uiLevel', { data: '0' });
  });

  test('opens on the LED Panels tab', async ({ page, request }) => {
    // Regression: f76e9f85a.  The page opened on E1.31 whenever that tab was
    // shown, whatever the cape drives; at Advanced level every cape gets it.
    // (The Pixel Strings tab is not offered on the test player's platform, so
    // a panel cape is the case that can be shown.)
    await request.put('/api/settings/uiLevel', { data: '1' });
    inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && echo '{"id":"fpp-tests","name":"fpp-tests panel cape","provides":["panels"]}' > ${INFO}`);
    await page.goto('/channeloutputs.php');
    await expect(page.locator('#tab-LEDPanels-tab')).toHaveClass(/active/);
    await expect(page.locator('#tab-e131-tab')).not.toHaveClass(/active/);

    await expect(page.locator('#tab-e131-tab')).toBeVisible();

    // The control: with no cape, E1.31.
    inPlayer('rm', '-f', INFO);
    await page.goto('/channeloutputs.php');
    await expect(page.locator('#tab-e131-tab')).toHaveClass(/active/);
  });
});

test('each setup wizard step starts at the top of the page', async ({ page }) => {
  // Regression: a5e63ef6a.  The next step arrived scrolled to wherever the
  // last one ended, on a short step past its bottom.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 800, height: 500 });
  await page.goto('/initialSetup.php');
  await page.waitForLoadState('load');
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo(0, document.scrollingElement!.scrollHeight);
    return window.scrollY;
  })).toBeGreaterThan(100);
  // Leaving step 1 waits out cape detection, which finds no I2C bus here.
  await page.locator('#setupNextBtn').click();
  await expect(page.locator('.setupStep[data-step="2"]')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('the Variables page fits a tablet-wide screen', async ({ page }) => {
  // Regression: c125fd4ec (#2956).  Fixed-width columns made the page wider
  // than a 768px screen, so the navbar never collapsed to its toggler.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/variables.php');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1000);
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(inner);
});
