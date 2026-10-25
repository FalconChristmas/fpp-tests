import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { listen, loopback, nullSink, pw, startPipeWire, stopPipeWire } from './pw-live';

// The PipeWire pipeline graph: GET /api/pipewire/graph, which reads the live
// graph with pw-dump and adds what FPP's saved config says about it, and the
// pipewire-graph.php page that draws it.  The graph comes from a real
// PipeWire in the player (pw-live.ts) with null sinks, loopbacks and streams
// named the way FPP names its own, so the nodes, ports and links are the ones
// PipeWire itself reports for those shapes.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
});

async function graph(request: APIRequestContext, all = false) {
  const r = await request.get('/api/pipewire/graph' + (all ? '?all=1' : ''));
  expect(r.ok(), await r.text()).toBe(true);
  return r.json() as Promise<{ nodes: any[]; ports: any[]; links: any[] }>;
}

const named = (g: { nodes: any[] }, name: string) => g.nodes.filter((n) => n.name === name);

test('the graph lists the audio nodes PipeWire has, with their ports and links', async ({ request, page }) => {
  // Feature: 259e92d83. GET /api/pipewire/graph turns pw-dump into nodes,
  // ports and links for the pipeline page: audio and video nodes only, unless
  // ?all=1.
  startPipeWire({ objects: [nullSink('fpp_tests_out', { 'node.description': 'fpp-tests output' })] });
  listen('fpp_tests_out');

  const g = await graph(request);
  const [sink] = named(g, 'fpp_tests_out');
  expect(sink, JSON.stringify(g.nodes.map((n) => n.name))).toBeTruthy();
  expect(sink.mediaClass).toBe('Audio/Sink');
  expect(sink.description).toBe('fpp-tests output');
  const ports = g.ports.filter((p) => p.nodeId === sink.id);
  expect(ports.filter((p) => p.direction === 'input').map((p) => p.channel).sort()).toEqual(['FL', 'FR']);
  // The recorder on its monitor is a link out of it.
  expect(g.links.filter((l) => l.outputNodeId === sink.id).length).toBeGreaterThan(0);
  // PipeWire's drivers have no media class: left out, unless everything is asked for.
  expect(named(g, 'Dummy-Driver')).toHaveLength(0);
  expect(named(await graph(request, true), 'Dummy-Driver')).toHaveLength(1);

  await page.goto('/pipewire-graph.php');
  await expect(page.locator('.pw-node .pw-node-label', { hasText: 'fpp-tests output' })).toBeVisible({ timeout: 15_000 });
});

test("an output group's nodes carry its saved delay, EQ and member count", async ({ request, page }) => {
  // Feature: b0c3ce44c. The graph adds the saved config to the nodes it
  // belongs to -- a member's delay and EQ to its filter-chain (fpp_fx_g<id>_
  // <card>), the member count to the group's sink -- and the detail panel
  // shows them.
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2, latencyCompensate: true,
      members: [{ cardId: 'S3', channels: 2, delayMs: 12, volume: 40, eq: { enabled: true, bands: [] } }] }],
  });
  startPipeWire({ objects: [nullSink('fpp_group_yard', { 'node.description': 'Yard' }),
    nullSink('fpp_fx_g1_s3', { 'node.description': 'FX S3' })] });

  const g = await graph(request);
  const [fx] = named(g, 'fpp_fx_g1_s3');
  expect(fx.properties['fpp.delay.ms']).toBe(12);
  expect(fx.properties['fpp.eq.enabled']).toBe(true);
  const [grp] = named(g, 'fpp_group_yard');
  expect(grp.properties['fpp.group.members']).toBe(1);
  expect(grp.properties['fpp.group.latencyCompensate']).toBe(true);

  await page.goto('/pipewire-graph.php');
  // Dispatched rather than clicked: the page eases the view into place after
  // drawing, and a click at where the node was lands on the background.
  await page.locator('.pw-node', { has: page.locator('.pw-node-label', { hasText: 'FX S3' }) }).dispatchEvent('click');
  const panel = page.locator('#pw-detail-panel');
  await expect(panel).toHaveClass(/show/);
  await expect(panel.locator('tr', { hasText: 'Delay (ms)' })).toContainText('12');
  await expect(panel.locator('tr', { hasText: 'EQ Enabled' })).toContainText('Yes');
});

