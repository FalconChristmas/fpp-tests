import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The footer's Reboot and Shutdown ask in a dialog of the UI's own before
// they do anything.  The player is not rebooted or shut down here: the
// request that would do it is answered by the test.

// Answer the request instead of the player, and count it.
async function answer(page: Page, path: string): Promise<string[]> {
  const sent: string[] = [];
  await page.route(`**/${path}`, (route) => {
    sent.push(route.request().method());
    return route.fulfill({ status: 200, json: { status: 'OK' } });
  });
  return sent;
}

async function confirmDialog(page: Page, button: string, id: string) {
  await page.goto('/index.php');
  const shown = page.evaluate((id) => new Promise<void>((resolve) =>
    document.addEventListener('shown.bs.modal', (e) => { if ((e.target as HTMLElement).id === id) resolve(); })), id);
  await page.locator(`button[name="${button}"]`).click();
  await expect(page.locator(`#${id}`)).toBeVisible({ timeout: 10_000 });
  await shown;
  return page.locator(`#${id}`);
}

for (const { what, button, id, path, title, body, go, growl } of [
  { what: 'Reboot', button: 'btnReboot', id: 'RebootModal', path: 'api/system/reboot', title: 'Reboot FPP Device?',
    body: 'Are you sure you wish to reboot the device?', go: '#RebootButton', growl: 'FPP is rebooting..' },
  { what: 'Shutdown', button: 'btnShutdown', id: 'ShutdownModal', path: 'api/system/shutdown', title: 'Shutdown FPP Device?',
    body: 'Are you sure you wish to shutdown the device?', go: '#ShutdownButton', growl: 'FPP is shutting down..' },
]) {
  test(`${what} asks in the UI's own dialog, and goes ahead only when told to`, async ({ page }) => {
    // Feature: 0a9d5bfcd (Reboot) and c0aaaff31 (Shutdown).  Both asked with
    // the browser's confirm(), which a browser can be set to suppress, and
    // which says "the Falcon Player" whatever the device.
    const nativeDialogs: string[] = [];
    page.on('dialog', (d) => { nativeDialogs.push(d.message()); return d.dismiss(); });
    const sent = await answer(page, path);

    let modal = await confirmDialog(page, button, id);
    await expect(modal.locator('.modal-title')).toHaveText(title);
    await expect(modal.locator('.modal-body')).toHaveText(body);
    // Abort closes it and reloads the page; nothing is sent.
    const reloaded = page.waitForEvent('load');
    await modal.locator('#AbortButton').click();
    await reloaded;
    await page.waitForTimeout(1_500);
    expect(sent).toEqual([]);

    modal = await confirmDialog(page, button, id);
    await modal.locator(go).click();
    await expect(modal).toBeHidden();
    await expect.poll(() => sent, { timeout: 10_000 }).toEqual(['POST']);
    await expect(page.locator('.jGrowl-message', { hasText: growl })).toBeVisible();
    expect(nativeDialogs).toEqual([]);
  });
}
