import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { CONFIG, exists, readFile, writeFile } from './pw-helpers';
import { settingInFile, setSettingInFile } from './settings-file';

// The Video Input Sources page's editor (pipewire-video-inputs.php): Add
// Source, each type's fields, the resolution presets, Delete, and Save /
// Save & Apply.  The receiving end is the saved config
// (pipewire-video-input-sources.json) and, for Apply, the generated one fppd
// reads (-gen.json).  Both are put back after each test.

test.skip(!container, 'saves the sources inside the run-web.sh container');

const FILE = `${CONFIG}/pipewire-video-input-sources.json`;
const GEN = `${CONFIG}/pipewire-video-input-sources-gen.json`;
const KEYS = ['MediaBackend', 'AudioBackend'];

let keys: (string | undefined)[] = [];
let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  keys = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
  saved = {};
  for (const f of [FILE, GEN]) saved[f] = exists(f) ? readFile(f) : null;
  inPlayer('rm', '-f', FILE, GEN);
});
let reapply = false;
test.afterEach(async ({ request }) => {
  for (const [f, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', f);
    else inPlayer('sh', '-c', `echo '${Buffer.from(content).toString('base64')}' | base64 -d > '${f}'`);
  }
  KEYS.forEach((k, i) => setSettingInFile(k, keys[i]));
  // After an Apply, fppd is put back on the player's own sources.
  if (reapply) await request.post('/api/pipewire/video/input-sources/apply', { data: {} });
  reapply = false;
});

function savedSources(): any[] {
  return exists(FILE) ? JSON.parse(readFile(FILE)).videoInputSources : [];
}

async function openPage(page: Page) {
  await page.goto('/pipewire-video-inputs.php');
  await expect(page.locator('#pipewireStatus button', { hasText: 'Add Source' })).toBeEnabled({ timeout: 15_000 });
}

const card = (page: Page, n = 0) => page.locator('.source-card').nth(n);
const typeSelect = (page: Page, n = 0) => card(page, n).locator('select[onchange^="UpdateSourceType"]');
const saveButton = (page: Page) => page.locator('#pipewireStatus button', { hasText: /^\s*Save\s*$/ });

async function saved200(page: Page, click: () => Promise<void>) {
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/pipewire/video/input-sources') && r.request().method() === 'POST');
  await click();
  expect((await posted).status()).toBe(200);
}

test('an added test pattern is saved with its name, pattern, resolution and frame rate, and reloads as saved', async ({ page }) => {
  await openPage(page);
  await page.locator('#noSourcesMsg button', { hasText: 'Add First Source' }).click();
  await expect(page.locator('#unsavedChangesBanner')).toBeVisible();
  await expect(page.locator('.source-card')).toHaveCount(1);

  await card(page).locator('.source-name-input').fill('Front Cam');
  await card(page).locator('.source-name-input').press('Tab');
  await expect(card(page).locator('.pipewire-badge')).toHaveText('fpp_video_src_1_front_cam');
  await card(page).locator('select[onchange*="\'pattern\'"]').selectOption('ball');
  await card(page).locator('select[onchange^="ApplyResolutionPreset"]').selectOption('1280x720');
  await expect(page.locator('#resW_0')).toHaveValue('1280');
  await expect(page.locator('#resH_0')).toHaveValue('720');
  await card(page).locator('input[onchange*="\'framerate\'"]').fill('25');
  await card(page).locator('input[onchange*="\'framerate\'"]').press('Tab');

  await saved200(page, () => saveButton(page).click());
  await expect(page.locator('#unsavedChangesBanner')).toHaveCount(0);
  expect(savedSources()).toEqual([expect.objectContaining({
    id: 1, name: 'Front Cam', enabled: true, type: 'videotestsrc', pattern: 'ball',
    width: 1280, height: 720, framerate: 25, pipeWireNodeName: 'fpp_video_src_1_front_cam',
  })]);

  await openPage(page);
  await expect(card(page).locator('.source-name-input')).toHaveValue('Front Cam');
  await expect(card(page).locator('select[onchange*="\'pattern\'"]')).toHaveValue('ball');
  await expect(card(page).locator('select[onchange^="ApplyResolutionPreset"]')).toHaveValue('1280x720');

  // A size no preset has is shown as Custom.
  await page.locator('#resW_0').fill('1000');
  await page.locator('#resW_0').press('Tab');
  await expect(card(page).locator('select[onchange^="ApplyResolutionPreset"]')).toHaveValue('0x0');
  await saved200(page, () => saveButton(page).click());
  expect(savedSources()[0]).toMatchObject({ width: 1000, height: 720 });
});

test("changing a source's type saves that type's fields and none of the old type's", async ({ page }) => {
  await openPage(page);
  await page.locator('#pipewireStatus button', { hasText: 'Add Source' }).click();

  await typeSelect(page).selectOption('rtpsrc');
  await expect(card(page).locator('input[onchange*="\'port\'"]')).toHaveValue('5004');
  await card(page).locator('input[onchange*="\'port\'"]').fill('6000');
  await card(page).locator('input[onchange*="\'port\'"]').press('Tab');
  await card(page).locator('select[onchange*="\'encoding\'"]').selectOption('MP2T');
  await card(page).locator('input[onchange*="\'multicastGroup\'"]').fill('239.1.1.1');
  await card(page).locator('input[onchange*="\'multicastGroup\'"]').press('Tab');
  await saved200(page, () => saveButton(page).click());
  let s = savedSources()[0];
  expect(s).toMatchObject({ type: 'rtpsrc', port: 6000, encoding: 'MP2T', multicastGroup: '239.1.1.1' });
  expect(s).not.toHaveProperty('pattern');

  await typeSelect(page).selectOption('rtspsrc');
  await card(page).locator('input[onchange*="\'uri\'"]').fill('rtsp://cam.fpp-tests.invalid:554/live');
  await card(page).locator('input[onchange*="\'uri\'"]').press('Tab');
  await card(page).locator('input[onchange*="\'latency\'"]').fill('500');
  await card(page).locator('input[onchange*="\'latency\'"]').press('Tab');
  await card(page).locator('input[onchange^="ToggleAudioEnabled"]').check();
  await saved200(page, () => saveButton(page).click());
  s = savedSources()[0];
  expect(s).toMatchObject({ type: 'rtspsrc', uri: 'rtsp://cam.fpp-tests.invalid:554/live', latency: 500, audioEnabled: true });
  for (const gone of ['port', 'encoding', 'multicastGroup', 'pattern']) expect(s).not.toHaveProperty(gone);

  await typeSelect(page).selectOption('urisrc');
  await card(page).locator('input[onchange*="\'bufferSec\'"]').fill('7.5');
  await card(page).locator('input[onchange*="\'bufferSec\'"]').press('Tab');
  await saved200(page, () => saveButton(page).click());
  s = savedSources()[0];
  expect(s).toMatchObject({ type: 'urisrc', uri: '', bufferSec: 7.5 });
  for (const gone of ['latency', 'audioEnabled']) expect(s).not.toHaveProperty(gone);
});

test('deleting the last source keeps Save on screen, and saving it leaves no sources', async ({ page }) => {
  writeFile(FILE, { videoInputSources: [{ id: 4, name: 'Old Cam', enabled: true, type: 'videotestsrc', pattern: 'smpte', width: 320, height: 240, framerate: 10 }] });
  await openPage(page);
  await expect(page.locator('.source-card')).toHaveCount(1);

  page.once('dialog', (d) => { expect(d.message()).toBe('Delete "Old Cam"?'); d.dismiss(); });
  await card(page).locator('button[onclick^="DeleteSource"]').click();
  await expect(page.locator('.source-card'), 'Cancel on the confirm deleted it').toHaveCount(1);

  page.once('dialog', (d) => d.accept());
  await card(page).locator('button[onclick^="DeleteSource"]').click();
  await expect(page.locator('.source-card')).toHaveCount(0);
  await expect(page.locator('#unsavedChangesBanner')).toBeVisible();
  const bottomSave = page.locator('#bottomToolbar button', { hasText: /^\s*Save\s*$/ });
  await expect(bottomSave).toBeVisible();
  expect(savedSources(), 'deleted before Save').toHaveLength(1);
  await saved200(page, () => bottomSave.click());
  expect(savedSources()).toEqual([]);

  // A source added after a reload gets the next id, not one reused.
  writeFile(FILE, { videoInputSources: [{ id: 4, name: 'Old Cam', enabled: true, type: 'videotestsrc' }] });
  await openPage(page);
  await page.locator('#pipewireStatus button', { hasText: 'Add Source' }).click();
  await saved200(page, () => saveButton(page).click());
  expect(savedSources().map((x) => x.id)).toEqual([4, 5]);
});

test('a refused save says why and leaves the change unsaved', async ({ page }) => {
  await openPage(page);
  await page.locator('#pipewireStatus button', { hasText: 'Add Source' }).click();
  await page.route('**/api/pipewire/video/input-sources', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { status: 'ERROR', message: 'fpp-tests refusal' } })
    : route.continue());
  await saveButton(page).click();
  await expect(page.locator('.jGrowl-message', { hasText: 'Failed to save: fpp-tests refusal' })).toBeVisible();
  await expect(page.locator('#unsavedChangesBanner')).toBeVisible();
  expect(exists(FILE)).toBe(false);
});

