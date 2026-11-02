import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The PipeWire video output groups page: each display member's Fit / Fill /
// Stretch select has a help icon explaining the three, as a Bootstrap
// tooltip.  The group cards are rebuilt on every render.

test.skip(!container, 'seeds config files inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
  writeFile(`${CONFIG}/pipewire-video-groups.json`, {
    videoOutputGroups: [{ id: 1, name: 'fpp-tests group', enabled: true,
      members: [{ type: 'hdmi', connector: 'HDMI-A-1', scaling: 'fit', region: 'full' }] }],
  });
});
test.afterEach(() => {
  cleanupPipeWire();
  inPlayer('rm', '-f', `${CONFIG}/pipewire-video-groups.json`);
  restoreSettings();
});

test('the scaling help icon explains Fit, Fill and Stretch, and a re-render takes an open tooltip with it', async ({ page }) => {
  // Regression: 9d268e8ce.  The scaling select had no explanation; and the
  // cards are rebuilt wholesale, so a tooltip open at that moment had its
  // popup (parented to <body>) stranded on screen with nothing to close it.
  await page.goto('/pipewire-video.php');
  const icon = page.locator('#groupsContainer img.icon-help').first();
  await expect(icon).toBeVisible({ timeout: 15_000 });
  await icon.hover();
  const tip = page.locator('body > .tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('How the video is scaled onto this display');
  for (const word of ['Fit', 'Fill', 'Stretch']) await expect(tip.locator('b', { hasText: word })).toHaveCount(1);

  // A re-render (here the page's own, as a reload of the groups would do)
  // while the tooltip is open.  The mouse is still over the spot, so the new
  // icon may show a tooltip of its own: it is the old popup that must go.
  const old = await tip.first().elementHandle();
  await page.evaluate(() => (window as any).RenderGroups());
  await expect(page.locator('#groupsContainer img.icon-help').first()).toBeVisible();
  await expect.poll(() => old!.evaluate((e) => e.isConnected), { message: 'the old icon\'s tooltip is left in the page' }).toBe(false);
});
