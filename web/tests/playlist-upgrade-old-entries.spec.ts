import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// Playlists saved by older FPP open in the editor converted to today's entries
// (UpgradePlaylist() in fpp.js), and the next Save Playlist writes them so:
// a Branch's compInfo times and branchType, a Dynamic entry's data, the MQTT
// and Volume entries (now commands) and the hidden Overlay Model Text command
// (now Overlay Model Effect's Text).  Get one wrong and a show that ran last
// year stops doing what it did after its playlist is opened and saved.

const NAME = 'fpp-tests-upgrade-entries';

async function store(request: APIRequestContext, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 3, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
}

async function openAndSave(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
  return (await (await page.request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist as any[];
}

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

test('old Branch and Dynamic entries are saved in the fields that replaced theirs', async ({ page }) => {
  await store(page.request, [
    { type: 'branch', enabled: 1, playOnce: 0, branchType: 'clockTime',
      compInfo: { startHour: 7, startMinute: 5, startSecond: 0, endHour: 23, endMinute: 0, endSecond: 9 },
      trueNextBranchType: 'Index', trueNextSection: '', trueNextItem: 1, falseNextBranchType: 'Index', falseNextSection: '', falseNextItem: 1 },
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'file', data: 'fpp-tests-dyn.json', drainQueue: 0 },
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'plugin', data: 'fpp-tests-plugin', drainQueue: 0 },
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'url', data: 'http://fpp-tests.invalid/pl.json', drainQueue: 0 },
  ]);
  const [branch, file, plugin, url] = await openAndSave(page);
  expect(branch).toMatchObject({ type: 'branch', startTime: '07:05:00', endTime: '23:00:09', branchTest: 'clockTime' });
  expect(branch).not.toHaveProperty('compInfo');
  expect(branch).not.toHaveProperty('branchType');
  expect(file).toMatchObject({ subType: 'file', dataFile: 'fpp-tests-dyn.json' });
  expect(plugin).toMatchObject({ subType: 'plugin', pluginName: 'fpp-tests-plugin' });
  expect(url).toMatchObject({ subType: 'url', url: 'http://fpp-tests.invalid/pl.json' });
});

test('MQTT and Volume entries are saved as the commands that replaced them', async ({ page }) => {
  await store(page.request, [
    { type: 'mqtt', enabled: 1, playOnce: 0, topic: 'fpp-tests/topic', message: 'on' },
    { type: 'volume', enabled: 1, playOnce: 0, volume: -5 },
  ]);
  const [mqtt, volume] = await openAndSave(page);
  expect(mqtt).toMatchObject({ type: 'command', command: 'MQTT', args: ['fpp-tests/topic', 'on'] });
  expect(volume).toMatchObject({ type: 'command', command: 'Volume Adjust' });
  expect(String(volume.args[0])).toBe('-5');
});

// Overlay Model Text's args: Model, Color, Font, FontSize, AntiAlias,
// Position, Speed, AutoEnable, Text.
const TEXT_ARGS = ['Tree', '#00FF00', 'Helvetica', '24', 'true', 'Right to Left', '20', 'true', 'Merry Christmas'];

test('an Overlay Model Text command is saved as Overlay Model Effect Text with its settings', async ({ page }) => {
  await store(page.request, [{ type: 'command', enabled: 1, playOnce: 0, command: 'Overlay Model Text', multisyncCommand: true, args: TEXT_ARGS }]);
  const [e] = await openAndSave(page);
  expect(e.command).toBe('Overlay Model Effect');
  // Not sent to the other players (it is run on each from its own playlist).
  expect(e.multisyncCommand).toBeFalsy();
  expect(e.args).toEqual(['Tree', 'Enabled', 'Text', '#00FF00', 'Helvetica', '24', 'true', 'Right to Left', '20', '0', 'Merry Christmas']);
});

// fppd runs an unconverted entry with its own AutoEnable (TextOverlayCommand
// passes args[7] on), so a text entry that left its model alone keeps doing
// so; the editor's conversion keeps that AutoEnable too.
test("an Overlay Model Text command that did not auto-enable its model still doesn't", async ({ page }) => {
  const args = [...TEXT_ARGS];
  args[7] = 'false';
  await store(page.request, [{ type: 'command', enabled: 1, playOnce: 0, command: 'Overlay Model Text', multisyncCommand: false, args }]);
  const [e] = await openAndSave(page);
  expect(e.command).toBe('Overlay Model Effect');
  expect(e.args[10]).toBe('Merry Christmas');
  expect(e.args[1]).toBe('False');
});
