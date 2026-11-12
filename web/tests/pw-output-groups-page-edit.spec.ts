import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { CONFIG, exists, readFile, writeFile } from './pw-helpers';
import { BACKUPS, settingInFile, setSettingInFile } from './settings-file';
import { listen, nullSink, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';

// The Audio Output Groups page's editor (pipewire-audio.php): a group's
// name, channels and latency option, its members (card, channels, channel
// map, sample rate, period, delay), EQ, Save, Save & Apply, and the live
// group fader.
//
// Save is real: the receiving end is pipewire-audio-groups.json, put back
// after each test with the config backup each save makes removed.  The card
// list is served by the test.  Apply's server side regenerates PipeWire's
// config and the page then restarts fppd; both are answered here (the
// generator is covered by pw-output-group-apply.spec.ts).  The fader test
// runs a real PipeWire (pw-live.ts) and reads the sink's level back.

test.skip(!container, 'saves the output groups inside the run-web.sh container');

const FILE = `${CONFIG}/pipewire-audio-groups.json`;
const KEYS = ['MediaBackend', 'AudioBackend'];
const listBackups = () => inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && cd ${BACKUPS} && find . -type f | sort`);

const CARDS = [
  { cardId: 'S3', cardName: 'Sound Eight', channels: 8, pwNodeName: 'alsa_output.fpp-tests-s3' },
  { cardId: 'USB', cardName: 'USB Audio', channels: 2, pwNodeName: 'alsa_output.fpp-tests-usb' },
];

let keys: (string | undefined)[] = [];
let saved: string | null = null;
let backups = '';
let pipewire = false;
test.beforeEach(() => {
  keys = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
  saved = exists(FILE) ? readFile(FILE) : null;
  inPlayer('rm', '-f', FILE);
  backups = listBackups();
});
test.afterEach(() => {
  if (pipewire) stopPipeWire();
  pipewire = false;
  if (saved === null) inPlayer('rm', '-f', FILE);
  else inPlayer('sh', '-c', `echo '${Buffer.from(saved).toString('base64')}' | base64 -d > '${FILE}'`);
  KEYS.forEach((k, i) => setSettingInFile(k, keys[i]));
  inPlayer('sleep', '1');
  const had = new Set(backups.split('\n'));
  for (const f of listBackups().split('\n').filter((l) => l && !had.has(l))) inPlayer('rm', '-f', `${BACKUPS}/${f}`);
});

const savedGroups = (): any[] => (exists(FILE) ? JSON.parse(readFile(FILE)).groups : []);

type Live = { eq: any[]; apply: number; restart: number };
async function openPage(page: Page, o: { applyStatus?: number; cards?: boolean } = {}): Promise<Live> {
  const live: Live = { eq: [], apply: 0, restart: 0 };
  if (o.cards !== false) await page.route('**/api/pipewire/audio/cards', (r) => r.fulfill({ json: CARDS }));
  await page.route('**/api/pipewire/audio/eq/update', (r) => {
    live.eq.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ json: { status: 'OK' } });
  });
  await page.route('**/api/pipewire/audio/groups/apply', (r) => {
    live.apply++;
    return o.applyStatus ? r.fulfill({ status: o.applyStatus, body: 'fpp-tests apply refusal' }) : r.fulfill({ json: { status: 'OK' } });
  });
  await page.route('**/api/system/fppd/restart', (r) => { live.restart++; return r.fulfill({ json: { status: 'OK' } }); });
  await page.goto('/pipewire-audio.php');
  await expect(page.getByRole('button', { name: 'Add Group' }).first()).toBeEnabled({ timeout: 15_000 });
  return live;
}

const groupSel = (page: Page, fn: string, g = 0) => page.locator(`[onchange^="${fn}(${g},"], [onchange^="${fn}(${g} ,"]`);
const memberSel = (page: Page, fn: string, g = 0, m = 0) => page.locator(`[onchange^="${fn}(${g},${m},"], [onchange^="${fn}(${g},${m})"]`);

async function save(page: Page) {
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/pipewire/audio/groups') && r.request().method() === 'POST');
  await page.locator('button[onclick="SaveGroups()"]').first().click();
  expect((await posted).status()).toBe(200);
  await expect(page.locator('.jGrowl-message', { hasText: 'Audio groups saved' })).toBeVisible();
}

test('a new group with an eight-channel card is saved with the card, its channels and a default map', async ({ page }) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Add Group' }).first().click();
  const name = page.locator('.group-name-input');
  await name.fill('Front Yard');
  await name.press('Tab');
  await expect(page.locator('.pipewire-badge').first()).toHaveText('Combine Sink: fpp_group_front_yard');
  await groupSel(page, 'UpdateGroupChannels').selectOption('4');
  await page.locator('[onchange^="UpdateGroupLatency(0,"]').check();

  await page.locator('button[onclick="AddMember(0)"]').click();
  await memberSel(page, 'UpdateMemberCard').selectOption('S3');
  // The member takes the card's eight channels, mapped into the group's
  // four (FL FR RL RR): same position where the group has it, else the
  // group's position at the same index, wrapped.
  await expect(memberSel(page, 'UpdateMemberChannels')).toHaveValue('8');
  await expect(page.locator('[onchange^="UpdateChannelMap(0,0,"]')).toHaveCount(8);
  await memberSel(page, 'UpdateMemberSampleRate').selectOption('48000');
  await memberSel(page, 'UpdateMemberPeriodSize').selectOption('2048');
  await memberSel(page, 'UpdateMemberDelay').fill('250');
  await memberSel(page, 'UpdateMemberDelay').press('Tab');

  await save(page);
  const [g] = savedGroups();
  expect(g).toMatchObject({ id: 1, name: 'Front Yard', enabled: true, channels: 4, latencyCompensate: true });
  expect(g.members).toHaveLength(1);
  expect(g.members[0]).toMatchObject({ cardId: 'S3', cardName: 'Sound Eight', channels: 8, sampleRate: 48000, periodSize: 2048, delayMs: 250 });
  expect(g.members[0].channelMapping).toEqual({
    cardChannels: ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR', 'SL', 'SR'],
    groupChannels: ['FL', 'FR', 'RL', 'RR', 'RL', 'RR', 'RL', 'RR'],
  });

  // Reloaded, it is shown as saved.
  await openPage(page);
  await expect(page.locator('.group-name-input')).toHaveValue('Front Yard');
  await expect(memberSel(page, 'UpdateMemberCard')).toHaveValue('S3');
  await expect(memberSel(page, 'UpdateMemberDelay')).toHaveValue('250');
});

test("a group's channel count change moves each member's map onto the new layout", async ({ page }) => {
  // The output groups page does what the input mixing page does not
  // (pw-input-mixing-page-edit.spec.ts): a map entry onto a position the
  // new layout lacks is moved into it.
  writeFile(FILE, { groups: [{ id: 2, name: 'Quad', enabled: true, channels: 4, members: [{
    cardId: 'USB', channels: 2, channelMapping: { cardChannels: ['FL', 'FR'], groupChannels: ['RL', 'RR'] } }] }] });
  await openPage(page);
  await expect(page.locator('[onchange^="UpdateChannelMap(0,0,0"]')).toHaveValue('RL');
  await groupSel(page, 'UpdateGroupChannels').selectOption('2');
  await expect(page.locator('[onchange^="UpdateChannelMap(0,0,0"]')).toHaveValue('FL');
  await save(page);
  expect(savedGroups()[0]).toMatchObject({ channels: 2, members: [{ channelMapping: { cardChannels: ['FL', 'FR'], groupChannels: ['FL', 'FR'] } }] });

  // A map entry picked by hand is saved.
  await page.locator('[onchange^="UpdateChannelMap(0,0,1"]').selectOption('FL');
  await save(page);
  expect(savedGroups()[0].members[0].channelMapping.groupChannels).toEqual(['FL', 'FL']);
});

test("a member's EQ is saved as edited and sent live while it is on", async ({ page }) => {
  writeFile(FILE, { groups: [{ id: 3, name: 'Yard', enabled: true, channels: 2, members: [{ cardId: 'USB', channels: 2 }] }] });
  const live = await openPage(page);
  await page.locator('[onclick="ToggleEQPanel(0,0)"]').click();
  const panel = page.locator('#eq-panel-row-0-0');
  await expect(panel).toBeVisible();
  const before = await panel.locator('.eq-band-row').count();
  await panel.locator('[onclick="AddEQBand(0,0)"]').click();
  await expect(panel.locator('.eq-band-row')).toHaveCount(before + 1);
  const band = panel.locator('.eq-band-row').last();
  const n = before;

  // Off: edits are kept, nothing is sent.
  await band.locator(`[onchange^="UpdateEQBand(0,0,${n},'freq'"]`).fill('2500');
  await band.locator(`[onchange^="UpdateEQBand(0,0,${n},'freq'"]`).press('Tab');
  await page.waitForTimeout(300);
  expect(live.eq).toEqual([]);

  await panel.locator('[onchange^="ToggleEQ(0,0,"]').check();
  await band.locator('.eq-gain-slider input[type=range]').fill('-6');
  await expect(band.locator('.eq-gain-value')).toHaveText('-6.0');
  await expect.poll(() => live.eq.at(-1)?.bands?.[n]).toMatchObject({ freq: 2500, gain: -6 });
  expect(live.eq.at(-1)).toMatchObject({ groupId: 3, cardId: 'USB', channels: 2 });
  await band.locator(`[onchange^="UpdateEQBand(0,0,${n},'type'"]`).selectOption('bq_highshelf');

  await save(page);
  let eq = savedGroups()[0].members[0].eq;
  expect(eq.enabled).toBe(true);
  expect(eq.bands).toHaveLength(before + 1);
  expect(eq.bands[n]).toMatchObject({ type: 'bq_highshelf', freq: 2500, gain: -6 });

  await panel.locator(`[onclick="RemoveEQBand(0,0,${n})"]`).click();
  await expect(panel.locator('.eq-band-row')).toHaveCount(before);
  await save(page);
  eq = savedGroups()[0].members[0].eq;
  expect(eq.bands).toHaveLength(before);
});

test('a group with no name is not saved', async ({ page }) => {
  writeFile(FILE, { groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2, members: [] }] });
  await openPage(page);
  await page.locator('.group-name-input').fill('  ');
  await page.locator('.group-name-input').press('Tab');
  let posted = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/pipewire/audio/groups')) posted++; });
  await page.locator('button[onclick="SaveGroups()"]').first().click();
  await expect(page.locator('.modal.show')).toContainText('Group 1 must have a name.');
  expect(posted).toBe(0);
  expect(savedGroups()[0].name).toBe('Yard');
});

test('Save & Apply asks first, then saves, applies and restarts fppd; a refused apply says so', async ({ page }) => {
  let live = await openPage(page);
  await page.getByRole('button', { name: 'Add Group' }).first().click();
  await page.locator('button[onclick="ApplyGroups()"]').first().click();
  const confirm = page.locator('#applyConfirmDialog');
  await expect(confirm).toBeVisible();
  await confirm.locator('.modal-footer button', { hasText: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(exists(FILE)).toBe(false);
  expect(live.apply).toBe(0);

  await page.locator('button[onclick="ApplyGroups()"]').first().click();
  await confirm.locator('.modal-footer button', { hasText: 'Save & Apply' }).click();
  await expect(page.locator('.jGrowl-message', { hasText: 'Audio configuration applied and FPPD restarted successfully' })).toBeVisible({ timeout: 30_000 });
  expect([live.apply, live.restart]).toEqual([1, 1]);
  expect(savedGroups().map((g) => g.name)).toEqual(['Audio Group 1']);

  live = await openPage(page, { applyStatus: 500 });
  await page.locator('button[onclick="ApplyGroups()"]').first().click();
  await confirm.locator('.modal-footer button', { hasText: 'Save & Apply' }).click();
  await expect(page.locator('.modal.show')).toContainText('Failed to apply PipeWire configuration: fpp-tests apply refusal');
  expect(live.restart).toBe(0);
});

test.describe('the group fader on a real PipeWire', () => {
  test('moves the group sink', async ({ page }) => {
    writeFile(FILE, { groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2, volume: 100, members: [] }] });
    pipewire = true;
    startPipeWire({ objects: [nullSink('fpp_group_yard')] });
    listen('fpp_group_yard');
    await openPage(page, { cards: true });
    await page.locator('[oninput*="ScheduleGroupVolume(0,"]').fill('40');
    await expect.poll(() => sinkVolume('fpp_group_yard')).toBe(40);
  });

  test('moves the sink of a group whose name is not ASCII', async ({ page }) => {
    // The generator names a group's sink with PHP's byte-wise strtolower()
    // and [^a-zA-Z0-9_] -> _ (GeneratePipeWireConfig, SetPipeWireGroupVolume's
    // own lookup), so "Bühne" is fpp_group_b__hne: ü is two bytes.  The page
    // names it in JavaScript (EscapeNodeName), one character, fpp_group_b_hne,
    // which no sink has; the volume call fails and the page says nothing.
    writeFile(FILE, { groups: [{ id: 1, name: 'Bühne', enabled: true, channels: 2, volume: 100, members: [] }] });
    pipewire = true;
    startPipeWire({ objects: [nullSink('fpp_group_b__hne')] });
    listen('fpp_group_b__hne');
    await openPage(page, { cards: true });
    test.fail(true, "the page's sink name for a non-ASCII group name is not the one generated (FUTURE.md)");
    await page.locator('[oninput*="ScheduleGroupVolume(0,"]').fill('40');
    await expect.poll(() => sinkVolume('fpp_group_b__hne'), { timeout: 5_000 }).toBe(40);
    await expect(page.locator('.pipewire-badge').first()).toHaveText('Combine Sink: fpp_group_b__hne');
  });
});
