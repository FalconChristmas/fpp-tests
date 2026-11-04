import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { keepingFile } from './privacy-helpers';

// Selecting several rows of a table page with Ctrl-click and pressing Delete
// removes all of them, and Save writes what is left.

test.skip(!container, "changes the player's config files");

const MEDIA = '/home/fpp/media';

const preset = (name: string) => ({
  name, command: 'Set Variable', args: ['fppTestsMulti', 'Value', name, '1', '0', '100', ''],
  multisyncCommand: false, multisyncHosts: '', presetSlot: 0,
});

test('Ctrl-clicking two command presets and pressing Delete leaves the third', async ({ page, request }) => {
  // 6203f60df: the Command Presets Delete button.
  await keepingFile(`${MEDIA}/config/commandPresets.json`, async () => {
    const put = await request.post('/api/configfile/commandPresets.json', {
      data: Buffer.from(JSON.stringify({ commands: ['fpp-a', 'fpp-b', 'fpp-c'].map(preset) })) });
    expect(put.ok(), await put.text()).toBe(true);
    await page.goto('/commandPresets.php');
    const rows = page.locator('#tblCommandsBody > tr');
    await expect(rows).toHaveCount(3);
    await rows.nth(0).locator('td').first().click();
    await rows.nth(2).locator('td').first().click({ modifiers: ['Control'] });
    await expect(page.locator('#tblCommandsBody > tr.selectedEntry')).toHaveCount(2);
    await page.locator('.largeonly button[value="Delete"]:visible').first().click();
    await expect(rows).toHaveCount(1);
    await page.locator('button[value="Save"]:visible').first().click();
    await expect.poll(async () => {
      const t = await (await request.get('/api/configfile/commandPresets.json')).text();
      return JSON.parse(t).commands.map((c: any) => c.name);
    }, { timeout: 10_000 }).toEqual(['fpp-b']);
  });
});

test('Ctrl-clicking two pixel overlay models and pressing Delete leaves the third', async ({ page, request }) => {
  // 02ec0c083 (#972): multi-select delete on the Pixel Overlay Models page.
  // The player starts with one model ("fpp-tests-matrix"); two are added by hand.
  await keepingFile(`${MEDIA}/config/model-overlays.json`, async () => {
    await page.goto('/pixeloverlaymodels.php');
    const names = page.locator('#channelMemMaps tbody tr input.blk');
    await expect(names).toHaveCount(1);
    for (const n of [2, 3]) {
      await page.locator('button[value=Add]').click();
      await page.locator('#AddPixelOverlayModel').getByRole('button', { name: 'Channel' }).click();
      await expect(names).toHaveCount(n);
    }
    const rows = page.locator('#channelMemMaps tbody tr');
    await rows.nth(1).locator('td').first().click();
    await rows.nth(2).locator('td').first().click({ modifiers: ['Control'] });
    await expect(page.locator('#channelMemMaps tbody tr.selectedEntry')).toHaveCount(2);
    await page.locator('#btnDelete').click();
    await expect(names).toHaveCount(1);
    await expect(names.first()).toHaveValue('fpp-tests-matrix');
  });
});
