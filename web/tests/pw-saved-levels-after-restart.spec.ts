import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, peakThrough, reaches, standInNode, pw } from './pw-load';

// A level saved on an input group member or on a routing path, heard after
// the PipeWire stack has (re)started -- the path a user takes: save with a
// level, Apply, the stack starts on the conf Apply wrote, and Apply's own
// post-restart restore runs against it.  A half-scale tone is played in and
// read off the output group sink's monitor.
//
// Regression: fpp 38827a39d.  The generators write these levels as
// channelmix.volume, which PipeWire (1.4) keeps as a node property but does
// not apply, and nothing set a saved member or path level once the stack was
// up (RestorePipeWireInputGroupVolumes() and fppinit's
// restorePipeWireVolumes() restored the bus and group levels only), so both
// were heard at full level.

test.skip(!container, 'runs a real PipeWire inside the run-web.sh container');
test.describe.configure({ timeout: 240_000 });

// fppd, restarted by each Apply, puts its master volume on the sinks (the
// default one here): full scale, so it is not what is measured.
let master = 0;
test.beforeEach(async ({ request }) => {
  master = (await (await request.get('/api/system/volume')).json()).volume;
  await request.post('/api/system/volume', { data: { volume: 100 } });
});

test.afterEach(async ({ request }) => {
  stopPipeWire();
  cleanupPipeWire();
  await request.post('/api/system/volume', { data: { volume: master } });
});

async function applyInputGroups(request: APIRequestContext) {
  const r = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  await settleAfterApply(request);
}

// Apply, bring the stack up on what it wrote, then Apply again: the same
// conf, so this time its restart-and-restore steps meet a running graph.
async function applyAndStart(request: APIRequestContext, standIns: string[], waitFor: string[]) {
  await applyInputGroups(request);
  loadGeneratedConf(standIns, waitFor);
  await applyInputGroups(request);
}

// The control for a measurement through node `id`: set live to unity and to
// 20%, the half-scale tone played into `into` is read off as 0.5 and 0.1.
function levelsAreMeasured(id: number | undefined, into: string) {
  for (const [level, peak] of [[1, 0.5], [0.2, 0.1]]) {
    pw(`pw-cli set-param ${id} Props '{ channelVolumes: [ ${level}, ${level} ] }'`);
    expect(peakThrough(into, 'fpp_group_front'), `the measurement at ${level * 100}%`).toBeCloseTo(peak, 1);
  }
}

function seed(inputGroups: unknown[]) {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Front', enabled: true, channels: 2, members: [] }],
  });
  writeFile(`${CONFIG}/pipewire-input-groups.json`, { inputGroups });
}

test('a routing path saved at 60% is heard at 60% after the stack starts', async ({ request }) => {
  // Saved by 15e3d607a's routing matrix as channelmix.volume on the bus's
  // stream to the output group.
  seed([{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
    routing: { '1': { volume: 60, mute: false } }, members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }]);
  await applyAndStart(request, [standInNode('fpp_group_front')], ['fpp_input_bus']);
  await expect.poll(() => reaches(graph(), 'fpp_input_bus', 'fpp_group_front'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);

  // The controls: the tone arrives at half scale, and a level PipeWire does
  // apply (channelVolumes, set live) is measured as that level.
  expect(peakThrough('fpp_group_front', 'fpp_group_front')).toBeCloseTo(0.5, 1);
  const saved = peakThrough('fpp_input_bus', 'fpp_group_front');
  levelsAreMeasured(graph().nodes.get('output.fpp_input_bus_fpp_group_front')?.id, 'fpp_input_bus');

  expect(saved, 'the saved 60% path level was not applied').toBeCloseTo(0.3, 1);
});

test('a member saved at 50% is heard at 50% after the stack starts', async ({ request }) => {
  // Saved by 54101241b as channelmix.volume on the member's loopback into the
  // bus.  The member is fppd_stream_1 in two buses, so it reaches each through
  // a loopback from the tee (8df908f77), which a tone can be played into.
  seed([
    { id: 1, name: 'Bus A', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1', name: 'Media', volume: 50 }] },
    { id: 2, name: 'Bus B', enabled: true, channels: 2, outputs: [],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1', name: 'Media' }] },
  ]);
  await applyAndStart(request, [standInNode('fpp_group_front')], ['fpp_tee_fppd_stream_1', 'output.fpp_loopback_ig1_fppd_stream_1']);
  await expect.poll(() => reaches(graph(), 'fpp_tee_fppd_stream_1', 'fpp_group_front'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);

  const saved = peakThrough('fpp_tee_fppd_stream_1', 'fpp_group_front');
  levelsAreMeasured(graph().nodes.get('output.fpp_loopback_ig1_fppd_stream_1')?.id, 'fpp_tee_fppd_stream_1');

  expect(saved, 'the saved 50% member level was not applied').toBeCloseTo(0.25, 1);
});

test('an output group Apply puts a saved routing path level back too', async ({ request }) => {
  // Regression: fpp 38827a39d.  An output group Apply restarts the stack as
  // well, which rebuilds the input groups' nodes at full level, and it put
  // back only the output groups' levels.
  seed([{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
    routing: { '1': { volume: 60, mute: false } }, members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }]);
  await applyAndStart(request, [standInNode('fpp_group_front')], ['fpp_input_bus']);
  await expect.poll(() => reaches(graph(), 'fpp_input_bus', 'fpp_group_front'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);

  // The path as a restart leaves it -- and the control: at full level the
  // half-scale tone arrives at half scale.
  const id = graph().nodes.get('output.fpp_input_bus_fpp_group_front')?.id;
  pw(`pw-cli set-param ${id} Props '{ channelVolumes: [ 1.0, 1.0 ] }'`);
  expect(peakThrough('fpp_input_bus', 'fpp_group_front')).toBeCloseTo(0.5, 1);

  const r = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  await settleAfterApply(request);
  expect(peakThrough('fpp_input_bus', 'fpp_group_front'), 'the saved 60% path level was not put back').toBeCloseTo(0.3, 1);
});
