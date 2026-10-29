import { test, expect } from './fixtures';

// Controls a screen reader can name: each one here had no label, no text
// and no title, so it was announced as just "checkbox" or "button".  The
// accessible name is what assistive technology reads out (Playwright
// computes it the way the browser's accessibility tree does).

test("the status page's playlist controls have names", async ({ page }) => {
  // Regression: b0516eb33 (the Repeat checkbox), 8996bb271 (the remote's
  // volume slider).  The "Repeat:" beside the checkbox is a span, not a
  // label for it.  (8996bb271 also titled #playlistSelect, but Bootstrap's
  // tooltip moves a title out of the way and names only an element with no
  // text of its own, which a select with options has: it has no name.)
  // No status after the page as served (it carries one), so nothing
  // switches the mode back once the test has set it, below.
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route('**/api/system/status**', (route) => route.abort());
  await page.route('**/api/fppd/status**', (route) => route.abort());
  await page.goto('/index.php');
  // Soft, so each commit's half is reported.
  await expect.soft(page.locator('#chkRepeat'), 'b0516eb33').toHaveAccessibleName('Repeat');
  // The control: a control that always had a name.
  await expect(page.locator('#slider')).toHaveAccessibleName('VolumeSlider');

  // The remote's slider shows in remote mode only: the page set up as the
  // status handler does for a remote (fppd's mode 8).
  await page.evaluate(() => (window as any).SetupUIForMode(8));
  await expect(page.locator('#remoteVolumeSlider')).toBeVisible();
  await expect(page.locator('#remoteVolumeSlider'), '8996bb271').toHaveAccessibleName('remoteVolumeSlider');
});

test('a checkbox setting and its help icon have names', async ({ page }) => {
  // Regression: b0516eb33 (the checkbox PrintSettingCheckbox() writes; its
  // description is a separate column, not a label), 1858b4025 (the help
  // icon PrintToolTip() writes had no alt).
  await page.goto('/settings.php');
  const box = page.locator('input[type="checkbox"]#MultiSyncEnabled');
  await expect(box).toBeVisible();
  // Soft, so each commit's half is reported.
  await expect.soft(box, 'b0516eb33').toHaveAccessibleName('MultiSyncEnabled');
  // Regression: fpp f13bb3a6b.  The alt ran the setting's name into the
  // words: "MultiSyncEnabledhelp icon".
  await expect(page.locator('#MultiSyncEnabled_img'), '1858b4025, f13bb3a6b').toHaveAccessibleName('MultiSyncEnabled help icon');
});

test('a form control named only by its title keeps that name, and follows a new title', async ({ page }) => {
  // Regression: fpp 3c69a03a1.  SetupToolTips() hands each title to
  // Bootstrap's tooltip, which takes the attribute away and names only an
  // element with no text of its own; a select's options are text, so
  // #playlistSelect, whose title was its only name, had none.
  await page.goto('/index.php');
  const select = page.locator('#playlistSelect');
  await expect(select).toBeVisible();
  await expect(select).toHaveAccessibleName('playlistSelect');
  // A page that retitles the control and sets the tooltips up again (as
  // pages do after changing their markup) renames it too.
  await page.evaluate(() => {
    document.getElementById('playlistSelect')!.setAttribute('title', 'fpp-tests retitled');
    (window as any).SetupToolTips();
  });
  await expect(select).toHaveAccessibleName('fpp-tests retitled');
  // The control: a control with a label of its own keeps it.
  await expect(page.locator('#chkRepeat')).toHaveAccessibleName('Repeat');
});

test("the footer's FPPD start/stop button is named by what it says", async ({ page }) => {
  // Regression: fpp 9c80e609b.  An aria-label="DaemonControl" (from
  // 9fa9c425b, for the button as served, empty) overrode the "Start FPPD" /
  // "Stop FPPD" fpp.js writes into it: a screen reader heard
  // "DaemonControl".
  await page.goto('/index.php');
  const button = page.locator('#btnDaemonControl');
  await expect(button).toHaveText(/^(Start|Stop) FPPD$/);
  await expect(button).toHaveAccessibleName((await button.textContent())!.trim());
});
