import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { listen, stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, standInNode } from './pw-load';

// The "Pipewire Apply Routing Preset" fppd command, end to end: fppd posts
// the preset's name to /api/pipewire/audio/routing/presets/live-apply, and
// that PHP sets the bus's routing level on the running PipeWire graph and
// saves it.  The receiving end of what scenarios/test_commands.py checks
// fppd sends.

test.skip(!container, 'drives the player inside the run-web.sh container');

// Apply restarts fppd and waits for it to come back.
test.describe.configure({ timeout: 240_000 });

const SETTINGS = '/home/fpp/media/settings';
const PRESET = `${CONFIG}/routing-presets/Quiet Out.json`;

test.afterEach(() => {
  inPlayer('sh', '-c', `sed -i '/^PipeWireSinkName /d' ${SETTINGS}; rm -rf '${CONFIG}/routing-presets'`);
  stopPipeWire();
  cleanupPipeWire();
});

async function applyInputGroups(request: APIRequestContext, inputGroups: unknown[]) {
  const save = await request.post('/api/pipewire/audio/input-groups', { data: { inputGroups } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
}

test('the routing preset command sets the saved level on the running bus', async ({ request }) => {
  // Feature: 11a5a13a6 ("Apply Routing Preset" fppd command and the
  // live-apply endpoint), named "Pipewire Apply Routing Preset" since
  // 7b9766638.  A preset that changes only a routing level is applied live:
  // the combine-stream member feeding the output group gets the level, and
  // the input groups config keeps it.
  writeFile(`${CONFIG}/pipewire-audio-groups.json`,
    { groups: [{ id: 1, name: 'Out', channels: 2, enabled: true, members: [] }] });
  await applyInputGroups(request, [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
    members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }]);
  loadGeneratedConf([standInNode('fpp_group_out')], ['fpp_input_bus', 'output.fpp_input_bus_fpp_group_out']);
  listen('fpp_input_bus');

  writeFile(PRESET, { name: 'Quiet Out', routing: [{ inputGroupId: 1, inputGroupName: 'Bus', outputs: [1],
    routing: { 1: { volume: 30, mute: false } }, effects: {} }] });
  const run = await request.post('/api/command', { data: { command: 'Pipewire Apply Routing Preset', args: ['Quiet Out'] } });
  expect(run.ok(), await run.text()).toBe(true);

  await expect.poll(() => {
    const n = graph().nodes.get('output.fpp_input_bus_fpp_group_out');
    return Object.assign({}, ...(n?.info?.params?.Props ?? [])).channelVolumes;
  }, { timeout: 10_000, message: describe(graph()) }).toEqual([0.3, 0.3].map((v) => expect.closeTo(v, 3)));
  const saved = JSON.parse(readFile(`${CONFIG}/pipewire-input-groups.json`)).inputGroups[0];
  expect(saved.routing['1'].volume).toBe(30);
});
