import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The warnings banner every page shows under the header (#warningsRow),
// built by updateWarnings() in js/fpp.js from the status: each numbered
// warning is a link that opens a help modal with the warning's title and help
// text from warnings-definitions.json.  The warnings are fppd's own, raised
// through its command API.  Each test raises one that fppd drops on its own
// after 60 s, and waits for it to go before it ends, so no later test (or a
// test looking for a warning of its own) finds it on the banner.

async function warningUp(request: APIRequestContext, id: number, text: string) {
  await expect.poll(async () => {
    const status = await (await request.get('/api/system/status')).json();
    return (status.warningInfo ?? []).some((w: any) => w.id == id && String(w.message).includes(text));
  }, { timeout: 15_000 }).toBe(true);
}

// fppd clears these on a timer only, so wait the timer out.
async function warningGone(request: APIRequestContext, id: number, text: string) {
  await expect.poll(async () => {
    const status = await (await request.get('/api/system/status')).json();
    return (status.warningInfo ?? []).some((w: any) => w.id == id && String(w.message).includes(text));
  }, { timeout: 90_000, intervals: [2_000] }).toBe(false);
}

function warningLink(page: Page, text: string) {
  return page.locator('#warningsDiv a[data-warning-idx], #warningsDiv a[onclick]', { hasText: text });
}

test('a warning whose text holds quotes opens its help modal', async ({ page, request }) => {
  // Regression: 3b175a73e.  The click handler was an inline onclick= built
  // by pasting the message into a JS string in an attribute,
  // doWarningMDModal(49,'<message>'): a quote in the message ended the
  // string (or the attribute), and the link did nothing.  Warning 49 names
  // the effect that could not be opened, quotes and all.
  test.setTimeout(150_000);
  const name = `fpp-tests it's a "quoted" effect`;
  await request.post('/api/command', { data: { command: 'Effect Start', args: [name, '1', 'false', 'false', 'false'] } });
  try {
    await warningUp(request, 49, name);

    await page.goto('/index.php');
    const link = warningLink(page, name);
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toContainText('Warning ID: 49');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await link.click();
    const dialog = page.locator('#warningHelpDialog');
    await expect(dialog.locator('.modal-title')).toContainText(name);
    await expect(dialog.locator('.modal-body zero-md')).toHaveAttribute('src', 'help/warning-helpers/warning-49.md');
    expect(errors).toEqual([]);
  } finally {
    await warningGone(request, 49, 'fpp-tests');
  }
});

test('the warnings fppd raises that had no definition open their help', async ({ page, request }) => {
  // Regression: c24707c7e.  Ids 59, 62, 63, 64, 70, 71, 72 and 73 had no
  // entry in warnings-definitions.json: no title, no help text, and the help
  // modal had nothing to show (it threw on the missing body).

  // Warning 70: fppd refuses a script path that leaves the scripts
  // directory (and answers the command with an error).
  test.setTimeout(150_000);
  await request.post('/api/command', { data: { command: 'Run Script', args: ['../fpp-tests-outside.sh', '', ''] } });
  try {
    await warningUp(request, 70, 'outside the scripts directory');

    await page.goto('/index.php');
    const link = warningLink(page, 'outside the scripts directory');
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toContainText('Warning ID: 70');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await link.click();
    const dialog = page.locator('#warningHelpDialog');
    await expect(dialog.locator('.modal-title')).toContainText('Refused to run a script outside the scripts directory');
    await expect(dialog.locator('.modal-body')).toContainText('Put the script in the scripts directory');
    expect(errors).toEqual([]);

    // And every one of them has a title, help text and a group.
    const defs = await (await request.get('/warnings-definitions.json')).json();
    for (const id of [59, 62, 63, 64, 70, 71, 72, 73]) {
      const def = defs.Warnings.find((w: any) => w.id === id);
      expect(def, `warning ${id}`).toBeDefined();
      expect(def.Title, `warning ${id}`).not.toBe('');
      expect(def.HelpTxt, `warning ${id}`).not.toBe('');
      expect(defs.WarningGroups[def.WarningGroup], `warning ${id}'s group`).toBeDefined();
    }
  } finally {
    await warningGone(request, 70, 'fpp-tests-outside.sh');
  }
});

test('no warnings leaves the banner hidden, not an empty heading', async ({ page }) => {
  // Regression: de8b35a3a.  With the status socket, the page's status always
  // carries a warnings array, empty when nothing is wrong, and the banner
  // showed for the key alone: an "Abnormal Conditions" heading over an empty
  // list.  The test takes this player's warnings out of what fppd pushes
  // over the socket and what PHP answers -- fppd leaves the keys out when it
  // has none -- and the banner has to stay hidden.
  let strip = true;
  await page.routeWebSocket('**/fppdws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (!strip || typeof message !== 'string') return ws.send(message);
      try {
        const msg = JSON.parse(message);
        const status = msg?.data?.status;
        if (status) {
          delete status.warnings;
          delete status.warningInfo;
        }
        ws.send(JSON.stringify(msg));
      } catch {
        ws.send(message);
      }
    });
  });
  await page.route('**/api/system/status**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (strip) {
      delete json.warnings;
      delete json.warningInfo;
    }
    return route.fulfill({ response, json });
  });

  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  await page.goto('/index.php');
  // Fed by the socket: the page has had snapshots, and they had no warnings.
  await expect.poll(() => frames.filter((f) => f.includes('"snapshot"')).length, { timeout: 15_000 }).toBeGreaterThan(2);
  expect(await page.evaluate(() => (window as any).lastStatusJSON?.warnings)).toEqual([]);
  await expect(page.locator('#warningsRow')).toBeHidden();
  await expect(page.locator('#warningsDiv')).not.toContainText('Abnormal Conditions');

  // The control: this player has a warning of its own (it has no mDNS
  // daemon), and once it gets through the banner shows it.
  strip = false;
  await expect(page.locator('#warningsRow')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#warningsDiv')).toContainText('Abnormal Conditions');
});
