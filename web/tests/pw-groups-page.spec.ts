import { test, expect } from './fixtures';
import { container } from './container';
import { CONFIG, cleanupPipeWire, fakeSoundCards, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The PipeWire audio output groups and input mixing pages themselves: what
// they offer and show. The groups are written into the config files the
// pages read back through /api/pipewire/audio/*, and the cards are fake
// /proc/asound entries (fakeSoundCards), so the cards API answers from them.

test.skip(!container, 'seeds config files inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  // The pages edit groups only in Advanced (Full PipeWire) mode.
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(() => {
  cleanupPipeWire();
  restoreSettings();
});

const nameInputs = (page: import('@playwright/test').Page) => page.locator('.group-name-input');

test('new output groups are numbered 1, 2, ...', async ({ page }) => {
  // Regression: 01cc87200 ("fix new output group naming"). The name was
  // "Audio Group " + length + 1, string concatenation: the first new group
  // was "Audio Group 01" and the second "Audio Group 11".
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, { groups: [] });
  await page.goto('/pipewire-audio.php');
  const add = page.getByRole('button', { name: 'Add Group' }).first();
  // Enabled once the saved groups are in (c60cef80c; see
  // pw-groups-load-window.spec.ts), which the click waits for.
  await expect(add).toBeEnabled({ timeout: 15_000 });
  await add.click();
  await expect(nameInputs(page)).toHaveCount(1);
  await add.click();
  await expect(nameInputs(page)).toHaveCount(2);
  const names = await nameInputs(page).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(names).toEqual(['Audio Group 1', 'Audio Group 2']);
});

test("a card already in an output group is not offered to the group's other members", async ({ page }) => {
  // Regression: 538964534 ("fix output groups to only allow soundcard entry
  // once"). Every member's card list offered every card, so one card could
  // be put in a group twice.
  fakeSoundCards([{ id: 'A' }, { id: 'B' }]);
  // Each with a playback device, which is what the cards API lists.
  writeFile('/tmp/fpp-tests-fakeasound/pcm', '00-00: USB Audio : USB Audio : playback 1\n01-00: USB Audio : USB Audio : playback 1\n');
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Both', enabled: true, channels: 2, members: [{ cardId: 'A', channels: 2 }] }],
  });
  await page.goto('/pipewire-audio.php');
  const firstCard = page.locator('select[onchange^="UpdateMemberCard(0,0"]');
  // The control: the cards API listed both cards.
  await expect(firstCard.locator('option[value="A"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(firstCard).toHaveValue('A');
  await page.locator('button[onclick="AddMember(0)"]').click();
  const second = page.locator('select[onchange^="UpdateMemberCard(0,1"]');
  await expect(second.locator('option[value="B"]')).toHaveCount(1);
  await expect(second.locator('option[value="A"]'), 'card A is offered to a second member').toHaveCount(0);
});

test('the Routing Matrix opens over the input mixing page, with the groups in it', async ({ page }) => {
  // Feature: c82eb1008 ("implement Routing Matrix modal"). The input mixing
  // page's Routing Matrix button left the page for pipewire-routing-matrix.php;
  // it now opens the matrix in a dialog over it (?modal=1, without the site
  // menu), rows the input groups and columns the output groups.
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'fpp-tests Out', enabled: true, channels: 2, members: [] }],
  });
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'fpp-tests Bus', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1', name: 'Media' }] }],
  });
  await page.goto('/pipewire-input-mixing.php');
  const button = page.getByRole('link', { name: 'Routing Matrix', exact: true });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  await expect(page, 'the button left the page').toHaveURL(/pipewire-input-mixing\.php/);
  await expect(page.locator('#routingMatrixModal')).toBeVisible();
  await expect(page.locator('#routingMatrixFrame')).toHaveAttribute('src', /pipewire-routing-matrix\.php\?modal=1/);
  const frame = page.frameLocator('#routingMatrixFrame');
  await expect(frame.locator('table')).toContainText('fpp-tests Bus', { timeout: 15_000 });
  await expect(frame.locator('table')).toContainText('fpp-tests Out');
  await expect(frame.locator('#bodyWrapper')).toHaveCount(0);
});
