import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The status page's Extend button (fpp.js ExtendSchedulePopup): it asks for
// minutes, refuses anything outside -180..720, and sends the Extend Schedule
// command with that many seconds.  The command is answered here, so the
// schedule is never changed.

async function extend(page: Page, answer: string | null) {
  const sent: any[] = [];
  await page.route('**/api/command', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    sent.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ body: 'Extended' });
  });
  await page.goto('/index.php');
  page.once('dialog', (d) => (answer === null ? d.dismiss() : d.accept(answer)));
  await page.evaluate(() => (window as any).ExtendSchedulePopup());
  await page.waitForTimeout(700);
  return sent;
}
const refused = (page: Page) => expect(page.locator('#dialogOKPopup')).toContainText('Minutes must be a number between -180 and 720.');

test('minutes in range are sent as seconds, and out of range or cancelled sends nothing', async ({ page }) => {
  expect(await extend(page, '30')).toEqual([{ command: 'Extend Schedule', args: [1800] }]);
  expect(await extend(page, '-180')).toEqual([{ command: 'Extend Schedule', args: [-10800] }]);
  expect(await extend(page, '721')).toEqual([]);
  await refused(page);
  expect(await extend(page, '-181')).toEqual([]);
  await refused(page);
  expect(await extend(page, null)).toEqual([]);
});

test('an answer that is not a number is refused, not sent', async ({ page }) => {
  expect(await extend(page, 'ten')).toEqual([]);
  await refused(page);
});
