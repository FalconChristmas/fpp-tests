import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The pending Git changes (GET api/git/originLog): the commits on the
// branch being tracked that this checkout does not have yet, listed by the
// System Upgrade page (about.php GetGitOriginLog / buildGitLogTableHtml) and
// by the shared dialog (fpp.js GetGitOriginLog).  A commit's author and
// message are text from whoever pushed to that branch (a fork, a feature
// branch), shown before the user has chosen to update: they must read as
// text and never run.

const HASH = 'b'.repeat(40);
const ROWS = [
  { hash: 'a'.repeat(40), author: 'Pat Tester', date: '2026-11-01', msg: 'fix: plain message' },
  { hash: HASH, author: 'Mallory <m@fpp-tests.invalid>', date: '2026-11-02',
    msg: 'speed up a<b && c>d <img src=x onerror="window.fppTestsRan=1">' },
];

async function answer(page: Page) {
  await page.route('**/api/git/originLog**', (r) => r.fulfill({ json: { status: 'OK', rows: ROWS } }));
}

async function check(page: Page, list: ReturnType<Page['locator']>) {
  await expect(list).toContainText('fix: plain message');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).fppTestsRan), 'markup in a commit message ran').toBeUndefined();
  await expect(list.locator('img')).toHaveCount(0);
  await expect(list).toContainText('Mallory <m@fpp-tests.invalid>');
  await expect(list).toContainText('speed up a<b && c>d <img src=x onerror="window.fppTestsRan=1">');
}

test('the plain commits are listed by both dialogs', async ({ page }) => {
  await page.route('**/api/git/originLog**', (r) => r.fulfill({ json: { status: 'OK', rows: [ROWS[0]] } }));
  await page.goto('/index.php');
  await page.evaluate(() => (window as any).GetGitOriginLog());
  await expect(page.locator('#GitOriginLogView')).toContainText('Pat Tester');
  await expect(page.locator('#GitOriginLogView')).toContainText('fix: plain message');

  await page.goto('/about.php');
  await page.evaluate(() => (window as any).GetGitOriginLog());
  const body = page.locator('#gitOriginLogModal .modal-body');
  await expect(body.locator('tbody tr')).toHaveCount(1);
  await expect(body).toContainText('aaaaaaaa');
  await expect(body).toContainText('2026-11-01');
});

test("the System Upgrade page shows a commit's author and message as text", async ({ page }) => {
  await answer(page);
  await page.goto('/about.php');
  await page.evaluate(() => (window as any).GetGitOriginLog());
  await check(page, page.locator('#gitOriginLogModal .modal-body'));
});

test("the shared Git Changes dialog shows a commit's author and message as text", async ({ page }) => {
  await answer(page);
  await page.goto('/index.php');
  await page.evaluate(() => (window as any).GetGitOriginLog());
  await check(page, page.locator('#GitOriginLogView'));
});
