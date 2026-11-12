import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { WLAN, addWlan, removeWlan } from './wifi-stubs';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Network page's confirmations and its WiFi connection line: Restart
// Network (which re-runs the player's network setup for the interface on
// show), deferring that to a reboot, Create and Clear Persistent Names, and
// the status a wireless interface reports.  Each of the first four changes
// how the player is reached, so "No" and "Cancel" must send nothing and
// "Yes" exactly one request, for the right interface.
// Every one of those requests is answered here: the player's network is not
// restarted, its names are not changed and no reboot is flagged on it.

test.skip(!container, 'adds a wireless adapter to the run-web.sh player');

let restoreSettings: () => void;
test.beforeAll(() => addWlan());
test.afterAll(() => removeWlan());
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '2');
});
test.afterEach(() => restoreSettings());

type Status = Record<string, unknown> | number;
const CONNECTED = { status: 'OK', connected: true, reason: 'Connected to fpp-tests-net', signal: -55, wpa_state: 'COMPLETED', hotspotActive: false };

async function open(page: Page, status: Status = CONNECTED) {
  const sent: string[] = [];
  const flags: Record<string, string> = {};
  let statusAsked = 0;
  await page.route((u) => /\/api\/network\/interface\/[^/]+\/apply$/.test(u.pathname), (route) => {
    sent.push(`${route.request().method()} ${new URL(route.request().url()).pathname.replace(/^.*\/api\//, '')}`);
    return route.fulfill({ json: { status: 'OK', output: [] } });
  });
  await page.route((u) => u.pathname.endsWith('/api/network/persistentNames'), (route) => {
    sent.push(`${route.request().method()} network/persistentNames`);
    return route.fulfill({ json: { status: 'OK' } });
  });
  await page.route((u) => u.pathname.includes('/api/network/wifi/status/'), (route) => {
    statusAsked++;
    return typeof status === 'number' ? route.fulfill({ status, body: 'no' }) : route.fulfill({ json: status });
  });
  // The restart and reboot flags are settings: kept here, not on the player.
  await page.route((u) => u.pathname.includes('/api/settings/'), (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    flags[new URL(route.request().url()).pathname.replace(/\/$/, '').split('/').pop()!] = route.request().postData() ?? '';
    return route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/networkconfig.php');
  await expect(page.locator(`#${WLAN}-tab`)).toBeVisible({ timeout: 15_000 });
  return { sent, flags, asked: () => statusAsked };
}

const banner = (page: Page) => page.locator('#btnConfigNetwork');
// What a saved change does once it is saved.
const changeSaved = (page: Page) => page.evaluate(() => (window as any).ShowNetworkApplyPrompt());
const settle = (page: Page) => page.waitForTimeout(750);

async function restartNetwork(page: Page) {
  await changeSaved(page);
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole('button', { name: 'Restart Network' }).click();
  const dialog = page.locator('#applyNetworkConfirm');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.modal-title')).toHaveText('Apply Network Changes');
  await page.waitForTimeout(400);
  return dialog;
}

test('Restart Network, confirmed, applies the interface on show once and takes the banner away', async ({ page }) => {
  const { sent, flags } = await open(page);
  await page.click('#eth0-tab');
  await expect(page.locator('#eth_static_eth0')).toBeVisible({ timeout: 15_000 });
  const dialog = await restartNetwork(page);
  await dialog.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect.poll(() => sent).toEqual(['POST network/interface/eth0/apply']);
  await expect(dialog).toBeHidden();
  await expect(banner(page)).toBeHidden();
  await settle(page);
  expect(sent).toHaveLength(1);
  // Applied now: nothing is left for a reboot to do.
  expect(flags).not.toHaveProperty('rebootFlag');
});

test('on a wireless interface it applies that interface, and watches it reconnect', async ({ page }) => {
  const { sent, asked } = await open(page);
  await page.click(`#${WLAN}-tab`);
  await expect(page.locator(`#wifiStatus_${WLAN}`)).toContainText('Connected to fpp-tests-net', { timeout: 15_000 });
  const dialog = await restartNetwork(page);
  const before = asked();
  await dialog.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect.poll(() => sent).toEqual([`POST network/interface/${WLAN}/apply`]);
  // Asked again at once, and again a few seconds on, as the link comes back.
  await expect.poll(() => asked()).toBeGreaterThan(before);
  const first = asked();
  await expect.poll(() => asked(), { timeout: 10_000 }).toBeGreaterThan(first);
});

test('put off to the next reboot, nothing is applied and a reboot is flagged instead', async ({ page }) => {
  const { sent, flags } = await open(page);
  await page.click('#eth0-tab');
  await expect(page.locator('#eth_static_eth0')).toBeVisible({ timeout: 15_000 });
  const dialog = await restartNetwork(page);
  await dialog.getByRole('button', { name: 'Cancel and apply at next reboot' }).click();

  await expect(dialog).toBeHidden();
  await expect(banner(page)).toBeHidden();
  await expect.poll(() => flags.rebootFlag).toBe('1');
  await settle(page);
  expect(sent, 'the network was not restarted').toEqual([]);
});

test('with the hotspot up, a saved change asks for a reboot and never offers Restart Network', async ({ page }) => {
  // Restarting the network drops whoever is tethered through the hotspot,
  // most likely the person at this page.
  const { sent, flags } = await open(page, { ...CONNECTED, hotspotActive: true });
  await changeSaved(page);
  await expect.poll(() => flags.rebootFlag).toBe('1');
  await expect(banner(page)).toBeHidden();
  expect(sent).toEqual([]);
});

for (const [button, title, method] of [
  ['Create Persistent Names', 'Create Persistent Names', 'POST'],
  ['Clear Persistent Names', 'Clear Persistent Names', 'DELETE'],
] as const) {
  test(`${button}: No sends nothing, Yes sends one ${method} and reloads the page`, async ({ page }) => {
    const { sent } = await open(page);
    const id = method === 'POST' ? 'createPersistentDialog' : 'clearPersistentDialog';
    const press = page.locator(`input[value="${button}"]`);
    await press.scrollIntoViewIfNeeded();
    await press.click();
    const dialog = page.locator(`#${id}`);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.modal-title')).toHaveText(title);
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await expect(dialog).toBeHidden();
    await settle(page);
    expect(sent).toEqual([]);

    await press.click();
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    const reloaded = page.waitForEvent('load');
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await reloaded;
    expect(sent).toEqual([`${method} network/persistentNames`]);
  });
}

const statusLine = (page: Page) => page.locator(`#wifiStatus_${WLAN}`);
async function openStatus(page: Page, status: Status) {
  await open(page, status);
  await page.click(`#${WLAN}-tab`);
  await expect(statusLine(page)).not.toBeEmpty({ timeout: 15_000 });
}

test('a connected wireless interface shows its network and signal, as good news', async ({ page }) => {
  await openStatus(page, CONNECTED);
  await expect(statusLine(page)).toHaveText('Connected to fpp-tests-net · -55 dBm');
  await expect(statusLine(page)).toHaveClass(/fpp-alert--success/);
  await expect(statusLine(page).locator('i')).toHaveClass(/fa-check-circle/);
});

for (const [what, status, variant, icon] of [
  ['a wrong password', { status: 'OK', connected: false, reason: 'Authentication failed (wrong password?)', wpa_state: 'DISCONNECTED' }, 'danger', 'fa-times-circle'],
  ['associated but not yet connected', { status: 'OK', connected: false, reason: 'Associated, waiting for an address', wpa_state: 'COMPLETED' }, 'info', 'fa-info-circle'],
  ['still scanning', { status: 'OK', connected: false, reason: 'Scanning for fpp-tests-net', wpa_state: 'SCANNING', signal: -70 }, 'warning', 'fa-exclamation-triangle'],
] as const) {
  test(`an interface that is not connected says why (${what}), without a signal`, async ({ page }) => {
    await openStatus(page, status);
    await expect(statusLine(page)).toHaveText(status.reason);
    await expect(statusLine(page)).toHaveClass(new RegExp(`fpp-alert--${variant}`));
    await expect(statusLine(page).locator('i')).toHaveClass(new RegExp(icon));
    await expect(statusLine(page)).not.toContainText('dBm');
  });
}

for (const [what, status] of [['fails', 500], ['answers with an error', { status: 'ERROR: no such interface' }]] as const) {
  test(`a status request that ${what} is shown as unavailable, not as a connection`, async ({ page }) => {
    await openStatus(page, status);
    await expect(statusLine(page)).toHaveText('Connection status unavailable.');
    await expect(statusLine(page)).toHaveClass(/fpp-alert--info/);
  });
}

test('a network name with markup in it is shown as text', async ({ page }) => {
  // The reason carries the SSID, which is whatever a nearby access point calls itself.
  await openStatus(page, { ...CONNECTED, reason: 'Connected to <img src=x onerror="window.__ssid=1"><b>net</b>', signal: null });
  await expect(statusLine(page)).toHaveText('Connected to <img src=x onerror="window.__ssid=1"><b>net</b>');
  await expect(statusLine(page).locator('img, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__ssid)).toBeUndefined();
});
