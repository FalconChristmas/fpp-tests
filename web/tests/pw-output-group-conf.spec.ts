import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { stopPipeWire } from './pw-live';
import { channels, describe, graph, loadGeneratedConf, props, reaches, standInNode } from './pw-load';
import { settleAfterApply } from './pipewire-conf';
import {
  CONFIG, cleanupPipeWire, fakeSoundCards, hwParams, readFile, sinkNode, standInAplay,
  standInCommand, standInPwDump, writeFile,
} from './pw-helpers';

// What Save & Apply of PipeWire audio output groups generates
// (97-fpp-audio-groups.conf) for the cards behind its members: which sink
// each member plays to, and the ALSA adapter FPP declares itself when no
// existing sink will do.  The container has no sound card and no PipeWire,
// so the cards are fakes under /proc/asound (fakeSoundCards), the graph is a
// stand-in pw-dump, and each card's ALSA capabilities a stand-in aplay.
//
// Then the receiving end: the conf is loaded by a real PipeWire (pw-load.ts)
// with null sinks standing in for the cards' sinks, and the real pw-dump has
// to show the group sink reaching each card.  FPP's own ALSA adapters cannot
// open a card here, so they are loaded as null sinks with the conf's own
// properties: their channels, layout and rate are checked, the ALSA side
// (api.alsa.path, period size, the format on the wire) is not.

test.skip(!container, 'stubs sound cards and reads the generated config inside the run-web.sh container');

test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
});

// Wait for the real graph to reach every [from, to] pair.
async function expectReaches(pairs: [string, string][]) {
  await expect.poll(() => {
    const g = graph();
    return pairs.filter(([a, b]) => !reaches(g, a, b)).map(([a, b]) => `${a} -> ${b}`);
  }, { timeout: 10_000, message: `not linked up:\n${describe(graph())}` }).toEqual([]);
}

const CONF = '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf';

// A WirePlumber sink for ALSA card `card`, as pw-dump lists it.
function wpSink(id: number, name: string, card: number, extra: Record<string, unknown> = {}) {
  return sinkNode(id, name, { 'alsa.card': card, ...extra });
}

// pw-cli list-objects Node for the same sinks: the first generator read the
// graph from it rather than pw-dump.
function standInPwCli(names: string[]) {
  const text = names.map((n, i) => `\tid ${40 + i}, type PipeWire:Interface:Node/3\n` +
    `\t\tnode.name = "${n}"\n\t\tmedia.class = "Audio/Sink"\n`).join('');
  writeFile('/tmp/fpp-tests-pw-cli.txt', text);
  standInCommand('pw-cli', 'cat /tmp/fpp-tests-pw-cli.txt\n');
}

