import { test, expect } from './fixtures';
import type { Page, Request } from '@playwright/test';
import { container, inPlayer } from './container';
import { CONFIG, exists, readFile, writeFile } from './pw-helpers';
import { BACKUPS, settingInFile, setSettingInFile } from './settings-file';

// The Audio Input Mixing page's editor (pipewire-input-mixing.php): input
// groups, their members (fppd stream, ALSA capture, PipeWire source), channel
// mapping, output routing, live mute/volume, Save and Save & Apply.
//
// Save is real: the receiving end is pipewire-input-groups.json (put back
// after each test, with the config backup each save makes removed).  The
// device lists are served by the test (the container has no capture cards
// or output groups), and so are the live volume and apply calls, whose
// server side is in pw-input-member-volume-refusals.spec.ts and
// pw-input-groups-conf.spec.ts.

test.skip(!container, 'saves the input groups inside the run-web.sh container');

const FILE = `${CONFIG}/pipewire-input-groups.json`;
const KEYS = ['MediaBackend', 'AudioBackend'];
const listBackups = () => inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && cd ${BACKUPS} && find . -type f | sort`);

const MIC = { cardId: 'hw:7', name: 'alsa_input.fpp-tests-mic', description: 'USB Mic', nick: 'Mic', channels: 1, sampleRate: 48000, state: 'idle' };
const LINE = { cardId: 'hw:8', name: 'alsa_input.fpp-tests-line', description: 'Line In', channels: 2, sampleRate: 48000, state: 'running' };
const YARD = { id: 3, name: 'Yard', enabled: true };
const LTC = { nodeName: 'fpp_tests_ltc', name: 'LTC', plugin: 'smpte', channels: 1, sampleRate: 48000 };

let keys: (string | undefined)[] = [];
let saved: string | null = null;
let backups = '';
test.beforeEach(() => {
  keys = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
  saved = exists(FILE) ? readFile(FILE) : null;
  inPlayer('rm', '-f', FILE);
  backups = listBackups();
});
test.afterEach(() => {
  if (saved === null) inPlayer('rm', '-f', FILE);
  else inPlayer('sh', '-c', `echo '${Buffer.from(saved).toString('base64')}' | base64 -d > '${FILE}'`);
  KEYS.forEach((k, i) => setSettingInFile(k, keys[i]));
  // The backup a save starts may still be being written.
  inPlayer('sleep', '1');
  const had = new Set(backups.split('\n'));
  for (const f of listBackups().split('\n').filter((l) => l && !had.has(l))) inPlayer('rm', '-f', `${BACKUPS}/${f}`);
});

function savedGroups(): any[] {
  return exists(FILE) ? JSON.parse(readFile(FILE)).inputGroups : [];
}

// Live calls the page makes, captured and answered here.
type Live = { volume: any[]; apply: number };
async function openPage(page: Page, o: { applyStatus?: number } = {}): Promise<Live> {
  const live: Live = { volume: [], apply: 0 };
  await page.route('**/api/pipewire/audio/sources', (r) => r.fulfill({ json: [MIC, LINE] }));
  await page.route('**/api/pipewire/audio/groups', (r) => r.fulfill({ json: { groups: [YARD, { id: 4, name: 'Off', enabled: false }] } }));
  await page.route('**/api/pipewire/audio/plugin-sources', (r) => r.fulfill({ json: { sources: [LTC] } }));
  await page.route('**/api/pipewire/audio/input-groups/volume', (r) => {
    live.volume.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ json: { status: 'OK' } });
  });
  await page.route('**/api/pipewire/audio/input-groups/apply', (r) => {
    live.apply++;
    return o.applyStatus
      ? r.fulfill({ status: o.applyStatus, json: { status: 'ERROR', message: 'fpp-tests apply refusal' } })
      : r.fulfill({ json: { status: 'OK', message: 'fpp-tests applied' } });
  });
  await page.goto('/pipewire-input-mixing.php');
  await expect(page.locator('button[onclick="AddInputGroup()"]').first()).toBeEnabled({ timeout: 15_000 });
  return live;
}

const group = (page: Page, n = 0) => page.locator('.ig-card').nth(n);
const member = (page: Page, g = 0, m = 0) => group(page, g).locator('.member-table tbody tr').nth(m);
const typeOf = (page: Page, g = 0, m = 0) => member(page, g, m).locator('select[onchange*="\'type\'"]');
const mapping = (page: Page, g = 0, m = 0) => member(page, g, m).locator('select[onchange^="UpdateChannelMapping"]');
const channels = (page: Page, g = 0) => group(page, g).locator('select[onchange*="\'channels\'"]');

async function save(page: Page) {
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/pipewire/audio/input-groups') && r.request().method() === 'POST');
  await page.locator('button[onclick="SaveInputGroups()"]').first().click();
  expect((await posted).status()).toBe(200);
  await expect(page.locator('.jGrowl-message', { hasText: 'Input groups saved.' })).toBeVisible();
}

const MONO_TO_LR = { sourceChannels: ['MONO'], groupChannels: ['FL', 'FR'] };

test('a new group with a mono mic mapped to both sides and routed to an output group is saved as edited', async ({ page }) => {
  await openPage(page);
  await page.locator('button[onclick="AddInputGroup()"]').first().click();
  await expect(page.locator('.ig-card')).toHaveCount(1);
  await expect(typeOf(page)).toHaveValue('fppd_stream');

  await group(page).locator('.ig-name-input').fill('Stage');
  await group(page).locator('.ig-name-input').press('Tab');
  await group(page).locator('button[onclick^="AddMember"]').click();
  await expect(typeOf(page, 0, 1)).toHaveValue('capture');
  await member(page, 0, 1).locator('select[onchange^="SelectCaptureDevice"]').selectOption('hw:7');
  // The name is filled from the device, and a mono source into a stereo
  // group is offered a mapping.
  await expect(member(page, 0, 1).locator('input[onchange*="\'name\'"]')).toHaveValue('Mic');
  await expect(member(page, 0, 1).locator('.source-state-badge')).toHaveText('idle');
  await mapping(page, 0, 1).selectOption({ label: 'Mono → Left+Right' });

  // Only enabled output groups are offered.
  const outputs = group(page).locator('.output-routing .form-check');
  await expect(outputs).toHaveCount(1);
  await outputs.locator('input').check();

  await save(page);
  const [g] = savedGroups();
  expect(g).toMatchObject({ id: 1, name: 'Stage', enabled: true, channels: 2, outputs: [3] });
  expect(g.members).toEqual([
    expect.objectContaining({ type: 'fppd_stream', sourceId: 'fppd_stream_1' }),
    expect.objectContaining({ type: 'capture', cardId: 'hw:7', nodeName: MIC.name, name: 'Mic', channelMapping: MONO_TO_LR }),
  ]);

  // Reloaded, the page shows what was saved.
  await openPage(page);
  await expect(group(page).locator('.ig-name-input')).toHaveValue('Stage');
  await expect(member(page, 0, 1).locator('select[onchange^="SelectCaptureDevice"]')).toHaveValue('hw:7');
  await expect(mapping(page, 0, 1).locator('option:checked')).toHaveText('Mono → Left+Right');
  await expect(group(page).locator('.output-routing input')).toBeChecked();
});

test('picking another device drops the old mapping, and a source as wide as the group is offered none', async ({ page }) => {
  writeFile(FILE, { inputGroups: [{ id: 2, name: 'Stage', enabled: true, channels: 2, outputs: [],
    members: [{ type: 'capture', cardId: 'hw:7', nodeName: MIC.name, name: 'Mic', volume: 100, mute: false, channelMapping: MONO_TO_LR }] }] });
  await openPage(page);
  await expect(mapping(page).locator('option:checked')).toHaveText('Mono → Left+Right');
  await member(page).locator('select[onchange^="SelectCaptureDevice"]').selectOption('hw:8');
  await expect(mapping(page)).toHaveCount(0);
  // The name typed for the old device is kept.
  await expect(member(page).locator('input[onchange*="\'name\'"]')).toHaveValue('Mic');
  await save(page);
  const m = savedGroups()[0].members[0];
  expect(m).toMatchObject({ cardId: 'hw:8', nodeName: LINE.name });
  expect(m).not.toHaveProperty('channelMapping');
});

test("a plugin's PipeWire source is saved with its channel count, so the mapping survives the node being absent", async ({ page }) => {
  await openPage(page);
  await page.locator('button[onclick="AddInputGroup()"]').first().click();
  // A new member has no name yet, so it takes the source's.
  await group(page).locator('button[onclick^="AddMember"]').click();
  await typeOf(page, 0, 1).selectOption('pw_source');
  await member(page, 0, 1).locator('select[onchange^="SelectPWSource"]').selectOption(LTC.nodeName);
  await expect(member(page, 0, 1).locator('input[onchange*="\'name\'"]')).toHaveValue('LTC [smpte]');
  await mapping(page, 0, 1).selectOption({ label: 'Mono → Left only' });
  await save(page);
  expect(savedGroups()[0].members[1]).toMatchObject({
    type: 'pw_source', nodeName: LTC.nodeName, name: 'LTC [smpte]', channels: 1,
    channelMapping: { sourceChannels: ['MONO'], groupChannels: ['FL'] },
  });
});

test('mute and volume on a capture member are sent live; on an fppd stream they are not', async ({ page }) => {
  writeFile(FILE, { inputGroups: [{ id: 5, name: 'Stage', enabled: true, channels: 2, outputs: [],
    members: [
      { type: 'fppd_stream', sourceId: 'fppd_stream_1', name: 'Media', volume: 100, mute: false },
      { type: 'capture', cardId: 'hw:8', nodeName: LINE.name, name: 'Line', volume: 80, mute: false },
    ] }] });
  const live = await openPage(page);

  await member(page, 0, 0).locator('.mute-btn').click();
  await member(page, 0, 1).locator('.mute-btn').click();
  await expect.poll(() => live.volume).toEqual([{ groupId: 5, memberIndex: 1, volume: 0, mute: true }]);
  // A level moved while muted is kept for the unmute, not sent.
  await member(page, 0, 1).locator('.volume-slider').fill('40');
  await member(page, 0, 1).locator('.mute-btn').click();
  await expect.poll(() => live.volume.at(-1)).toEqual({ groupId: 5, memberIndex: 1, volume: 40, mute: false });
  await member(page, 0, 1).locator('.volume-slider').fill('55');
  await expect.poll(() => live.volume.at(-1)).toEqual({ groupId: 5, memberIndex: 1, volume: 55 });
  expect(live.volume.filter((v) => v.memberIndex === 0)).toEqual([]);

  // Nothing is in the file until Save.
  expect(savedGroups()[0].members[1]).toMatchObject({ volume: 80, mute: false });
  await save(page);
  expect(savedGroups()[0].members.map((m: any) => [m.volume, m.mute])).toEqual([[100, true], [55, false]]);
});

test('removing a group asks first, and the removal is only saved by Save', async ({ page }) => {
  writeFile(FILE, { inputGroups: [
    { id: 1, name: 'Keep', enabled: true, channels: 2, members: [], outputs: [] },
    { id: 2, name: 'Drop', enabled: true, channels: 2, members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_2' }], outputs: [] },
  ] });
  await openPage(page);
  page.once('dialog', (d) => d.dismiss());
  await group(page, 1).locator('button[onclick^="RemoveGroup"]').click();
  await expect(page.locator('.ig-card')).toHaveCount(2);
  page.once('dialog', (d) => d.accept());
  await group(page, 1).locator('button[onclick^="RemoveGroup"]').click();
  await expect(page.locator('.ig-card')).toHaveCount(1);
  expect(savedGroups()).toHaveLength(2);
  await save(page);
  expect(savedGroups().map((g) => g.name)).toEqual(['Keep']);
});

test('Save & Apply saves, then applies; a refused apply or save says why', async ({ page }) => {
  let live = await openPage(page);
  await page.locator('button[onclick="AddInputGroup()"]').first().click();
  await page.locator('button[onclick="ApplyInputGroups()"]').first().click();
  await expect(page.locator('.jGrowl-message', { hasText: 'fpp-tests applied' })).toBeVisible();
  expect(live.apply).toBe(1);
  expect(savedGroups().map((g) => g.name)).toEqual(['Input Group 1']);

  live = await openPage(page, { applyStatus: 500 });
  await page.locator('button[onclick="ApplyInputGroups()"]').first().click();
  await expect(page.locator('.jGrowl-message', { hasText: 'fpp-tests apply refusal' })).toBeVisible();

  // A refused save stops before the apply.
  await page.route('**/api/pipewire/audio/input-groups', (r) => r.request().method() === 'POST'
    ? r.fulfill({ status: 400, json: { status: 'ERROR', message: 'fpp-tests save refusal' } })
    : r.continue());
  const applies = live.apply;
  await page.locator('button[onclick="ApplyInputGroups()"]').first().click();
  await expect(page.locator('.jGrowl-message', { hasText: 'fpp-tests save refusal' })).toBeVisible();
  expect(live.apply).toBe(applies);
});

test("changing a group's channel count drops a mapping made for the old count", async ({ page }) => {
  // A mono mic mapped Mono → Left+Right into a stereo group; the group is
  // then made mono.  The generator writes a member's saved mapping as the
  // loopback's playback positions (GenerateInputGroupsConf), so a kept
  // mapping plays FL+FR into a MONO bus.
  writeFile(FILE, { inputGroups: [{ id: 6, name: 'Stage', enabled: true, channels: 2, outputs: [],
    members: [{ type: 'capture', cardId: 'hw:7', nodeName: MIC.name, name: 'Mic', volume: 100, mute: false, channelMapping: MONO_TO_LR }] }] });
  await openPage(page);
  await expect(mapping(page)).toHaveCount(1);

  // The control: the same member in a group saved as mono is offered no
  // mapping (a mono source into a mono group needs none).
  await page.evaluate(() => {
    (window as any).inputGroups.inputGroups[0].channels = 1;
    delete (window as any).inputGroups.inputGroups[0].members[0].channelMapping;
    (window as any).RenderAll();
  });
  await expect(mapping(page)).toHaveCount(0);
  await openPage(page);

  test.fail(true, "a group's channel count change keeps the member's mapping for the old layout (FUTURE.md)");
  await channels(page).selectOption('1');
  await save(page);
  const m = savedGroups()[0].members[0];
  expect(savedGroups()[0].channels).toBe(1);
  expect(m.channelMapping?.groupChannels ?? [], 'a mono group saved with a mapping onto FL/FR').not.toContain('FR');
  await expect(mapping(page), 'the old layout\'s mapping is still offered').toHaveCount(0, { timeout: 2_000 });
});
