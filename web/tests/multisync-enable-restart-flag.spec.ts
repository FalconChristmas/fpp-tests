import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// "Send MultiSync Packets" on the MultiSync page is the MultiSyncEnabled
// setting, which settings.json marks restart: 2 -- fppd needs a quick
// restart to pick it up, and saving it records that in restartFlag.

test.skip(!container, 'reads the stored settings inside the run-web.sh container');

const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });

function stored(name: string): string {
  return inPlayer('sh', '-c', `grep '^${name} ' /home/fpp/media/settings || true`).trim();
}

test.afterEach(async ({ page }) => {
  await put(page, 'MultiSyncEnabled', '0');
  await put(page, 'restartFlag', '0');
});

test('toggling Send MultiSync Packets asks for a quick restart, not an undefined one', async ({ page }) => {
  // Regression: f134a91d6 (#2724).  The page's MultiSyncEnableToggled()
  // called SetRestartFlag() with no value, after the setting's own save had
  // set it to 2, so restartFlag was saved as "undefined": the status answer
  // carried no restart request a page or the API could act on.
  await put(page, 'MultiSyncEnabled', '0');
  await put(page, 'restartFlag', '0');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [] } }));
  await page.goto('/multisync.php');
  const box = page.locator('#MultiSyncEnabled');
  await expect(box).not.toBeChecked();
  const saved = page.waitForResponse((r) => r.url().includes('/api/settings/MultiSyncEnabled') && r.request().method() === 'PUT');
  await box.check();
  expect((await saved).ok()).toBe(true);
  await expect.poll(() => stored('MultiSyncEnabled')).toBe('MultiSyncEnabled = "1"');
  // Let any later write of the flag land.
  await page.waitForTimeout(1500);
  expect(stored('restartFlag')).toBe('restartFlag = "2"');
  // The receiving end: the status the header reads asks for that restart.
  const status = await (await page.request.get('/api/system/status')).json();
  expect(String(status.restartFlag)).toBe('2');
});