test('Save & Apply writes the config fppd reads, without the sources that cannot run', async ({ page }) => {
  await openPage(page);
  // A disabled test pattern (nothing for fppd to start), and an RTSP source
  // with no URL.
  await page.locator('#pipewireStatus button', { hasText: 'Add Source' }).click();
  await card(page).locator('input[onchange^="ToggleSourceEnabled"]').uncheck();
  await page.locator('#pipewireStatus button', { hasText: 'Add Source' }).click();
  await typeSelect(page, 1).selectOption('rtspsrc');
  await card(page, 1).locator('input[onchange^="ToggleSourceEnabled"]').uncheck();

  reapply = true;
  const applied = page.waitForResponse((r) => r.url().endsWith('/input-sources/apply'));
  await page.locator('#pipewireStatus button', { hasText: 'Save & Apply' }).click();
  expect((await applied).status()).toBe(200);
  await expect(page.locator('.jGrowl-message', { hasText: 'Video input sources applied' })).toBeVisible();
  await expect(page.locator('#applyOverlay')).toBeHidden();

  expect(savedSources()).toHaveLength(2);
  const gen = JSON.parse(readFile(GEN));
  const list = Array.isArray(gen) ? gen : (gen.sources ?? gen.videoInputSources);
  expect(list.map((x: any) => x.name)).toEqual(['Video Source 1']);
  expect(list[0]).toMatchObject({ type: 'videotestsrc', enabled: false, pipeWireNodeName: 'fpp_video_src_1_video_source_1' });
});
