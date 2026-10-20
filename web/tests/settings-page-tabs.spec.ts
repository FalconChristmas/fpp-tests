import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Settings page: which tab a link opens, its search box, and the live
// parts of its tabs.

// The tab bar is built, and some tab's pane is active with its settings in it.
async function settingsLoaded(page: Page) {
  await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(page.locator('#settingsManagerTabsContent .tab-pane.active .settingsTable, #settingsManagerTabsContent .tab-pane.active [id$="Row"]').first())
    .toBeAttached({ timeout: 15_000 });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

// Regression: 17ca0f84d ("unknown ?tab= values no longer break the page"). An
// unknown ?tab= value was printed into a <script> as it was: settings.php
// ?tab=Bogus threw a ReferenceError and left every tab on "Loading
// settings...", and ?tab=1;alert(1) ran (a reflected XSS). ?tab[]=x made
// array_key_exists() throw and cut the page off.
test('an unknown ?tab= value opens Playback and runs nothing', async ({ page, request }) => {
  const html = await (await request.get('/settings.php?tab=' + encodeURIComponent('1;alert(1)'))).text();
  expect(html).toMatch(/var activeTabNumber = 0;/);
  expect(html, 'the tab value was printed into the script').not.toContain('1;alert(1)');

  const truncated = await (await request.get('/settings.php?tab[]=x')).text();
  expect(truncated, 'the page was cut off').toContain('</html>');
  expect(truncated).toMatch(/var activeTabNumber = 0;/);

  const errors = watchErrors(page);
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss(); });
  for (const tab of ['Bogus', '1;alert(1)']) {
    await page.goto('/settings.php?tab=' + encodeURIComponent(tab));
    await settingsLoaded(page);
    await expect(page.locator('#settings-playback-tab')).toHaveClass(/active/);
    await expect(page.locator('#settingsTabsLoading')).toHaveCount(0);
  }
  expect(errors, errors.join('\n')).toEqual([]);
  expect(dialogs, 'the ?tab= value ran as script').toBe(0);
});

// Regression: 32272055e ("don't force the first tab when the page already
// marked one active"). The common page-load code showed the first tab of every
// tab list when the URL had no hash, so settings.php?tab=MQTT (the links the
// help and PipeWire pages use) always landed on Playback.
test('settings.php?tab=<name> opens that tab', async ({ page }) => {
  await page.goto('/settings.php?tab=MQTT');
  await settingsLoaded(page);
  await expect(page.locator('#settings-mqtt-tab')).toHaveClass(/active/);
  await expect(page.locator('#settings-mqtt')).toHaveClass(/active/);
  await expect(page.locator('#settings-playback-tab')).not.toHaveClass(/active/);
});

// Feature: 3da0cd5f0 (a search box that filters settings across every tab).
// Regression: a8a2854e3 ("a past search no longer hijacks later visits to the
// page"): the term was kept in sessionStorage on every change and restored on
// every load, so after one search every later visit to Settings in that tab
// opened in the stacked search view with the tab bar hidden.
test('a search finds settings on other tabs, and is gone on the next visit', async ({ page }) => {
  await page.goto('/settings.php');
  await settingsLoaded(page);
  const row = page.locator('#LogLevel_ChannelOutRow');
  await page.locator('#settingsSearch').fill('LogLevel_ChannelOut');
  // A setting from the Logging tab, shown under its tab's heading.
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.settingsSearchTabHeading', { hasText: 'Logging' })).toBeVisible();
  await expect(page.locator('#settingsManagerTabs')).toBeHidden();
  await page.locator('#settingsSearch').fill('');
  await expect(page.locator('#settingsManagerTabs')).toBeVisible();
  await expect(page.locator('.settingsSearchTabHeading')).toHaveCount(0);

  // A search left in the box, then a later visit in the same browser tab.
  await page.locator('#settingsSearch').fill('LogLevel_ChannelOut');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.goto('/settings.php?tab=UI');
  await settingsLoaded(page);
  await expect(page.locator('#settingsSearch')).toHaveValue('');
  await expect(page.locator('#settingsManagerTabs'), 'the later visit opened in the search view').toBeVisible();
  await expect(page.locator('#settings-ui-tab')).toHaveClass(/active/);
});

// Regression: f302213e8 ("restore the live "Current System Time" clock, dead
// since Bootstrap 5"). The tab check looked for .active on the <li>, which
// Bootstrap 5 never sets, so the clock never ran.
test('the Localization tab shows a running clock', async ({ page }) => {
  await page.goto('/settings.php?tab=Localization');
  await settingsLoaded(page);
  const clock = page.locator('#currentTime');
  await expect(clock).not.toHaveText('', { timeout: 10_000 });
  const first = await clock.textContent();
  await expect(clock, 'the clock did not move').not.toHaveText(first!, { timeout: 5_000 });
});

// Regression: 4f42a41c5 ("Save UI Password button visibility on settings-ui
// tab", #2879). The button stayed on screen with "No Password" chosen, while
// the fields it saves were hidden.
test('the Save UI Password button shows and hides with the password fields', async ({ page }) => {
  await page.goto('/settings.php?tab=UI');
  await settingsLoaded(page);
  const select = page.locator('#passwordEnable');
  const button = page.locator('#saveUIPasswordBtn');
  await expect(select).toHaveValue('0');
  await expect(button, 'the button shows with No Password chosen').toBeHidden();
  // Choosing a password only stages it; nothing is applied until the button.
  await select.selectOption('1');
  await expect(page.locator('#password')).toBeVisible();
  await expect(button).toBeVisible();
  await select.selectOption('0');
  await expect(page.locator('#password')).toBeHidden();
  await expect(button, 'the button stayed with No Password chosen').toBeHidden();
});

// Regression: 9765f3431. PipeWireRTSPOutputs was declared but in no setting
// group, and only grouped settings are drawn, so its button appeared nowhere.
test('the RTSP video outputs button is on the Audio/Video tab', async ({ request }) => {
  const html = await (await request.get('/settings-av.php')).text();
  // The control: the tab's own groups are drawn.
  expect(html).toContain('PipeWireVideoOutputsRow');
  expect(html, 'the RTSP outputs button is not drawn').toContain('PipeWireRTSPOutputsRow');
});
