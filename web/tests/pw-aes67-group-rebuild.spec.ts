import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, reaches, standInNode } from './pw-load';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: 919e70af7 ("rebuild the audio graph when a sender instance is
// enabled or renamed").  An output group member can be an AES67 send
// instance; the groups conf (97-fpp-audio-groups.conf) leaves out a member
// whose instance is disabled.  Enabling the instance and applying AES67 only
// signalled fppd, so the groups conf still had no member feeding the sender,
// and the send stream failed to start (warning 44) until the groups were
// applied again by hand.  Now the AES67 apply regenerates the groups and
// applies them when that changes the graph, and only then.  The receiving end
// is a real PipeWire loading the conf (pw-load.ts), a null sink standing in
// for the sender's own sink.

test.skip(!container, 'reads the generated config and runs a real PipeWire inside the run-web.sh container');

const CONF = '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf';
const AES67 = `${CONFIG}/pipewire-aes67-instances.json`;

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(async ({ request }) => {
  stopPipeWire();
  cleanupPipeWire();
  inPlayer('rm', '-f', AES67);
  restoreSettings();
  await settleAfterApply(request);
});

function instance(enabled: boolean, ptime = 1) {
  return { id: 1, name: 'fpp-tests tx', mode: 'send', enabled, sapEnabled: false, multicastIP: '239.69.0.9', port: 5004, channels: 2, ptime };
}

async function applyAES67(request: APIRequestContext, inst: object) {
  const save = await request.post('/api/pipewire/aes67/instances', { data: { ptpEnabled: false, ptpInterface: 'lo', instances: [inst] } });
  expect(save.ok(), await save.text()).toBe(true);
  await request.post('/api/pipewire/aes67/apply', { timeout: 120_000 });
  await settleAfterApply(request);
}

const sendTarget = (conf: string) => conf.match(/node\.target = "(aes67_[A-Za-z0-9_]+_send)"/)?.[1];

test('enabling an AES67 send that a group feeds rebuilds the groups, and a bitrate-only edit does not', async ({ request }) => {
  test.setTimeout(240_000);
  writeFile(AES67, { ptpEnabled: false, ptpInterface: 'lo', instances: [instance(false)] });
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Net', enabled: true, channels: 2, members: [{ cardId: 'aes67_1', channels: 2 }] }],
  });
  const apply = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  // The control: with the instance disabled the member is left out.
  expect(sendTarget(readFile(CONF)), readFile(CONF)).toBeUndefined();

  await applyAES67(request, instance(true));
  const conf = readFile(CONF);
  const target = sendTarget(conf);
  expect(target, `the groups were not rebuilt for the enabled sender:\n${conf}`).toBeDefined();

  // Changing only the packet time wires nothing differently: the conf is left as it is.
  const stamp = () => inPlayer('stat', '-c', '%i %Y %Z', CONF).trim();
  const before = stamp();
  await new Promise((r) => setTimeout(r, 1100));
  await applyAES67(request, instance(true, 4));
  expect(stamp(), 'a ptime-only edit rewrote the groups').toBe(before);

  // The receiving end: the group's sink reaches the sender's sink.
  loadGeneratedConf([standInNode(target!)], ['fpp_group_net']);
  await expect.poll(() => reaches(graph(), 'fpp_group_net', target!),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
});
