import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The warnings banner (#warningsRow) as updateWarnings() in js/fpp.js draws
// it from the status's warningInfo: one list item per warning, with its
// group's icon from warnings-definitions.json, as a link to its help when
// the definition has any.  These tests put the warnings they need into the
// status the page is fed -- over fppd's socket and from api/system/status --
// so any id can be shown without raising it in fppd (status-warnings-banner
// raises real ones).

type Warning = { id: number; message: string };

// Feed the page these warnings, as fppd's own.  The augmentation poll
// (?systemonly=1) has its warnings taken out, so each shows once.
async function feedWarnings(page: Page, warnings: Warning[]) {
  const set = (status: any) => {
    status.warnings = warnings.map((w) => w.message);
    status.warningInfo = warnings.map((w) => ({ ...w }));
  };
  await page.routeWebSocket('**/fppdws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== 'string') return ws.send(message);
      try {
        const msg = JSON.parse(message);
        if (msg?.data?.status) set(msg.data.status);
        ws.send(JSON.stringify(msg));
      } catch {
        ws.send(message);
      }
    });
  });
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (route.request().url().includes('systemonly')) {
      delete json.warnings;
      delete json.warningInfo;
    } else {
      set(json);
    }
    return route.fulfill({ response, json });
  });
}

// The banner's list item for the warning whose message is this.
function item(page: Page, message: string) {
  return page.locator('#warningsDiv li', { hasText: message });
}

test('each warning is a list item with its group\'s icon, a link only when it has help', async ({ page }) => {
  // Feature: f14442278 (warnings-definitions.json: groups with their icons)
  // and 6bde8fe60 (each warning with an id drawn from its definition, its
  // group's icon and "Warning ID", as a link).  Also 5e1bde7fe: the list is
  // a <ul>, one <li> per warning, not lines run together with <br>.
  // Regression: 4ba6cb407.  Every warning with an id was a link, help or
  // not: one with neither help text nor a help page opened nothing useful.
  // Also 10a9b9802: the warnings come from the status's warningInfo, and the
  // icon takes the place of the list's bullet (an id-less warning gets a
  // dot); b34efb531 for the FPPD group's feather-alt icon.
  await feedWarnings(page, [
    { id: 0, message: 'fpp-tests a warning without an id' },
    { id: 49, message: 'fpp-tests an effect with help' },
    { id: 57, message: 'fpp-tests a plugin warning without help' },
  ]);
  await page.goto('/index.php');
  await expect(page.locator('#warningsRow')).toBeVisible({ timeout: 15_000 });
  const list = page.locator('#warningsDiv > ul');
  await expect(list.locator('> li')).toHaveCount(3);
  expect(await list.evaluate((ul) => getComputedStyle(ul).listStyleType)).toBe('none');

  const plain = item(page, 'fpp-tests a warning without an id');
  await expect(plain.locator('i.fa-circle')).toHaveCount(1);
  await expect(plain.locator('a')).toHaveCount(0);

  const helped = item(page, 'fpp-tests an effect with help');
  const link = helped.locator('a[data-warning-idx]');
  await expect(link).toHaveCount(1);
  await expect(link.locator('i.fa-feather-alt')).toHaveCount(1);
  await expect(link.locator('i.fa-link')).toHaveCount(1);
  await expect(link).toContainText('Warning ID: 49');

  const unhelped = item(page, 'fpp-tests a plugin warning without help');
  await expect(unhelped.locator('i.fa-puzzle-piece')).toHaveCount(1);
  await expect(unhelped.locator('a')).toHaveCount(0);
  await expect(unhelped).not.toContainText('Warning ID');
});

test('the heading offers help only when a warning has an id', async ({ page }) => {
  // Regression: fd5e3bbeb.  "(Click link icon for help)" headed the list
  // when no warning in it had a link.
  await feedWarnings(page, [{ id: 0, message: 'fpp-tests a warning without an id' }]);
  await page.goto('/index.php');
  const heading = page.locator('#warningsDiv > b');
  await expect(heading).toContainText('Abnormal Conditions', { timeout: 15_000 });
  await expect(heading).not.toContainText('Click link icon for help');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await feedWarnings(page, [{ id: 49, message: 'fpp-tests an effect with help' }]);
  await page.goto('/index.php?with-id');
  await expect(heading).toContainText('(Click link icon for help)', { timeout: 15_000 });
});

