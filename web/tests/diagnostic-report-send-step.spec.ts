import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Diagnostic Report wizard (F8) after its report is built: Send Report
// asks, sends it as File Manager does (crash-upload-delivery.spec.ts), and the
// wizard itself says how it went -- on to step 3 when the report was sent,
// otherwise kept on step 2 with what to do, or back to step 1 when the report
// has gone from the player.  And the build's own failures are said in words.
// The player's report API and the crash server are answered by the test;
// nothing is built or sent.

const FILE = '2026-11-11_10-00-00-fpp-tests-manual.zip';
const TARGET = 'https://crashes.falconplayer.com/crashUpload/index.php';

type Opts = { upload?: object | 'abort'; server?: number | 'abort'; del?: number; build?: object };
async function wizard(page: Page, o: Opts = {}) {
  const log: string[] = [];
  await page.route('**/api/crashes/report', (r) => r.fulfill({ json: o.build ?? { Status: 'OK', File: FILE, Size: 2_400_000 } }));
  await page.route('**/api/crashes/disclosures', (r) => r.fulfill({ json: { rows: [], goesTo: 'FPP developers' } }));
  await page.route('**/api/crashes/upload/**', (r) => {
    log.push('player sends');
    return o.upload === 'abort' ? r.abort() : r.fulfill({ json: o.upload ?? { Status: 'OK' } });
  });
  await page.route('**/api/crashes/uploadTarget', (r) => r.fulfill({ json: { url: TARGET, field: 'userfile' } }));
  await page.route('**/api/file/Crashes/**', (r) => {
    if (r.request().method() === 'DELETE') {
      log.push('delete');
      return r.fulfill({ status: o.del ?? 200, json: { status: (o.del ?? 200) === 200 ? 'OK' : 'ERROR' } });
    }
    return r.fulfill({ contentType: 'application/zip', body: Buffer.from('PK fpp-tests') });
  });
  await page.route(TARGET, (r) => {
    log.push('browser sends');
    return o.server === 'abort' ? r.abort() : r.fulfill({ status: typeof o.server === 'number' ? o.server : 200, body: 'ok' });
  });
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).ErNext === 'function');
  await page.keyboard.press('F8');
  await expect(page.locator('#errorReportDialog')).toBeVisible();
  return log;
}
const next = (page: Page) => page.click('#errorReportNextBtn');
async function buildAndSend(page: Page, answer: 'Yes' | 'No' = 'Yes') {
  await next(page); // Build Report
  await expect(page.locator('#errorReportDownloadArea')).toBeVisible();
  await next(page); // to Send
  await expect(page.locator('#erStepBody2')).toBeVisible();
  await expect(page.locator('#errorReportNextBtn')).toContainText('Send Report');
  await next(page);
  const ask = page.locator('#confirmUploadCrash');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText(FILE);
  await ask.getByRole('button', { name: answer, exact: true }).click();
  await expect(ask).toBeHidden();
}

test('a report that is sent goes on to step 3, said sent and deleted', async ({ page }) => {
  const log = await wizard(page);
  await buildAndSend(page);
  await expect(page.locator('#erStepBody3')).toBeVisible();
  await expect(page.locator('#errorReportSentNote')).toHaveText(/Report sent and deleted from the player\./);
  await expect(page.locator('#errorReportCloseBtn')).toHaveText('Done');
  await expect(page.locator('#errorReportOpenGHBtn')).toBeVisible();
  expect(log).toEqual(['player sends', 'delete']);
  // No results dialog over the wizard.
  await expect(page.locator('#dialogOKPopup')).toHaveCount(0);
});

test('a report sent but not deleted says so on step 3', async ({ page }) => {
  await wizard(page, { del: 500 });
  await buildAndSend(page);
  await expect(page.locator('#errorReportSentNote')).toContainText('Report sent, but it could not be deleted from the player');
});

test('No at the confirmation sends nothing, and says the report is still there', async ({ page }) => {
  const log = await wizard(page);
  await buildAndSend(page, 'No');
  await expect(page.locator('#errorReportSendStatus')).toContainText('Cancelled — nothing was sent. The report is still on the player');
  await expect(page.locator('#erStepBody2')).toBeVisible();
  await expect(page.locator('#errorReportNextBtn')).toContainText('Send Report');
  expect(log).toEqual([]);
});

test('a browser send with no answer stays on step 2, kept, and can be tried again', async ({ page }) => {
  const log = await wizard(page, { upload: 'abort', server: 'abort' });
  await buildAndSend(page);
  await expect(page.locator('#errorReportSendStatus')).toContainText('Your browser sent the report, but no delivery confirmation came back, so it has been kept on the player.');
  await expect(page.locator('#erStepBody2')).toBeVisible();
  await expect(page.locator('#errorReportNextBtn')).toContainText('Send Report');
  expect(log).toEqual(['player sends', 'browser sends']);
});

test('a refused send stays on step 2 with the reason', async ({ page }) => {
  const log = await wizard(page, { upload: { Status: 'ERROR', Message: 'fpp-tests <refused>' } });
  await buildAndSend(page);
  await expect(page.locator('#errorReportSendStatus .alert-danger')).toHaveText(
    `Send did not complete (${FILE} (fpp-tests <refused>)). The report stays on the player; try again or download it from File Manager › Crash Reports.`);
  expect(log).toEqual(['player sends']);
});

test('a report no longer on the player sends the wizard back to build a new one', async ({ page }) => {
  await wizard(page, { upload: { Status: 'ERROR', Code: 'not-found', Message: 'not found' } });
  await buildAndSend(page);
  await expect(page.locator('#erStepBody1')).toBeVisible();
  await expect(page.locator('#errorReportStatus')).toContainText('That report is no longer on the player: newer reports replaced it. Build a new one to send.');
  await expect(page.locator('#errorReportDownloadArea')).toBeHidden();
  await expect(page.locator('#errorReportNextBtn')).toContainText('Build Report');
  // Step 2 can't be gone back to without a report.
  await expect(page.locator('#erStepBtn2')).toBeDisabled();
});

for (const [code, said] of [
  ['busy', 'A report build is already running. Please wait a moment and try again.'],
  ['rate-limited', 'A report was just built. Please wait a few seconds and try again.'],
  ['build-failed', 'The report build failed on the player. Please try again, or check Troubleshooting.'],
  ['unavailable', 'fppd is running but did not respond. Try restarting FPPD, then try again.'],
] as const) {
  test(`a build refused as ${code} is said in words, and Build Report can be pressed again`, async ({ page }) => {
    await wizard(page, { build: { Status: 'ERROR', Code: code, Message: 'raw' } });
    await next(page);
    await expect(page.locator('#errorReportStatus .alert-danger')).toHaveText(said);
    await expect(page.locator('#errorReportNextBtn')).toContainText('Build Report');
  });
}

test('a report built while fppd is down says what it has instead', async ({ page }) => {
  await wizard(page, { build: { Status: 'OK', File: FILE, Size: 1000, Fppd: 'not-running' } });
  await next(page);
  await expect(page.locator('#errorReportStatus')).toContainText('fppd is not running, so this report was built without it.');
  await expect(page.locator('#errorReportDownloadText')).toContainText(FILE);
});
