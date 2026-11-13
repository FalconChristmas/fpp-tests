import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { CONFIG, exists, readFile, writeFile } from './pw-helpers';
import { settingInFile, setSettingInFile } from './settings-file';

// The AES67 page's editor (aes67-config.php): the PTP settings, Add
// Instance, each stream's fields, delete, Save & Apply and its failures, the
// idle notice, the status line and the SDP dialog.
//
// Save is real: the receiving end is pipewire-aes67-instances.json, put back
// after each test (the save itself is covered by aes67-save-refusals.spec.ts).
// The interface list, the output groups, fppd's status and SDP, and Apply
// (which can restart PipeWire and fppd) are answered here.

test.skip(!container, 'saves the AES67 instances inside the run-web.sh container');

const FILE = `${CONFIG}/pipewire-aes67-instances.json`;
const KEYS = ['MediaBackend', 'AudioBackend'];

let keys: (string | undefined)[] = [];
let saved: string | null = null;
test.beforeEach(() => {
  keys = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
  saved = exists(FILE) ? readFile(FILE) : null;
  inPlayer('rm', '-f', FILE);
});
test.afterEach(() => {
  if (saved === null) inPlayer('rm', '-f', FILE);
  else inPlayer('sh', '-c', `echo '${Buffer.from(saved).toString('base64')}' | base64 -d > '${FILE}'`);
  KEYS.forEach((k, i) => setSettingInFile(k, keys[i]));
});

const stored = (): any => JSON.parse(readFile(FILE));

type Opts = {
  interfaces?: string[];
  groups?: any[];
  status?: any;
  sdp?: any;
  apply?: { status?: number; json?: any };
  loadFails?: boolean;
};
type Live = { apply: number };
async function openPage(page: Page, o: Opts = {}): Promise<Live> {
  const live: Live = { apply: 0 };
  await page.route('**/api/pipewire/aes67/interfaces', (r) => r.fulfill({ json: o.interfaces ?? ['eth0', 'eth1'] }));
  await page.route('**/api/pipewire/audio/groups', (r) => r.fulfill({ json: { groups: o.groups ?? [] } }));
  await page.route('**/api/pipewire/audio/sinks', (r) => r.fulfill({ json: [{}, {}] }));
  await page.route('**/api/pipewire/aes67/status', (r) =>
    o.status === undefined ? r.fulfill({ status: 503, body: '' }) : r.fulfill({ json: o.status }));
  await page.route('**/api/pipewire/aes67/sdp', (r) => r.fulfill({ json: o.sdp ?? { streams: [] } }));
  await page.route('**/api/pipewire/aes67/apply', (r) => {
    live.apply++;
    const a = o.apply ?? {};
    return a.status ? r.fulfill({ status: a.status, json: a.json ?? {} }) : r.fulfill({ json: a.json ?? { status: 'OK' } });
  });
  if (o.loadFails) {
    await page.route('**/api/pipewire/aes67/instances', (r) =>
      r.request().method() === 'GET' ? r.fulfill({ status: 500, body: 'fpp-tests load failure' }) : r.fallback());
  }
  const loaded = page.waitForResponse((r) => r.url().endsWith('/api/pipewire/aes67/instances') && r.request().method() === 'GET');
  await page.goto('/aes67-config.php');
  await loaded;
  await expect(page.locator('#instancesContainer')).not.toBeEmpty();
  return live;
}

const card = (page: Page, i = 0) => page.locator('.instance-card').nth(i);
const field = (page: Page, f: string, i = 0) => card(page, i).locator(`[onchange*="'${f}'"]`);

