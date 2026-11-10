import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Network page's Delete Interface (DeleteInterface()): live only for a
// saved config whose interface isn't present hardware (the API's own rule,
// network-interface-names.spec.ts), it asks first, and on Delete removes the
// saved config and its tab without reloading, so the Restart Network prompt
// stays up; Cancel keeps it; a refusal from the API is shown, not dropped.

test.skip(!container, 'writes a saved interface config inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';
const GONE = 'eth7';
const sh = (s: string) => inPlayer('sh', '-c', s);

// A saved config whose interface isn't here is listed from the Advanced UI
// level up.
let restoreSettings: () => void = () => {};
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
  sh(`printf 'INTERFACE=${GONE}\\nPROTO=dhcp\\n' > ${CONFIG}/interface.${GONE}`);
});
test.afterEach(() => {
  restoreSettings();
  sh(`rm -f ${CONFIG}/interface.${GONE} ${CONFIG}/leases.${GONE}`);
});

async function open(page: import('@playwright/test').Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/networkconfig.php');
  await expect(page.locator(`#${GONE}-tab`)).toBeVisible({ timeout: 15_000 });
}
const del = (page: import('@playwright/test').Page) => page.locator('#btnDeleteInterface:visible');
const dialog = (page: import('@playwright/test').Page) => page.locator('#deleteInterfaceDialog');

test("a saved config for an interface that isn't here is deleted, after asking, with its tab", async ({ page }) => {
  await open(page);
  // eth0 is this player's own: reconfigured, never deleted.
  await page.click('#eth0-tab');
  await expect(del(page)).toBeDisabled();
  await page.click(`#${GONE}-tab`);
  await expect(del(page)).toBeEnabled();

  // Cancel keeps it.
  await del(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText(`Delete the saved FPP configuration for ${GONE}?`);
  await dialog(page).locator('button', { hasText: 'Cancel' }).click();
  await expect(dialog(page)).toBeHidden();
  expect(sh(`test -e ${CONFIG}/interface.${GONE} && echo kept`).trim()).toBe('kept');

  const sent = page.waitForRequest((r) => r.method() === 'DELETE');
  await del(page).click();
  await dialog(page).locator('button', { hasText: 'Delete' }).click();
  expect(new URL((await sent).url()).pathname).toBe(`/api/network/interface/${GONE}`);
  await expect(page.locator('.jGrowl-message', { hasText: `${GONE} interface configuration deleted` })).toBeVisible();
  await expect(page.locator(`#${GONE}-tab`)).toHaveCount(0);
  await expect(page.locator(`#selInterfaces option[value="${GONE}"]`)).toHaveCount(0);
  expect(sh(`test -e ${CONFIG}/interface.${GONE} && echo kept || echo gone`).trim()).toBe('gone');
  // The other interfaces are still there.
  await expect(page.locator('#eth0-tab')).toBeVisible();
});

test('a delete the API refuses says why', async ({ page }) => {
  await page.route((u) => u.pathname.endsWith(`/api/network/interface/${GONE}`), (r) =>
    r.request().method() === 'DELETE'
      ? r.fulfill({ status: 409, json: { status: `ERROR: ${GONE} is carrying this request` } })
      : r.fallback());
  await open(page);
  await page.click(`#${GONE}-tab`);
  await del(page).click();
  await dialog(page).locator('button', { hasText: 'Delete' }).click();
  await expect(page.locator('.modal.show', { hasText: `ERROR: ${GONE} is carrying this request` })).toBeVisible();
  await expect(page.locator(`#${GONE}-tab`)).toBeVisible();
  expect(sh(`test -e ${CONFIG}/interface.${GONE} && echo kept`).trim()).toBe('kept');
});
