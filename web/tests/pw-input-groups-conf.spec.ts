import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';

// What pipewire.php generates for input groups (mix buses) and output groups:
// the channel layouts at each end of a path, and the nofail flag on every
// object.  The Apply endpoints keep a copy of what they wrote under config/,
// which is what is read here; no sound card or PipeWire daemon is needed.

test.skip(!container, 'reads the generated config inside the run-web.sh container');

test.afterEach(cleanupPipeWire);

// Output groups as saved config: applying them for real needs a sound card.
function seedOutputGroups(groups: { id: number; name: string; channels: number }[]) {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: groups.map((g) => ({ ...g, enabled: true, members: [] })),
  });
}

async function applyInputGroups(request: APIRequestContext, inputGroups: unknown[]): Promise<string> {
  const save = await request.post('/api/pipewire/audio/input-groups', { data: { inputGroups } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  return readFile(`${CONFIG}/pipewire-input-groups.conf`);
}

// The create-stream block of the stream.rules entry that targets `sink`.
function createStream(conf: string, sink: string): string {
  const at = conf.indexOf(`node.target = "${sink}"`);
  expect(at, `no stream rule targets ${sink}:\n${conf}`).toBeGreaterThan(-1);
  return conf.slice(at, conf.indexOf('}', at));
}

function value(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^\\s*${key.replace(/\./g, '\\.')}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

test('a path between groups of different widths maps the channels they share', async ({ request }) => {
  // Regression: 8696025a5. Both ends of an input group's stream to an output
  // group took the OUTPUT group's layout: a stereo bus feeding an 8-channel
  // group asked its own combine sink for FC/LFE/RL/RR/SL/SR it does not have,
  // and the path carried silence.  A mono bus shares no position with stereo,
  // so it gets its own layout and remixing switched back on.
  seedOutputGroups([{ id: 1, name: 'Eight', channels: 8 }, { id: 2, name: 'Pair', channels: 2 }]);
  const conf = await applyInputGroups(request, [
    { id: 1, name: 'Stereo bus', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
    { id: 2, name: 'Mono bus', enabled: true, channels: 1, outputs: [2],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_2' }] },
  ]);
  const wide = createStream(conf, 'fpp_group_eight');
  expect(value(wide, 'combine.audio.position'), wide).toBe('[ FL FR ]');
  expect(value(wide, 'audio.position'), wide).toBe('[ FL FR ]');
  expect(value(wide, 'stream.dont-remix'), wide).toBeUndefined();

  const mono = createStream(conf, 'fpp_group_pair');
  expect(value(mono, 'combine.audio.position'), mono).toBe('[ MONO ]');
  expect(value(mono, 'audio.position'), mono).toBe('[ MONO ]');
  expect(value(mono, 'stream.dont-remix'), mono).toBe('false');
});

test('a mono source into a stereo bus has each end of its loopback pinned', async ({ request }) => {
  // Regression: c266cf5d1. With no mapping picked, neither end of a member's
  // loopback said how many channels it had: both defaulted to stereo while the
  // capture side carried stream.dont-remix, so a mono source (a plugin's LTC
  // node) lined up with neither FL nor FR and the member passed silence.
  seedOutputGroups([{ id: 1, name: 'Out', channels: 2 }]);
  const conf = await applyInputGroups(request, [
    { id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'pw_source', name: 'Mono src', nodeName: 'fpp_tests_mono', channels: 1 }] },
  ]);
  const start = conf.indexOf('# Loopback: Mono src');
  expect(start, conf).toBeGreaterThan(-1);
  const loop = conf.slice(start, conf.indexOf('libpipewire-module-loopback', start + 40) + 1 || undefined);
  const capture = loop.slice(loop.indexOf('capture.props'), loop.indexOf('playback.props'));
  const playback = loop.slice(loop.indexOf('playback.props'));
  expect(value(capture, 'node.target'), capture).toBe('"fpp_tests_mono"');
  expect(value(capture, 'audio.channels'), capture).toBe('1');
  expect(value(capture, 'audio.position'), capture).toBe('[ MONO ]');
  expect(value(playback, 'audio.channels'), playback).toBe('2');
  expect(value(playback, 'audio.position'), playback).toBe('[ FL FR ]');
});

// Every { factory = adapter ... } object in a context.objects list, as text.
function objects(conf: string): string[] {
  const out: string[] = [];
  let at = conf.indexOf('context.objects');
  while ((at = conf.indexOf('{ factory = adapter', at)) !== -1) {
    // Up to the next object or the end of the list.
    const next = conf.indexOf('{ factory = adapter', at + 1);
    const end = conf.indexOf('\n]', at);
    out.push(conf.slice(at, next !== -1 && next < end ? next : end));
    at += 1;
  }
  return out;
}

test('every object the generators create carries nofail', async ({ request }) => {
  // Regression: 1f848df41. context.objects entries are mandatory by default:
  // one that fails to open (an adapter for an HDMI monitor that is switched
  // off) makes the PipeWire daemon exit, and systemd restarts it forever.
  // nofail skips just that object.  Two of them need no sound card: the tee
  // that fans one fppd stream out to two mix buses, and the null sink an output
  // group of only the dummy card becomes.
  seedOutputGroups([{ id: 1, name: 'Out', channels: 2 }]);
  const igConf = await applyInputGroups(request, [
    { id: 1, name: 'Bus A', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
    { id: 2, name: 'Bus B', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
  ]);
  const tees = objects(igConf);
  expect(tees.length, `the tee was not generated, so this proves nothing:\n${igConf}`).toBe(1);
  expect(tees[0]).toContain('fpp_tee_fppd_stream_1');
  expect(tees[0], tees[0]).toContain('flags = [ nofail ]');

  const save = await request.post('/api/pipewire/audio/groups', {
    data: { groups: [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [{ cardId: 'Dummy', channels: 2 }] }] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  const ogConf = readFile(`${CONFIG}/pipewire-audio-groups.conf`);
  const sinks = objects(ogConf);
  expect(sinks.length, `no null sink was generated, so this proves nothing:\n${ogConf}`).toBe(1);
  expect(sinks[0]).toContain('support.null-audio-sink');
  expect(sinks[0], sinks[0]).toContain('flags = [ nofail ]');
});