async function saveAndApply(page: Page) {
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/pipewire/aes67/instances') && r.request().method() === 'POST');
  await page.locator('#bottomToolbar button[onclick="SaveAndApply()"]').click();
  return (await posted).status();
}
const dialog = (page: Page) => page.locator('#dialogOKPopup');
async function closeDialog(page: Page) {
  await dialog(page).locator('.modal-footer button', { hasText: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
}

test('a new instance is saved with every field as edited, and the PTP settings with it', async ({ page }) => {
  const live = await openPage(page);
  await expect(page.locator('#noInstancesMsg')).toBeVisible();
  await expect(page.locator('#bottomToolbar')).toBeHidden();
  // A blank saved PTP interface is shown (and saved) as eth0.
  await expect(page.locator('#ptpInterfaceSelect')).toHaveValue('eth0');

  await page.getByRole('button', { name: 'Add AES67 Instance' }).click();
  await expect(page.locator('#unsavedChangesBanner')).toBeVisible();
  const name = card(page).locator('.instance-name-input');
  await expect(name).toHaveValue('AES67 Stream 1');
  await name.fill('Front Yard');
  await name.press('Tab');
  await expect(card(page).locator('.aes67-badge')).toHaveText(['aes67_front_yard_send']);

  await field(page, 'mode').selectOption('both');
  await expect(card(page).locator('.aes67-badge')).toHaveText(['aes67_front_yard_send', 'aes67_front_yard_recv']);
  await field(page, 'multicastIP').fill('239.69.4.5');
  await field(page, 'multicastIP').press('Tab');
  await field(page, 'port').fill('5010');
  await field(page, 'port').press('Tab');
  await field(page, 'interface').selectOption('eth1');
  await field(page, 'ptime').selectOption('4');
  await field(page, 'sessionName').fill('Yard Speakers');
  await field(page, 'sessionName').press('Tab');
  await field(page, 'latency').fill('20');
  await field(page, 'latency').press('Tab');
  await field(page, 'sapEnabled').uncheck();
  await card(page).locator('[onchange^="ToggleInstanceEnabled"]').uncheck();
  await expect(card(page)).toHaveClass(/disabled-instance/);

  await page.locator('#ptpEnabledCheck').uncheck();
  await page.locator('#ptpInterfaceSelect').selectOption('eth1');
  await page.locator('#ptpDomainInput').fill('9');
  await page.locator('#ptpDomainInput').press('Tab');
  await page.locator('#ptpRoleSelect').selectOption('follower');

  expect(await saveAndApply(page)).toBe(200);
  await expect(dialog(page)).toContainText('AES67 configuration applied successfully');
  await closeDialog(page);
  expect(live.apply).toBe(1);
  await expect(page.locator('#unsavedChangesBanner')).toHaveCount(0);
  expect(stored()).toEqual({
    ptpEnabled: false, ptpInterface: 'eth1', ptpDomain: 9, ptpRole: 'follower',
    instances: [{ id: 1, name: 'Front Yard', enabled: false, mode: 'both', multicastIP: '239.69.4.5', port: 5010, channels: 2,
      interface: 'eth1', sessionName: 'Yard Speakers', ptime: 4, latency: 20, sapEnabled: false }],
  });

  // Reloaded, it is shown as saved.
  await openPage(page);
  await expect(card(page).locator('.instance-name-input')).toHaveValue('Front Yard');
  await expect(field(page, 'mode')).toHaveValue('both');
  await expect(field(page, 'interface')).toHaveValue('eth1');
  await expect(field(page, 'ptime')).toHaveValue('4');
  await expect(page.locator('#ptpDomainInput')).toHaveValue('9');
  await expect(page.locator('#ptpRoleSelect')).toHaveValue('follower');
  await expect(page.locator('#ptpEnabledCheck')).not.toBeChecked();
});

test('more than two channels forces 1 ms packets, and a PTP domain out of range goes back to 0', async ({ page }) => {
  writeFile(FILE, { ptpEnabled: true, ptpInterface: 'gone0', ptpDomain: 4, ptpRole: 'auto',
    instances: [{ id: 3, name: 'Wide', enabled: true, mode: 'send', multicastIP: '239.69.0.3', port: 5004, channels: 2, ptime: 4 }] });
  await openPage(page, { interfaces: ['eth1', 'eth2'] });
  // An interface that is no longer there falls back to the first wired one.
  await expect(page.locator('#ptpInterfaceSelect')).toHaveValue('eth1');
  await expect(field(page, 'ptime')).toHaveValue('4');
  await card(page).locator('[onchange^="UpdateChannels"]').selectOption('8');
  await expect(field(page, 'ptime')).toHaveValue('1');
  await expect(field(page, 'ptime').locator('option[value="4"]')).toBeDisabled();
  await expect(card(page)).toContainText('Set the matching output group to 8 channels');

  await page.locator('#ptpDomainInput').fill('200');
  await page.locator('#ptpDomainInput').press('Tab');
  await expect(page.locator('#ptpDomainInput')).toHaveValue('0');

  expect(await saveAndApply(page)).toBe(200);
  expect(stored()).toMatchObject({ ptpInterface: 'eth1', ptpDomain: 0, instances: [{ id: 3, channels: 8, ptime: 1 }] });
});

test('a deleted instance is gone once saved, and deleting the last one can still be saved', async ({ page }) => {
  writeFile(FILE, { ptpEnabled: true, ptpInterface: 'eth0', ptpDomain: 0, ptpRole: 'auto', instances: [
    { id: 1, name: 'Keep', enabled: true, mode: 'receive' }, { id: 2, name: 'Drop', enabled: true, mode: 'receive' }] });
  await openPage(page);
  // A cancelled confirm deletes nothing.
  page.once('dialog', (d) => d.dismiss());
  await card(page, 1).locator('button[onclick^="DeleteInstance"]').click();
  await expect(page.locator('.instance-card')).toHaveCount(2);

  page.once('dialog', (d) => { expect(d.message()).toBe('Delete instance "Drop"?'); d.accept(); });
  await card(page, 1).locator('button[onclick^="DeleteInstance"]').click();
  await expect(page.locator('.instance-card')).toHaveCount(1);
  expect(await saveAndApply(page)).toBe(200);
  await closeDialog(page);
  expect(stored().instances.map((i: any) => i.name)).toEqual(['Keep']);

  page.once('dialog', (d) => d.accept());
  await card(page, 0).locator('button[onclick^="DeleteInstance"]').click();
  await expect(page.locator('#noInstancesMsg')).toBeVisible();
  await expect(page.locator('#bottomToolbar')).toBeVisible();
  expect(await saveAndApply(page)).toBe(200);
  expect(stored().instances).toEqual([]);

  // A new instance after a delete takes the next id, not a reused one.
  writeFile(FILE, { instances: [{ id: 5, name: 'Five', mode: 'receive' }] });
  await openPage(page);
  await page.getByRole('button', { name: 'Add AES67 Instance' }).click();
  await expect(card(page, 1).locator('.instance-name-input')).toHaveValue('AES67 Stream 6');
  await expect(field(page, 'multicastIP', 1)).toHaveValue('239.69.0.6');
});

test('a refused save and a failed apply each say so, and the refused one writes nothing', async ({ page }) => {
  writeFile(FILE, { ptpEnabled: true, ptpInterface: 'eth0', ptpDomain: 0, ptpRole: 'auto', instances: [{ id: 1, name: 'One', mode: 'send' }] });
  const before = readFile(FILE);
  // The page's own role list has no bad value, so the request is changed on the way.
  await page.route('**/api/pipewire/aes67/instances', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = JSON.parse(r.request().postData() || '{}');
    return r.fallback({ postData: JSON.stringify({ ...body, ptpRole: 'grandmaster' }) });
  });
  const live = await openPage(page);
  expect(await saveAndApply(page)).toBe(400);
  await expect(dialog(page)).toContainText('Error saving AES67 config: PTP role must be auto, follower or master');
  await closeDialog(page);
  expect(live.apply).toBe(0);
  expect(readFile(FILE)).toBe(before);
  await page.unroute('**/api/pipewire/aes67/instances');

  // fppd's refusal comes back as a 200 with an ERROR body.
  for (const [apply, text] of [
    [{ json: { status: 'ERROR', message: 'fppd is not running' } }, 'Error applying AES67 config: fppd is not running'],
    [{ status: 500, json: { message: 'fpp-tests apply refusal' } }, 'Error applying AES67 config: fpp-tests apply refusal'],
    [{ json: { status: 'OK', restartRequired: true } }, 'PipeWire and FPPD have both been restarted'],
  ] as const) {
    await openPage(page, { apply });
    expect(await saveAndApply(page)).toBe(200);
    await expect(dialog(page)).toContainText(text);
    await expect(page.locator('#aes67BusyOverlay')).toBeHidden();
  }
});

test('an enabled sender that no output group feeds says it is idle, and one in a group does not', async ({ page }) => {
  writeFile(FILE, { instances: [
    { id: 1, name: 'Fed', enabled: true, mode: 'send' },
    { id: 2, name: 'Unfed', enabled: true, mode: 'send' },
    { id: 3, name: 'Listen', enabled: true, mode: 'receive' },
    { id: 4, name: 'Off', enabled: false, mode: 'send' },
    { id: 5, name: 'Disabled Group', enabled: true, mode: 'both' },
  ] });
  const groups = [
    { id: 1, enabled: true, members: [{ cardId: 'aes67_1' }] },
    { id: 2, enabled: false, members: [{ cardId: 'aes67_5' }] },
  ];
  await openPage(page, { groups });
  const idle = (i: number) => card(page, i).locator('.alert-info');
  await expect(idle(1)).toContainText('It is not a member of any enabled');
  await expect(idle(4)).toContainText('aes67_disabled_group_send');
  for (const i of [0, 2, 3]) await expect(idle(i)).toHaveCount(0);

  // In a group on paper, but fppd says it is held: the other wording.
  await openPage(page, { groups, status: { pipelines: [{ instanceId: 1, mode: 'send', waitingForSource: true }], ptp: { enabled: false } } });
  await expect(idle(0)).toContainText('the running audio graph does not feed');
  await expect(page.locator('#ptpStatus')).toContainText('1 stream idle, waiting for an Audio Output Group');
});

test('the status line and PTP detail show what fppd reports', async ({ page }) => {
  writeFile(FILE, { instances: [{ id: 1, name: 'A', enabled: true, mode: 'send' }] });
  await openPage(page, { status: {
    pipelines: [{ instanceId: 1, name: 'A', mode: 'send', running: true, sourceRate: 44100 }, { instanceId: 2, mode: 'receive', running: false }],
    ptp: { enabled: true, synced: true, isGrandmaster: false, grandmasterId: 'aa-bb', grandmasterAddress: '10.0.0.9', offsetNs: 1500, portState: 'SLAVE', domain: 3, lockedAtStart: false },
    graphSampleRate: 48000,
    discoveredStreams: [{}, {}],
  } });
  const status = page.locator('#ptpStatus');
  await expect(status).toContainText('1 of 2 streams running');
  await expect(status).toContainText('PTP synced to aa-bb (1.5 µs)');
  await expect(status).toContainText('streams started before PTP settled');
  await expect(status).toContainText('2 streams discovered');
  await expect(page.locator('#ptpDetail')).toBeVisible();
  await expect(page.locator('#ptpDetailState')).toHaveText('SLAVE — locked');
  await expect(page.locator('#ptpDetailGm')).toHaveText('aa-bb at 10.0.0.9');
  await expect(page.locator('#ptpDetailDomain')).toHaveText('3');
  await expect(page.locator('#ptpDetailOffset')).toHaveText('1.5 µs');
  await expect(page.locator('#ptpDetailRate')).toContainText('A: 44100 Hz — resampled to 48000 Hz');

  await openPage(page, { status: { pipelines: [], ptp: { enabled: true, synced: false, portState: 'LISTENING', freeRunning: true, grandmasterId: 'cc-dd' } } });
  await expect(status).toContainText('PTP not following cc-dd (no hardware PTP clock on this interface)');
  await expect(page.locator('#ptpDetailGm')).toHaveText('cc-dd');

  await openPage(page);
  await expect(status).toContainText('AES67 status unavailable');
  await expect(page.locator('#ptpDetail')).toBeHidden();
});

test('the SDP dialog shows the applied stream, flags edited fields, and downloads the same text', async ({ page }) => {
  writeFile(FILE, { instances: [
    { id: 1, name: 'Send', enabled: true, mode: 'send', multicastIP: '239.69.0.1', port: 5004, channels: 2, ptime: 1, sessionName: 'Send' },
    { id: 2, name: 'New', enabled: true, mode: 'send' },
    { id: 3, name: 'Recv', enabled: true, mode: 'receive' },
  ] });
  const sdp = 'v=0\r\no=- 1 1 IN IP4 10.0.0.2\r\ns=Send\r\nm=audio 5004 RTP/AVP 96\r\n';
  await openPage(page, { sdp: { streams: [{ instanceId: 1, enabled: false, multicastIP: '239.69.0.1', port: 5004, channels: 2, ptime: 1,
    sessionName: 'Send', sapEnabled: false, sdp, filename: 'send.sdp' }] } });
  // A receive-only instance has no session to describe.
  await expect(card(page, 2).locator('button[onclick^="ShowSDP"]')).toHaveCount(0);

  await field(page, 'port', 0).fill('6000');
  await field(page, 'port', 0).press('Tab');
  await card(page, 0).locator('button[onclick^="ShowSDP"]').click();
  const body = page.locator('#aes67SDPBody');
  await expect(body).toContainText('RTP Port has been changed on this page but not applied');
  await expect(body).toContainText('This instance is disabled');
  await expect(body).toContainText('239.69.0.1:5004');
  await expect(body).toContainText('L24 / 48000 Hz / 2 ch, 1 ms packets');
  await expect(body).toContainText('the stream is not announced');
  await expect(page.locator('#aes67SDPText')).toHaveValue(sdp.replace(/\r\n/g, '\n'));

  const download = page.waitForEvent('download');
  await page.locator('#aes67SDPDownloadBtn').click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('send.sdp');
  const fs = await import('fs');
  expect(fs.readFileSync(await d.path(), 'utf8')).toBe(sdp);
  await page.locator('#aes67SDPDialog .modal-footer button', { hasText: 'Close' }).click();
  await expect(page.locator('#aes67SDPDialog')).toBeHidden();

  // One that has not been applied says so, and offers nothing to copy.
  await card(page, 1).locator('button[onclick^="ShowSDP"]').click();
  await expect(body).toContainText('This instance has not been applied yet');
  await expect(page.locator('#aes67SDPDownloadBtn')).toBeDisabled();
});

test('a failed load leaves the saved instances alone when the page then saves', async ({ page }) => {
  test.fail(true, 'a failed load is shown as no instances, and Save writes that over the saved ones (FUTURE.md)');
  writeFile(FILE, { ptpEnabled: true, ptpInterface: 'eth0', ptpDomain: 5, ptpRole: 'master', instances: [
    { id: 1, name: 'Stage Left', mode: 'send' }, { id: 2, name: 'Stage Right', mode: 'send' }] });
  await openPage(page, { loadFails: true });
  await page.getByRole('button', { name: 'Add AES67 Instance' }).click();
  const status = await saveAndApply(page);
  // Either the page refuses to save over what it could not read, or the save keeps it.
  const names = stored().instances.map((i: any) => i.name);
  expect(names, `save answered ${status}`).toEqual(expect.arrayContaining(['Stage Left', 'Stage Right']));
  expect(stored()).toMatchObject({ ptpDomain: 5, ptpRole: 'master' });
});

test('the page shows the node name fppd gives an instance', async ({ page }) => {
  // fppd (AES67Manager::SafeNodeName) and PHP slug by byte: "ü" is two bytes, two underscores.
  test.fail(true, 'the page slugs a name by character, so a non-ASCII name shows a node that does not exist (FUTURE.md)');
  writeFile(FILE, { instances: [{ id: 1, name: 'Bühne', enabled: true, mode: 'send' }] });
  await openPage(page);
  await expect(card(page).locator('.aes67-badge')).toHaveText(['aes67_b__hne_send']);
});

test('two instances whose names give one node name are not saved side by side', async ({ page }) => {
  test.fail(true, 'two names that slug alike are saved as two senders on one PipeWire node name (FUTURE.md)');
  writeFile(FILE, { instances: [{ id: 1, name: 'Stage 1', enabled: true, mode: 'send' }] });
  await openPage(page);
  await page.getByRole('button', { name: 'Add AES67 Instance' }).click();
  const name = card(page, 1).locator('.instance-name-input');
  await name.fill('Stage-1');
  await name.press('Tab');
  // Both badges read the same node, which fppd creates twice.
  await expect(card(page, 0).locator('.aes67-badge')).toHaveText(['aes67_stage_1_send']);
  await expect(card(page, 1).locator('.aes67-badge')).toHaveText(['aes67_stage_1_send']);
  await saveAndApply(page);
  const names = stored().instances.map((i: any) => i.name);
  expect(names, 'both were saved').not.toEqual(['Stage 1', 'Stage-1']);
});