async function applyGroups(request: APIRequestContext, groups: unknown[]): Promise<string> {
  const save = await request.post('/api/pipewire/audio/groups', { data: { groups } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  return readFile(CONF);
}

// The { factory = adapter ... } object for node `name`, as text.
function adapter(conf: string, name: string): string {
  const at = conf.indexOf(`node.name = "${name}"`);
  expect(at, `no adapter ${name} was generated:\n${conf}`).toBeGreaterThan(-1);
  const start = conf.lastIndexOf('{ factory = adapter', at);
  expect(start, `${name} is not an adapter:\n${conf}`).toBeGreaterThan(-1);
  return conf.slice(start, conf.indexOf('\n  }', at));
}

function value(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^\\s*${key.replace(/\./g, '\\.')}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

test('an output group saved through the API becomes a combine-stream sink over its cards', async ({ request }) => {
  // Feature: a5af59a02. Audio output groups: saved and read back through
  // /api/pipewire/audio/groups, and Apply writes a combine-stream sink named
  // for the group that fans out to each member card's sink.
  fakeSoundCards([{ id: 'A' }, { id: 'B' }]);
  standInPwDump([wpSink(40, 'alsa_output.fpp_card0', 0), wpSink(41, 'alsa_output.fpp_card1', 1)]);
  standInPwCli(['alsa_output.fpp_card0', 'alsa_output.fpp_card1']);
  const groups = [{ id: 1, name: 'Both', enabled: true, channels: 2,
    members: [{ cardId: 'A', channels: 2 }, { cardId: 'B', channels: 2 }] }];
  const save = await request.post('/api/pipewire/audio/groups', { data: { groups } });
  expect(save.ok(), await save.text()).toBe(true);
  const got = await request.get('/api/pipewire/audio/groups');
  expect(got.ok(), await got.text()).toBe(true);
  const back = (await got.json()).groups;
  expect(back.map((g: any) => [g.name, g.members.map((m: any) => m.cardId)])).toEqual([['Both', ['A', 'B']]]);

  const conf = await applyGroups(request, groups);
  expect(conf).toContain('libpipewire-module-combine-stream');
  expect(conf).toMatch(/combine\.mode\s*=\s*sink/);
  expect(conf).toContain('node.name = "fpp_group_both"');
  // Each card's sink is reached, by a stream rule matching it or through the
  // member's filter chain.
  expect(conf).toMatch(/node\.(name|target) = "alsa_output\.fpp_card0"/);
  expect(conf).toMatch(/node\.(name|target) = "alsa_output\.fpp_card1"/);

  // In a real PipeWire: the group is a sink, and what plays into it reaches both cards.
  loadGeneratedConf([standInNode('alsa_output.fpp_card0'), standInNode('alsa_output.fpp_card1')], ['fpp_group_both']);
  expect(props(graph(), 'fpp_group_both')['media.class']).toBe('Audio/Sink');
  await expectReaches([['fpp_group_both', 'alsa_output.fpp_card0'], ['fpp_group_both', 'alsa_output.fpp_card1']]);
});

test('a card with no PipeWire sink gets an FPP ALSA adapter instead of being skipped', async ({ request }) => {
  // Regression: a5dacf473. A card that is present but has no PipeWire sink
  // (an HDMI port whose WirePlumber profile is off) was dropped from its
  // group ("no PipeWire sink found"), and a group of only such cards was not
  // generated at all.  Now, if the PCM opens, FPP declares an api.alsa.pcm.sink
  // adapter for it and the group plays through that.
  fakeSoundCards([{ id: 'X' }]);
  standInPwDump([]);
  standInAplay({ 'hw:X': hwParams() });
  const conf = await applyGroups(request, [{ id: 1, name: 'Out', enabled: true, channels: 2,
    members: [{ cardId: 'X', channels: 2 }] }]);
  const a = adapter(conf, 'fpp_alsa_x');
  expect(value(a, 'factory.name'), a).toBe('api.alsa.pcm.sink');
  expect(value(a, 'api.alsa.path'), a).toBe('"hw:X"');
  expect(conf).toContain('node.name = "fpp_group_out"');
  expect(conf).toContain('node.target = "fpp_alsa_x"');
  expect(conf).not.toContain('WARNING');

  loadGeneratedConf([], ['fpp_group_out', 'fpp_alsa_x'], { nullAdapters: true });
  expect(channels(graph(), 'fpp_alsa_x', 'input')).toEqual(['FL', 'FR']);
  await expectReaches([['fpp_group_out', 'fpp_alsa_x']]);
});

// A 6-channel member on card A and on card B, each of which has only a
// WirePlumber (stereo) sink, and the ALSA rates aplay reports for them.
async function sixChannelGroup(request: APIRequestContext, rates: { A: string; B: string }) {
  fakeSoundCards([{ id: 'A' }, { id: 'B' }]);
  standInPwDump([wpSink(40, 'alsa_output.card_a.analog-stereo', 0), wpSink(41, 'alsa_output.card_b.analog-stereo', 1)]);
  standInAplay({
    'hw:A': hwParams({ channels: '6', rate: rates.A }),
    'hw:B': hwParams({ channels: '6', rate: rates.B }),
  });
  return applyGroups(request, [{ id: 1, name: 'Surround', enabled: true, channels: 6,
    members: [{ cardId: 'A', channels: 6 }, { cardId: 'B', channels: 6 }] }]);
}

test('a member wider than stereo gets an adapter that opens the card with all its channels', async ({ request }) => {
  // Regression: ff5baa9c6. A 6-channel member played through the card's
  // WirePlumber node, which is stereo, so only the front pair was driven.
  // Now FPP declares its own adapter for the card with the member's channel
  // count and layout, and the member's filter chain plays to it.
  const conf = await sixChannelGroup(request, { A: '48000', B: '48000' });
  const a = adapter(conf, 'fpp_alsa_a');
  expect(value(a, 'audio.channels'), a).toBe('6');
  expect(value(a, 'audio.position'), a).toBe('[ FL FR FC LFE RL RR ]');
  expect(value(a, 'api.alsa.path'), a).toBe('"hw:A"');
  expect(conf).toContain('node.target = "fpp_alsa_a"');
  expect(conf, 'the member still plays to the stereo node').not.toContain('node.target = "alsa_output.card_a.analog-stereo"');

  loadGeneratedConf([standInNode('alsa_output.card_a.analog-stereo'), standInNode('alsa_output.card_b.analog-stereo')],
    ['fpp_group_surround', 'fpp_alsa_a', 'fpp_alsa_b'], { nullAdapters: true });
  const g = graph();
  expect(channels(g, 'fpp_alsa_a', 'input')).toEqual(['FL', 'FR', 'FC', 'LFE', 'RL', 'RR']);
  expect(channels(g, 'fpp_group_surround', 'input')).toEqual(['FL', 'FR', 'FC', 'LFE', 'RL', 'RR']);
  await expectReaches([['fpp_group_surround', 'fpp_alsa_a'], ['fpp_group_surround', 'fpp_alsa_b']]);
  expect(reaches(graph(), 'fpp_group_surround', 'alsa_output.card_a.analog-stereo'), 'the stereo node is still fed').toBe(false);
});

test("an FPP adapter runs at a rate the card supports, read from its ALSA hw params", async ({ request }) => {
  // Regression: 64c8bcc8b. The adapter's rate came from the global
  // AudioFormat setting (44100 by default) whatever the card supports.  It
  // is now the best of PipeWire's allowed rates (44100/48000/96000) that the
  // card's hw params list -- a set, a range, or a single rate.
  // Regression: 6725aac37. In between (40ae2a523 dropped the lookup) the
  // adapter was written with "audio.rate = 0".
  const conf = await sixChannelGroup(request, { A: '{ 44100 48000 }', B: '[88200 192000]' });
  expect(value(adapter(conf, 'fpp_alsa_a'), 'audio.rate')).toBe('48000');
  expect(value(adapter(conf, 'fpp_alsa_b'), 'audio.rate')).toBe('96000');

  // The rate as the real PipeWire took it for the node it built.
  loadGeneratedConf([standInNode('alsa_output.card_a.analog-stereo'), standInNode('alsa_output.card_b.analog-stereo')],
    ['fpp_alsa_a', 'fpp_alsa_b'], { nullAdapters: true });
  const g = graph();
  const rate = (n: string) => g.nodes.get(n)?.info?.params?.EnumFormat?.[0]?.rate;
  expect([rate('fpp_alsa_a'), rate('fpp_alsa_b')]).toEqual([48000, 96000]);
});

test('an IEC958-only card is opened through sysdefault: rather than dropped', async ({ request }) => {
  // Regression: 13507edfb. Some HDMI ports (vc4-hdmi under KMS) offer only
  // IEC958_SUBFRAME_LE on hw:, so the card was judged to have no PCM format
  // and skipped -- and an adapter on that hw: device crashes PipeWire when it
  // probes for a passthrough variant.  sysdefault: converts; it is used when
  // it offers a PCM format.
  fakeSoundCards([{ id: 'vc4hdmi0' }]);
  standInPwDump([]);
  standInAplay({
    'hw:vc4hdmi0': hwParams({ format: 'IEC958_SUBFRAME_LE' }),
    'sysdefault:vc4hdmi0': hwParams({ format: 'S16_LE' }),
  });
  const conf = await applyGroups(request, [{ id: 1, name: 'Hdmi', enabled: true, channels: 2,
    members: [{ cardId: 'vc4hdmi0', channels: 2 }] }]);
  const a = adapter(conf, 'fpp_alsa_vc4hdmi0');
  expect(value(a, 'api.alsa.path'), a).toBe('"sysdefault:vc4hdmi0"');
  expect(conf).toContain('node.target = "fpp_alsa_vc4hdmi0"');

  // Not checked: that sysdefault: opens where hw: crashes PipeWire (no card).
  // Checked: the adapter node is built with that path and the group feeds it.
  loadGeneratedConf([], ['fpp_group_hdmi', 'fpp_alsa_vc4hdmi0'], { nullAdapters: true });
  expect(props(graph(), 'fpp_alsa_vc4hdmi0')['api.alsa.path']).toBe('sysdefault:vc4hdmi0');
  await expectReaches([['fpp_group_hdmi', 'fpp_alsa_vc4hdmi0']]);
});

test("a member's sample rate and period size get an adapter of their own, even in stereo", async ({ request }) => {
  // Feature: 6725aac37. sampleRate and periodSize on a group member: a stereo
  // member that sets either is given a custom ALSA adapter with them, where
  // before only a member wider than stereo got an adapter.
  fakeSoundCards([{ id: 'A' }]);
  standInPwDump([wpSink(40, 'alsa_output.card_a.analog-stereo', 0)]);
  standInAplay({ 'hw:A': hwParams({ rate: '{ 44100 48000 96000 }' }) });
  const conf = await applyGroups(request, [{ id: 1, name: 'Out', enabled: true, channels: 2,
    members: [{ cardId: 'A', channels: 2, sampleRate: 96000, periodSize: 256 }] }]);
  const a = adapter(conf, 'fpp_alsa_a');
  expect(value(a, 'audio.rate'), a).toBe('96000');
  expect(value(a, 'api.alsa.period-size'), a).toBe('256');
  expect(value(a, 'audio.channels'), a).toBe('2');

  // The rate as PipeWire built the node; the period size only means something
  // to ALSA, so it is only seen to arrive as a property.
  loadGeneratedConf([standInNode('alsa_output.card_a.analog-stereo')], ['fpp_group_out', 'fpp_alsa_a'], { nullAdapters: true });
  const g = graph();
  expect(g.nodes.get('fpp_alsa_a')?.info?.params?.EnumFormat?.[0]?.rate).toBe(96000);
  expect(props(g, 'fpp_alsa_a')['api.alsa.period-size']).toBe(256);
  await expectReaches([['fpp_group_out', 'fpp_alsa_a']]);
});

test('an AES67 send instance is a member like a card', async ({ request }) => {
  // Regression: e0cb861ca. The generator looked the instance up under
  // $settings['mediaDirectory'] without declaring $settings global, so it
  // never found the instances file: every AES67 member was skipped as "not
  // found or disabled", and a group of only AES67 members was not generated.
  writeFile(`${CONFIG}/pipewire-aes67-instances.json`, {
    instances: [{ id: 1, name: 'Stage', mode: 'send', enabled: true, channels: 2 }],
  });
  try {
    const conf = await applyGroups(request, [{ id: 1, name: 'Network', enabled: true, channels: 2,
      members: [{ cardId: 'aes67_1', channels: 2 }] }]);
    expect(conf).not.toContain('AES67 instance not found');
    expect(conf).toContain('node.name = "fpp_group_network"');
    expect(conf).toMatch(/node\.(name|target) = "aes67_stage_send"/);

    // fppd's AES67 sender is a sink of its own; a null sink stands in for it.
    loadGeneratedConf([standInNode('aes67_stage_send')], ['fpp_group_network']);
    await expectReaches([['fpp_group_network', 'aes67_stage_send']]);
  } finally {
    inPlayer('rm', '-f', `${CONFIG}/pipewire-aes67-instances.json`);
  }
});
