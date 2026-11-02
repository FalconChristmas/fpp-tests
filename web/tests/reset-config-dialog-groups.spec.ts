import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: c2d1e7701. The Reset FPP Config dialog laid its checkboxes out
// in table-like rows whose three columns did not follow their headings (Logs,
// Backups and Caches sat in the column headed "FPP", OS files under "Plugins"'
// column) and the text beside a box was not a label. Each area is now listed
// under the heading of its group, and its text is the checkbox's label.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

const GROUPS: Record<string, string[]> = {
  Configuration: ['config', 'network', 'channeloutputs', 'eeprom', 'settings', 'schedule'],
  Content: ['sequences', 'media', 'effects', 'playlists'],
  Plugins: ['plugins', 'pluginConfigs'],
  'OS / System Files': ['logs', 'backups', 'uploads', 'caches', 'scripts', 'user', 'audiobackend'],
};

test('Reset FPP Config lists each area under its group and the text toggles the box', async ({ page }) => {
  setSettingInFile('uiLevel', '1');
  await page.goto('/settings.php#settings-system');
  await page.click('input[value="Reset FPP Config"]');
  const dialog = page.locator('#resetFPPDialog');
  await expect(dialog).toBeVisible();
  await page.click('#resetFPPDialog #noneButton');

  // The group a box sits under: the closest heading above it in its column.
  const heads = await dialog.locator('.settingsGroupTable b').evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent || '').trim(), r: e.getBoundingClientRect().toJSON() })));
  const found: Record<string, string[]> = {};
  for (const id of Object.values(GROUPS).flat()) {
    const box = await dialog.locator(`#rc_${id}`).boundingBox();
    expect(box, `rc_${id} is not shown`).not.toBeNull();
    const above = heads.filter((h) => h.r.left <= box!.x + 1 && h.r.right >= box!.x - 400 && h.r.top < box!.y &&
      Math.abs(h.r.left - box!.x) < 60)
      .sort((a, b) => b.r.top - a.r.top)[0];
    (found[above ? above.text : '(none)'] ||= []).push(id);
  }
  expect(found).toEqual(GROUPS);

  // Nothing overlaps and nothing spills out of the dialog.
  const dlg = (await dialog.locator('.modal-dialog').boundingBox())!;
  const rows = await dialog.locator('.settingsGroupTable input[type=checkbox]').evaluateAll((els) =>
    els.map((e) => (e.parentElement as HTMLElement).getBoundingClientRect().toJSON()));
  for (const [i, a] of rows.entries()) {
    expect(a.right, 'a row runs out of the dialog').toBeLessThanOrEqual(dlg.x + dlg.width);
    for (const b of rows.slice(i + 1)) {
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap, 'two areas overlap').toBe(false);
    }
  }

  // The area's text is its label.
  for (const id of ['config', 'audiobackend']) {
    await dialog.locator(`label[for="rc_${id}"]`).click();
    await expect(dialog.locator(`#rc_${id}`)).toBeChecked();
  }
});
