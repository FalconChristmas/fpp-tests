import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, fakeSoundCards, hwParams, readFile, sinkNode, standInAplay, standInPwDump, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Feature: f3288dbb3 ("Make PipeWire audio groups robust across reboots and
// USB changes").  An Apply stores the PipeWire node each member's card
// resolved to (nodeTarget) in pipewire-audio-groups.json, and
// scripts/regenerate_pipewire_groups, which fppinit runs at boot before
// every device has shown up, falls back on it: a group whose USB card isn't
// enumerated yet keeps targeting that card's WirePlumber sink rather than
// losing the member.  The card is a fake (/proc/asound, aplay), its sink a
// stand-in pw-dump; at "boot" there is neither, and no PipeWire.

test.skip(!container, 'stubs a sound card and runs the regenerate script inside the run-web.sh container');

const CONF = '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf';
const SINK = 'alsa_output.usb-fpp_tests_dac-00.analog-stereo';

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(async ({ request }) => {
  cleanupPipeWire();
  restoreSettings();
  await settleAfterApply(request);
});

test("a group member keeps its card's sink when the boot-time regenerate can't see the card", async ({ request }) => {
  test.setTimeout(180_000);
  fakeSoundCards([{ id: 'DAC' }]);
  standInAplay({ 'hw:DAC': hwParams() });
  standInPwDump([sinkNode(40, SINK, { 'alsa.card': 0 })]);
  const save = await request.post('/api/pipewire/audio/groups', {
    data: { groups: [{ id: 1, name: 'Usb', enabled: true, channels: 2, members: [{ cardId: 'DAC', channels: 2 }] }] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  const stored = JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups.json`));
  expect(stored.groups[0].members[0].nodeTarget, 'the resolved node was not stored').toBe(SINK);

  // Boot: the USB card hasn't been enumerated and PipeWire has nothing to say.
  // (cleanupPipeWire() takes the fake card and the stand-in pw-dump away, and
  // the saved config with them: that is put back.)
  const json = readFile(`${CONFIG}/pipewire-audio-groups.json`);
  cleanupPipeWire();
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, json);
  const out = inPlayer('sh', '-c', 'php /opt/fpp/scripts/regenerate_pipewire_groups --force 2>&1 || true');
  const conf = readFile(CONF);
  expect(conf, `the regenerated groups lost the card's sink:\n${out}`).toContain(`node.target = "${SINK}"`);
});