test('a warning with a Markdown help page opens it rendered, styled from the player', async ({ page }) => {
  // Feature: efab45770 (the help modal for a warning with an .md page, shown
  // with zero-md), ba3e8ddbd and 91b35657e (zero-md 3.1.2 shipped, and
  // defined as <zero-md> on every page).  Regression: 17653774e, which
  // shipped zero-md's stylesheets with fpp and pointed it at them: they came
  // from a CDN, so a player off the internet showed the help unstyled.  Also 54790c25c and 2c41758fd: the definition names the page by
  // its type (HelpPageType "md"), the page being help/warning-helpers/
  // warning-<id>.md.
  await feedWarnings(page, [{ id: 49, message: 'fpp-tests an effect with help' }]);
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.goto('/index.php');
  const host = new URL(page.url()).host;
  const link = item(page, 'fpp-tests an effect with help').locator('a[data-warning-idx]');
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  const dialog = page.locator('#warningHelpDialog');
  await expect(dialog.locator('.modal-title')).toHaveText('Warning ID: 49 - fpp-tests an effect with help');
  // Rendered, not the Markdown source: the page's heading is an <h1>.
  await expect(dialog.locator('zero-md h1')).toHaveText('Effect Could Not Be Started', { timeout: 15_000 });
  await expect(dialog.locator('zero-md li').first()).toBeVisible();
  // Every stylesheet it asks for is the player's own, and loaded.
  const sheets = () => dialog.locator('zero-md').evaluate((el) =>
    Array.from(el.shadowRoot?.querySelectorAll('link[rel="stylesheet"]') ?? []).map((l) => {
      const link = l as HTMLLinkElement;
      let rules = 0;
      try { rules = link.sheet?.cssRules.length ?? 0; } catch { rules = -1; }
      return { href: link.href, rules };
    }));
  await expect.poll(async () => (await sheets()).filter((s) => s.rules <= 0).map((s) => s.href), { timeout: 10_000 }).toEqual([]);
  const loaded = await sheets();
  expect(loaded.length).toBeGreaterThan(0);
  for (const { href } of loaded) expect(new URL(href).host, href).toBe(host);
  expect(requested.filter((u) => /^https?:/.test(u) && new URL(u).host !== host)).toEqual([]);
});

test('a warning with help text opens it in the help modal', async ({ page }) => {
  // Feature: 53c6db5d5.  A definition with only HelpTxt (no help page) gets
  // its text shown in the modal.
  await feedWarnings(page, [{ id: 58, message: 'fpp-tests the sound card went away' }]);
  await page.goto('/index.php');
  const link = item(page, 'fpp-tests the sound card went away').locator('a[data-warning-idx]');
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  const dialog = page.locator('#warningHelpDialog');
  await expect(dialog.locator('.modal-title')).toHaveText('Warning ID: 58 - fpp-tests the sound card went away');
  await expect(dialog.locator('.modal-body')).toContainText('The configured audio output sound card is no longer present');
});

test('a warning whose help page is PHP opens what warningHelper.php answers', async ({ page }) => {
  // Feature: b2e921c55 (doWarningPHPModal: a "php" help page is fetched from
  // warningHelper.php and shown in the modal) and 079c52381 (warningHelper.php).
  // No shipped definition uses "php" yet, so the definition is changed for
  // this page.
  await page.route('**/warnings-definitions.json*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.Warnings.find((w: any) => w.id === 49).HelpPageType = 'php';
    return route.fulfill({ response, json });
  });
  await feedWarnings(page, [{ id: 49, message: 'fpp-tests an effect with PHP help' }]);
  await page.goto('/index.php');
  const link = item(page, 'fpp-tests an effect with PHP help').locator('a[data-warning-idx]');
  await expect(link).toBeVisible({ timeout: 15_000 });
  const helper = page.waitForResponse((r) => new URL(r.url()).pathname === '/warningHelper.php');
  await link.click();
  const answer = await helper;
  expect(answer.status()).toBe(200);
  expect(new URL(answer.url()).searchParams.get('id')).toBe('49');
  const dialog = page.locator('#warningHelpDialog');
  await expect(dialog.locator('.modal-title')).toHaveText('Warning ID: 49 - fpp-tests an effect with PHP help');
  await expect(dialog.locator('.modal-body')).toContainText('Beginning of PHP Warning Handling');
});

test('with fppd not running, the banner says so with a link to its help', async ({ page }) => {
  // Regression: b34efb531.  The "FPPD Daemon is not running" warning was
  // added to the status's warnings but not its warningInfo, which the banner
  // draws from since 10a9b9802: it was left off.  Its definition (id 1)
  // gained a help page then.  fppd keeps running for the suite, so the page
  // is shown what it would get without it: no socket, and the status PHP
  // gives when fppd does not answer.
  await page.routeWebSocket('**/fppdws', (ws) => ws.close());
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.fppd = 'Not Running';
    json.status = 'stopped';
    json.status_name = 'stopped';
    delete json.warnings;
    delete json.warningInfo;
    return route.fulfill({ response, json });
  });
  await page.goto('/index.php');
  const notRunning = item(page, 'FPPD Daemon is not running');
  await expect(notRunning).toBeVisible({ timeout: 30_000 });
  const link = notRunning.locator('a[data-warning-idx]');
  await expect(link).toContainText('Warning ID: 1');
  await expect(link.locator('i.fa-feather-alt')).toHaveCount(1);
  await link.click();
  const dialog = page.locator('#warningHelpDialog');
  await expect(dialog.locator('.modal-title')).toHaveText('Warning ID: 1 - FPPD Daemon is not running');
  await expect(dialog.locator('zero-md h1')).toHaveText('FPPD Has Crashed', { timeout: 15_000 });
});
