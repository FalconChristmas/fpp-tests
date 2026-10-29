import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { settingInFile } from './settings-file';

// Which tab of the Settings page a setting is on, at which UI level it is
// shown, and that saving it from there reaches what reads it.  The groups and
// levels come from www/settings.json; settings.php builds the tabs.

test.skip(!container, 'writes the settings file inside the run-web.sh container');

async function openTab(page: Page, tab: string) {
  await page.goto(`/settings.php?tab=${tab}`);
  await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(page.locator('#settingsManagerTabsContent .tab-pane.active .settingsTable, #settingsManagerTabsContent .tab-pane.active [id$="Row"]').first())
    .toBeAttached({ timeout: 15_000 });
  return page.locator('#settingsManagerTabsContent .tab-pane.active');
}

test('?tab=Storage opens the Storage tab at the Basic UI level', async ({ page }) => {
  // Regression: 7976d8b41.  The tab numbers were counted as if every tab
  // were drawn, but Email and MQTT are left out at Basic level, so
  // ?tab=Storage (the link the storage warnings use) opened the tab two
  // places further on.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    await page.goto('/settings.php?tab=Storage');
    await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
    // The control: the tabs before it really are left out at this level.
    await expect(page.locator('#settings-email-tab')).toHaveCount(0);
    await expect(page.locator('#settings-storage-tab')).toHaveClass(/active/);
    await expect(page.locator('#settings-storage')).toHaveClass(/active/);
    await expect(page.locator('#settings-storage')).toContainText('Flash FPP to Another Device', { timeout: 15_000 });
  });
});

test('the Services tab holds the OS services, the local MQTT broker among them', async ({ page }) => {
  // Feature: 6a800d2d3 ("Move Kiosk and OS Services settings to a Services
  // tab").  683dc3cdb declared Service_MQTT_localbroker and put it in the
  // services group, so the broker can be turned on from here (the save and
  // the broker itself: settings-mqtt-broker-service.spec.ts).
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    const pane = await openTab(page, 'Services');
    await expect(page.locator('#settings-services-tab')).toHaveClass(/active/);
    await expect(pane.locator('#Service_rsyncRow')).toBeVisible();
    await expect(pane.locator('#Service_MQTT_localbrokerRow')).toBeVisible();
    await expect(pane.locator('#Service_MQTT_localbroker')).toHaveAttribute('type', 'checkbox');
  });
});

test('on a Pi, the Services tab offers the Touch Display 2 rotation, saved where the kiosk reads it', async ({ page }) => {
  // Feature: 89537656e.  KioskRotate joined the kiosk group, which the
  // Services tab draws on a Raspberry Pi at Advanced level (masqUIPlatform
  // makes this player's pages draw as a Pi's).  start_kiosk.sh reads the
  // saved KioskRotate (scenarios/test_kiosk_script.py).
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    setSettingInFile('masqUIPlatform', 'Raspberry Pi');
    setSettingInFile('KioskRotate', '0');
    const pane = await openTab(page, 'Services');
    const box = pane.locator('#KioskRotate');
    await expect(box).toBeVisible();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/KioskRotate') && r.request().method() === 'PUT');
    await box.check();
    expect((await saved).ok()).toBe(true);
    expect(settingInFile('KioskRotate')).toBe('1');
  });
});

test('date and time formats and the temperature unit are on the Localization tab, not the UI tab', async ({ page }) => {
  // Regression: 6ca434cbf moved DateFormat, TimeFormat and temperatureInF
  // from the UI group to the time group; dff276d71 moved them, with Locale,
  // into a "Regional Settings" group on the same (renamed) tab.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    const ui = await openTab(page, 'UI');
    await expect(ui.locator('#uiLevelRow'), 'the control: the UI tab is drawn').toBeAttached();
    for (const k of ['DateFormat', 'TimeFormat', 'temperatureInF']) await expect(ui.locator(`#${k}Row`)).toHaveCount(0);
    const loc = await openTab(page, 'Localization');
    const regional = loc.locator('h2', { hasText: 'Regional Settings' });
    await expect(regional).toBeVisible();
    for (const k of ['Locale', 'DateFormat', 'TimeFormat', 'temperatureInF']) {
      // Each row is in the table that follows the Regional Settings heading.
      await expect(regional.locator(`xpath=following-sibling::div[contains(@class,"settingsTable")][1]//*[@id="${k}Row"]`)).toHaveCount(1);
    }
  });
});

