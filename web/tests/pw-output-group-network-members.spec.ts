import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// An output group member can be an Opus RTP or VBAN sender instead of a sound
// card (cardId opusrtp_<id> or vban_<id>).  Save & Apply of the groups
// (97-fpp-audio-groups.conf) feeds the sender's own sink, and names in a
// WARNING line each member whose sender is missing, disabled, or (for VBAN)
// only receives.  The AES67 members are pw-aes67-group-rebuild.spec.ts.

test.skip(!container, "reads the generated config inside the run-web.sh container");
test.describe.configure({ timeout: 240_000 });

const CONF = '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf';
const OPUS = `${CONFIG}/pipewire-opus-rtp-instances.json`;
const VBAN = `${CONFIG}/pipewire-vban-instances.json`;

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(async ({ request }) => {
  cleanupPipeWire();
  inPlayer('rm', '-f', OPUS);
  restoreSettings();
  await settleAfterApply(request);
});

test('an Opus RTP or VBAN sender in a group is fed through its own sink, and one that cannot send is named', async ({ request }) => {
  writeFile(OPUS, { instances: [
    { id: 1, name: 'Opus Out', enabled: true, mode: 'send' },
    { id: 2, name: 'Opus Off', enabled: false, mode: 'send' },
  ] });
  writeFile(VBAN, { instances: [
    { id: 3, name: 'Desk', enabled: true, mode: 'send' },
    { id: 4, name: 'Listen', enabled: true },             // receives, by default
    { id: 5, name: 'Spare', enabled: false, mode: 'both' },
  ] });
  const members = ['opusrtp_1', 'opusrtp_2', 'opusrtp_7', 'vban_3', 'vban_4', 'vban_5', 'vban_9']
    .map((cardId) => ({ cardId, channels: 2 }));
  const save = await request.post('/api/pipewire/audio/groups',
    { data: { groups: [{ id: 1, name: 'Net', enabled: true, channels: 2, members }] } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);

  const conf = readFile(CONF);
  expect(conf).toContain('node.target = "opusrtp_opus_out_send"');
  expect(conf).toContain('node.target = "vban_desk_send"');
  const warning = conf.split('\n').find((l) => l.startsWith('# WARNING: Could not find PipeWire sinks for:'));
  expect(warning, conf).toBeDefined();
  for (const [id, why] of [
    ['opusrtp_2', 'Opus RTP instance not found or disabled'],
    ['opusrtp_7', 'Opus RTP instance not found or disabled'],
    ['vban_4', 'VBAN instance not found, disabled, or not a sender'],
    ['vban_5', 'VBAN instance not found, disabled, or not a sender'],
    ['vban_9', 'VBAN instance not found, disabled, or not a sender'],
  ]) {
    expect(warning).toContain(`${id} (${why})`);
  }
  expect(warning).not.toContain('opusrtp_1');
  expect(warning).not.toContain('vban_3');
  expect(conf).not.toMatch(/node\.target = "(opusrtp_opus_off|vban_listen|vban_spare)/);
});

test('with no sender instances saved at all, an Opus RTP or VBAN member is named as missing', async ({ request }) => {
  inPlayer('rm', '-f', OPUS, VBAN);
  const save = await request.post('/api/pipewire/audio/groups', { data: { groups: [{ id: 1, name: 'Net', enabled: true,
    channels: 2, members: [{ cardId: 'opusrtp_1', channels: 2 }, { cardId: 'vban_1', channels: 2 }] }] } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  const conf = readFile(CONF);
  expect(conf).toMatch(/# WARNING: .*opusrtp_1 \(Opus RTP instance not found or disabled\)/);
  expect(conf).toMatch(/# WARNING: .*vban_1 \(VBAN instance not found, disabled, or not a sender\)/);
});