test("the graph does not copy a member's saved volume onto its node", async ({ request }) => {
  // Regression: eca159bb8. The member's saved volume was added to its
  // filter-chain as fpp.volume, a copy that went stale as soon as the live
  // fader moved.
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Yard', enabled: true, channels: 2,
      members: [{ cardId: 'S3', channels: 2, delayMs: 12, volume: 40 }] }],
  });
  startPipeWire({ objects: [nullSink('fpp_fx_g1_s3')] });
  const [fx] = named(await graph(request), 'fpp_fx_g1_s3');
  // The member was matched: its delay is there.
  expect(fx.properties['fpp.delay.ms']).toBe(12);
  // An array path: a dotted string would look for properties.fpp.volume.
  expect(fx.properties).not.toHaveProperty(['fpp.volume']);
});

test('AES67 and fppd stream nodes are labelled for what they are, not "fppd"', async ({ request }) => {
  // Regression: 2265f0464. GStreamer's pipewiresink/pipewiresrc nodes take
  // the process name, "fppd", as their description, and the graph showed
  // every AES67 stream and media stream as a box called "fppd".
  startPipeWire({ objects: [nullSink('aes67_my_stream_send', { 'node.description': 'fppd' })] });
  // A live media stream: a playback stream named as fppd's slot 2, playing silence.
  pw(`setsid nohup pw-cat --playback --raw --format s16 --rate 48000 --channels 2 ` +
    `-P '{ node.name = fppd_stream_2 node.description = fppd media.class = Stream/Output/Audio }' /dev/zero ` +
    `> /dev/null 2>&1 < /dev/null &`);
  await expect.poll(async () => named(await graph(request), 'fppd_stream_2').filter((n) => n.factory !== 'virtual').length,
    { timeout: 10_000 }).toBe(1);

  const g = await graph(request);
  expect(named(g, 'aes67_my_stream_send')[0].description).toBe('AES67: My Stream (send)');
  // The live node, not the placeholder the graph adds for an idle slot.
  const live = named(g, 'fppd_stream_2').filter((n) => n.factory !== 'virtual');
  expect(live.map((n) => n.description)).toEqual(['FPP Media Stream 2']);
});

