import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager's Tail Follow dialog (TailFollowFile in fpp.js): a log
// streamed into a modal over an EventSource, from
// api/file/Logs/tailfollow/<log>.

test.skip(!container, 'writes a log inside the run-web.sh container');

const LOG = '/home/fpp/media/logs/fpp-tests-follow-dialog.log';

test.beforeEach(async ({ page }) => {
  inPlayer('sh', '-c', `seq -f 'fpp-tests line %g' 1 20 > ${LOG}`);
  // Every EventSource the page opens, and whether the dialog had finished
  // showing when it did (Bootstrap's modal is mid-transition from show()
  // until it fires shown.bs.modal).
  await page.addInitScript(() => {
    const w = window as any;
    w.__fppTestsSources = [];
    const Real = window.EventSource;
    w.EventSource = function (url: string, init?: EventSourceInit) {
      const el = document.getElementById('tailFollowDialog');
      const modal = el && w.bootstrap?.Modal.getInstance(el);
      const whenShown = !!modal && el!.classList.contains('show') && !modal._isTransitioning;
      const es = new Real(url, init);
      w.__fppTestsSources.push({ url: String(url), whenShown, es });
      return es;
    } as any;
    w.EventSource.prototype = Real.prototype;
  });
});
test.afterEach(() => {
  inPlayer('rm', '-f', LOG);
});

async function openTailFollow(page: Page) {
  await page.locator('#tab-logs input[value="Tail Follow"]').click();
  const dialog = page.locator('#tailFollowDialog');
  await expect(dialog.locator('#tailFollowText')).toContainText('fpp-tests line 20', { timeout: 15_000 });
  return dialog;
}
// The Logs tab, with the log selected.
async function logsTab(page: Page) {
  await page.goto('/filemanager.php#tab-logs');
  await page.locator('#tab-logs-tab').click();
  await page.locator('#tblLogs tbody tr').filter({ has: page.locator('td', { hasText: /^fpp-tests-follow-dialog\.log$/ }) }).click();
}
const sources = (page: Page) =>
  page.evaluate(() => (window as any).__fppTestsSources.map((s: any) => ({ url: s.url, whenShown: s.whenShown })));

test('the stream starts once the dialog is shown', async ({ page }) => {
  // Regression: 17bf060e3.  The stream was opened straight after the dialog
  // was asked to show, while it was still fading in (the next test shows
  // what that did to the view).
  await logsTab(page);
  await openTailFollow(page);
  const opened = await sources(page);
  expect(opened).toHaveLength(1);
  expect(opened[0].url).toContain('api/file/Logs/tailfollow/fpp-tests-follow-dialog.log');
  expect(opened[0].whenShown, 'the dialog had finished showing').toBe(true);
});

test('reopening the dialog opens one stream, not one more each time', async ({ page }) => {
  // Regression: 8edab0edd.  The dialog is reused, and each opening added
  // another shown.bs.modal handler with .on(): the third opening started
  // three streams (each closing the one before), the log fetched again
  // each time.
  await logsTab(page);
  for (let i = 1; i <= 3; i++) {
    const dialog = await openTailFollow(page);
    await expect.poll(async () => (await sources(page)).length).toBe(i);
    await dialog.locator('#tailFollowCloseButton').click();
    await expect(dialog).toBeHidden();
  }
  await page.waitForTimeout(500);
  expect(await sources(page)).toHaveLength(3);
});

test('the dialog keeps the newest line in view as the log grows', async ({ page }) => {
  // Regression: 17bf060e3.  With the stream opened before the dialog had
  // finished showing, the view stayed at the top of the log as lines came
  // in.  Also 3b42a6a48 (the scroll deferred to the next frame, scroll
  // anchoring off), a fix for macOS browsers: Chromium keeps the line in view
  // either way, so only the anchoring style is asserted.
  await page.setViewportSize({ width: 1600, height: 700 });
  await logsTab(page);
  const dialog = await openTailFollow(page);
  const body = dialog.locator('.modal-body');
  inPlayer('sh', '-c', `seq -f 'fpp-tests line %g' 21 400 >> ${LOG}`);
  await expect(dialog.locator('#tailFollowText')).toContainText('fpp-tests line 400', { timeout: 15_000 });
  // 3b42a6a48: the log box opts out of scroll anchoring, which macOS browsers
  // fight with the scroll to the bottom.
  expect(await dialog.locator('#tailFollowText').evaluate((e) => getComputedStyle(e).overflowAnchor)).toBe('none');
  const dims = await body.evaluate((b) => ({ scroll: b.scrollHeight, client: b.clientHeight }));
  expect(dims.scroll, 'the log is longer than the dialog').toBeGreaterThan(2 * dims.client);
  await expect.poll(() => body.evaluate((b) => b.scrollHeight - b.clientHeight - b.scrollTop), { timeout: 5_000 }).toBeLessThanOrEqual(2);
});