test('the NTP server is an Advanced setting', async ({ page }) => {
  // Regression: 41936f777.  The NTP server override was shown at Basic level.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    let pane = await openTab(page, 'Localization');
    await expect(pane.locator('#TimeZoneRow'), 'the control: the time settings are drawn').toBeAttached();
    await expect(pane.locator('#ntpServerRow')).toHaveCount(0);
    setSettingInFile('uiLevel', '1');
    pane = await openTab(page, 'Localization');
    await expect(pane.locator('#ntpServerRow')).toBeAttached();
  });
});

test('the File Manager display settings are Advanced, and the scheduler settings are on the Playback tab', async ({ page }) => {
  // Regression: 8858f7025 ("Group settings more logically.  Move some to
  // advanced UI mode").  fileManagerThumbnailSize and fileManagerTableFilter
  // were shown at Basic level.  The scheduler settings, on the System tab,
  // are now an Advanced Scheduler group on the Playback tab, and MultiSync
  // joined the Playback group.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    let pane = await openTab(page, 'UI');
    await expect(pane.locator('#uiLevelRow'), 'the control: the UI tab is drawn').toBeAttached();
    await expect(pane.locator('#fileManagerThumbnailSizeRow')).toHaveCount(0);
    await expect(pane.locator('#fileManagerTableFilterRow')).toHaveCount(0);
    pane = await openTab(page, 'Playback');
    await expect(pane.locator('#MultiSyncEnabledRow')).toBeAttached();
    await expect(pane.locator('#DisableSchedulerRow')).toHaveCount(0);
    setSettingInFile('uiLevel', '1');
    pane = await openTab(page, 'UI');
    await expect(pane.locator('#fileManagerThumbnailSizeRow')).toBeAttached();
    pane = await openTab(page, 'Playback');
    await expect(pane.locator('h2', { hasText: /^Scheduler$/ })).toBeVisible();
    await expect(pane.locator('#DisableSchedulerRow')).toBeVisible();
  });
});

test('a header colour from the longer list is offered and paints the header', async ({ page }) => {
  // Feature: 2027469a0 ("increase number of header UI colors available").
  // Crimson is one of the colours it added.  The receiving end is the header
  // of the next page drawn, which menuHead.inc colours from the setting.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    const pane = await openTab(page, 'UI');
    const select = pane.locator('#backgroundColor');
    await expect(select.locator('option', { hasText: /^Crimson$/ })).toHaveAttribute('value', 'DC143C');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/backgroundColor') && r.request().method() === 'PUT');
    // The setting reloads the page once saved.
    const reloaded = page.waitForEvent('load');
    await select.selectOption('DC143C');
    expect((await saved).ok()).toBe(true);
    expect(settingInFile('backgroundColor')).toBe('DC143C');
    await reloaded;
    await expect(page.locator('.header').first()).toHaveCSS('background-color', 'rgb(220, 20, 60)');
    await page.goto('/index.php');
    await expect(page.locator('.header').first()).toHaveCSS('background-color', 'rgb(220, 20, 60)');
  });
});

test("the UUID override is an Advanced setting, flags a reboot, and is the identity the player reports", async ({ page }) => {
  // Feature: f3f7d8fc1 ("Expose FPP_UUID as advanced mode setting").  It was
  // a Developer-level setting with no reboot flag.  scripts/get_uuid reads it
  // (FPP Connect, stats and MultiSync all take the identity from there) and
  // fppd reads that at start, hence the reboot.
  const UUID = 'fpp-tests-0000-1111-2222-3333'; // the field takes 30
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    setSettingInFile('rebootFlag', '0');
    const pane = await openTab(page, 'System');
    const input = pane.locator('#FPP_UUID');
    await expect(input).toBeVisible();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/FPP_UUID') && r.request().method() === 'PUT');
    await input.fill(UUID);
    await input.press('Enter');
    await input.blur();
    expect((await saved).ok()).toBe(true);
    expect(settingInFile('FPP_UUID')).toBe(UUID);
    await expect.poll(() => settingInFile('rebootFlag'), { message: 'no reboot was flagged' }).toBe('1');
    try {
      expect(inPlayer('sh', '-c', 'rm -f /tmp/fpp_uuid /tmp/fpp_uuid_source; /opt/fpp/scripts/get_uuid').trim()).toBe(UUID);
    } finally {
      inPlayer('sh', '-c', 'rm -f /tmp/fpp_uuid /tmp/fpp_uuid_source');
    }
  });
  inPlayer('sh', '-c', 'rm -f /tmp/fpp_uuid /tmp/fpp_uuid_source');
});