test("an input group's loopback halves are tied to the group and drawn as part of it", async ({ request, page }) => {
  // Regression: 19ce04912. A loopback module has no node of its own, only
  // input.<name> and output.<name>; the graph matched the bare name, so the
  // halves were never tied to their input group and the page drew both as
  // separate boxes between the capture source and the group.  Also
  // 45c8159c2, which first folded the halves into the group's box (without
  // it they are drawn on their own whatever they are tied to).
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [],
      members: [{ type: 'alsa_capture', name: 'Mic', channels: 2 }] }],
  });
  startPipeWire({
    objects: [nullSink('fpp_input_bus', { 'node.description': 'Bus' }), nullSink('fpp_tests_mic', { 'node.description': 'Mic' })],
    modules: [loopback('fpp_loopback_ig1_mic',
      { 'node.description': 'Loopback Mic', 'target.object': 'fpp_tests_mic', 'stream.capture.sink': true },
      { 'node.description': 'Loopback Mic', 'target.object': 'fpp_input_bus' })],
    waitFor: ['fpp_input_bus', 'input.fpp_loopback_ig1_mic', 'output.fpp_loopback_ig1_mic'],
  });

  const g = await graph(request);
  expect(named(g, 'fpp_input_bus')[0].properties['fpp.inputGroup.id']).toBe(1);
  for (const half of ['input.fpp_loopback_ig1_mic', 'output.fpp_loopback_ig1_mic']) {
    const [n] = named(g, half);
    expect(n, `${half} is not in the graph`).toBeTruthy();
    expect(n.properties['fpp.inputGroup.loopback'], half).toBe(true);
    expect(n.properties['fpp.inputGroup.id'], half).toBe(1);
  }

  await page.goto('/pipewire-graph.php');
  await expect(page.locator('.pw-node .pw-node-label', { hasText: 'Bus' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.pw-node .pw-node-label', { hasText: 'Loopback Mic' })).toHaveCount(0);
});

test('a media stream in two input groups reaches both of them in the graph', async ({ request }) => {
  // Regression: f917decbc. Each input group holding fppd_stream_1 replaced
  // the last as the stream's target, so the graph linked the stream to one
  // group only.  (Since 8df908f77 a stream in two groups goes through a
  // null-sink tee and a loopback per group; the graph links the stream to
  // the tee, and PipeWire's links carry it on.)
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: ['A', 'B'].map((name, i) => ({ id: i + 1, name, enabled: true, channels: 2, outputs: [],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1', name: 'Media', channels: 2 }] })),
  });
  startPipeWire({
    objects: [nullSink('fpp_input_a'), nullSink('fpp_input_b'), nullSink('fpp_tee_fppd_stream_1')],
    modules: [1, 2].map((id) => loopback(`fpp_loopback_ig${id}_fppd_stream_1`,
      { 'target.object': 'fpp_tee_fppd_stream_1', 'stream.capture.sink': true },
      { 'target.object': id === 1 ? 'fpp_input_a' : 'fpp_input_b' })),
    waitFor: ['output.fpp_loopback_ig1_fppd_stream_1', 'output.fpp_loopback_ig2_fppd_stream_1'],
  });
  // Wait for WirePlumber to link both loopbacks.
  await expect.poll(async () => (await graph(request)).links.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(8);

  const g = await graph(request);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const next = new Map<number, Set<number>>();
  const edge = (a: number, b: number) => next.set(a, (next.get(a) ?? new Set()).add(b));
  for (const l of g.links) edge(l.outputNodeId, l.inputNodeId);
  // A loopback's two halves are one path; PipeWire has no link between them.
  for (const n of g.nodes) {
    const out = n.name.startsWith('input.') && g.nodes.find((m) => m.name === 'output.' + n.name.slice(6));
    if (out) edge(n.id, out.id);
  }
  const [stream] = named(g, 'fppd_stream_1');
  const seen = new Set([stream.id]);
  const queue = [stream.id];
  while (queue.length) for (const b of next.get(queue.shift()!) ?? []) if (!seen.has(b)) { seen.add(b); queue.push(b); }
  const reached = [...seen].map((id) => byId.get(id)?.name);
  expect(reached, `stream targets: ${JSON.stringify(stream.properties)}`).toContain('fpp_input_a');
  expect(reached).toContain('fpp_input_b');
});

test("WirePlumber's node for a card FPP drives is dropped from the graph, and only that card's", async ({ request }) => {
  // Regression: b21a3fa9a. The card was taken from api.alsa.path by
  // stripping "hw:" and any leading digits and comma, so "hw:S3,0" came out
  // "S3,0" (the duplicate of FPP's own S3 node stayed) and "hw:1,0" came out
  // "0" (card 1's node was dropped as a duplicate of card 0's).
  startPipeWire({ objects: [
    nullSink('fpp_alsa_s3', { 'api.alsa.path': 'hw:S3' }),
    nullSink('fpp_alsa_0', { 'api.alsa.path': 'hw:0' }),
    nullSink('alsa_output.usb-fpp_tests_s3-00.analog-stereo', { 'api.alsa.path': 'hw:S3,0' }),
    nullSink('alsa_output.platform-fpp_tests_card0.stereo', { 'api.alsa.path': 'front:0,0' }),
    nullSink('alsa_output.platform-fpp_tests_card1.stereo', { 'api.alsa.path': 'hw:1,0' }),
  ] });

  const names = (await graph(request)).nodes.map((n) => n.name);
  expect(names).toContain('fpp_alsa_s3');
  expect(names).toContain('fpp_alsa_0');
  expect(names, 'the S3 duplicate is still drawn').not.toContain('alsa_output.usb-fpp_tests_s3-00.analog-stereo');
  expect(names).not.toContain('alsa_output.platform-fpp_tests_card0.stereo');
  expect(names, 'card 1, which FPP does not drive, was dropped').toContain('alsa_output.platform-fpp_tests_card1.stereo');
});
