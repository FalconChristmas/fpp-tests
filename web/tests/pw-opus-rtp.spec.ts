import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, reaches, standInNode } from './pw-load';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Opus RTP streams in the PipeWire graph and on their config page.

test.skip(!container, 'seeds config files and runs a real PipeWire inside the run-web.sh container');

const OPUS = `${CONFIG}/pipewire-opus-rtp-instances.json`;

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(async ({ request }) => {
  stopPipeWire();
  cleanupPipeWire();
  writeFile(OPUS, { instances: [] });
  restoreSettings();
  await settleAfterApply(request);
});

async function applyInputGroups(request: APIRequestContext, inputGroups: unknown[]): Promise<string> {
  const save = await request.post('/api/pipewire/audio/input-groups', { data: { inputGroups } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  return readFile(`${CONFIG}/pipewire-input-groups.conf`);
}

test('an input group member that is an Opus RTP receive stream is looped in from its node', async ({ request }) => {
  // Regression: f1ec7399c.  The input groups generator had no case for an
  // opus_rtp_receive member, so it was dropped from the bus.  It now resolves
  // the instance to its PipeWire node, opusrtp_<name>_recv.  The receiving
  // end: a real PipeWire, with a null source standing in for that node (fppd
  // makes it from the RTP stream), carries it to the bus's output group.
  test.setTimeout(180_000);
  writeFile(OPUS, { instances: [{ id: 1, name: 'Desk Rx', mode: 'receive', enabled: true, destIP: '239.69.1.5', port: 5006, channels: 2 }] });
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, { groups: [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [] }] });
  const conf = await applyInputGroups(request, [{ id: 1, name: 'Net Bus', enabled: true, channels: 2, outputs: [1],
    members: [{ type: 'opus_rtp_receive', instanceId: 1 }] }]);
  expect(conf, 'the Opus RTP member was left out').toContain('node.target = "opusrtp_desk_rx_recv"');

  loadGeneratedConf([standInNode('fpp_group_out'), standInNode('opusrtp_desk_rx_recv', { mediaClass: 'Audio/Source' })],
    ['fpp_input_net_bus']);
  await expect.poll(() => reaches(graph(), 'opusrtp_desk_rx_recv', 'fpp_group_out'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
});

test('the Opus RTP page warns about multicast over WiFi, and only then', async ({ page }) => {
  // Regression: da56c6de3.  A send to a 239.x group on a wireless interface
  // gets the access point's lowest rate and no retransmission; the page now
  // says so under the destination, and says nothing for unicast or wired.
  writeFile(OPUS, { instances: [
    { id: 1, name: 'Air Tx', mode: 'send', enabled: true, destIP: '239.69.1.5', port: 5006, channels: 2, interface: 'wlan0' },
    { id: 2, name: 'Wire Tx', mode: 'send', enabled: true, destIP: '239.69.1.6', port: 5006, channels: 2, interface: 'eth0' },
  ] });
  await page.goto('/opus-rtp-config.php');
  const warn = (id: number) => page.locator(`#destip-warn-${id}`);
  await expect(warn(1), 'no warning for multicast over WiFi').toBeVisible({ timeout: 15_000 });
  await expect(warn(2)).toBeHidden();
  // Unicast to the receiver over the same WiFi: no warning.
  const dest = page.locator(`input[onchange^="UpdateField(0, 'destIP'"]`);
  await dest.fill('192.168.10.20');
  await dest.dispatchEvent('change');
  await expect(warn(1)).toBeHidden();
});
