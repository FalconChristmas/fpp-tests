import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Every page the menu offers, at the Basic level most users stay at and at
// Advanced: each one answers, and loads without a script error.  The main
// pages' libraries are vendored-libraries.spec.ts; this is the menu's whole
// reach.  The pages are only opened, nothing on them is pressed.

test.skip(!container, 'sets the UI level in the run-web.sh player');
test.describe.configure({ timeout: 300_000 });

let restore: () => void;
test.beforeEach(() => { restore = snapshotSettings(); });
test.afterEach(() => restore());

async function menuPages(page: Page) {
  await page.goto('/index.php');
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('nav a[href], #fppMenu a[href], .navbar a[href]'))
    .map((a) => (a as HTMLAnchorElement).href));
  const origin = new URL(page.url()).origin;
  // Same-origin pages, without in-page anchors, each once.
  return [...new Set(hrefs.filter((h) => h.startsWith(origin + '/')).map((h) => new URL(h))
    .filter((u) => /\.php$/.test(u.pathname) && !/[?&](action|command)=/.test(u.search))
    .map((u) => u.pathname + u.search))].sort();
}

async function visit(page: Page, path: string) {
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
  page.on('pageerror', onError);
  const r = await page.goto(path);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.off('pageerror', onError);
  return { status: r?.status(), errors };
}

for (const [level, name] of [['0', 'Basic'], ['1', 'Advanced']]) {
  test(`every page the ${name} menu offers loads without a script error`, async ({ page }) => {
    setSettingInFile('uiLevel', level);
    const pages = await menuPages(page);
    expect(pages.length, 'menu links found').toBeGreaterThan(15);
    const bad: string[] = [];
    for (const p of pages) {
      const { status, errors } = await visit(page, p);
      if (status !== 200 || errors.length) bad.push(`${p}: ${status} ${errors.join(' | ')}`);
    }
    expect(bad).toEqual([]);
  });
}
