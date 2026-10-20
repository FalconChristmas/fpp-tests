import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import type { APIRequestContext } from '@playwright/test';
import { EVIL, cleanup, injected, readConf, seedOutputGroup, settleAfterApply } from './pipewire-conf';

// Names saved for audio groups, input groups and VBAN streams are written into
// SPA-JSON drop-ins under /etc/pipewire/pipewire.conf.d, which a root PipeWire
// daemon loads, and it honours context.exec.  Fixed in fpp 18e79cb4e
// ("fix(security): keep user strings from breaking out of PipeWire configs");
// before it a quote or a line break in a name closed the string or the
// "# ..." comment it was written into, and the rest of the name became config
// of its own.  Only the generated text is checked (the Apply endpoints keep a
// copy under config/), so no sound card is needed.

test.skip(!container, 'reads the generated config inside the run-web.sh container');

test.afterEach(cleanup);

test('an input group name stays inside its strings and comments', async ({ request }) => {
  seedOutputGroup();
  const save = await request.post('/api/pipewire/audio/input-groups', {
    data: { inputGroups: [{ id: 1, name: EVIL, enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  const conf = readConf('pipewire-input-groups.conf');
  // The control: the group was generated, not skipped.
  expect(conf).toContain('fpp-tests');
  expect(conf).toMatch(/node\.description\s*=/);
  expect(injected(conf), conf).toEqual([]);
});

test('a VBAN stream name stays inside its strings and comments', async ({ request }) => {
  const save = await request.post('/api/pipewire/vban/instances', {
    data: { instances: [{ id: 1, name: EVIL, streamName: EVIL, mode: 'receive', enabled: true, channels: 2 }] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/vban/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  const conf = readConf('pipewire-vban.conf');
  expect(conf).toContain('libpipewire-module-vban-recv');
  expect(injected(conf), conf).toEqual([]);
});

test('an audio group name is stored the way the generator writes it', async ({ request }) => {
  const save = await request.post('/api/pipewire/audio/groups', {
    data: { groups: [{ id: 1, name: EVIL, enabled: true, channels: 2, members: [] }] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const stored = JSON.parse(readConf('pipewire-audio-groups.json'));
  expect(stored.groups[0].name).toContain('fpp-tests');
  expect(stored.groups[0].name).not.toMatch(/["\n\\]/);
});

// 18e79cb4e sanitized at the top of each generator, but the input group
// generator reads the Opus RTP (and VBAN) instance file again for a member
// saved without a name, as the UI saves one, and wrote the instance name into
// "# Loopback: ..." and node.description as it was; the Opus RTP saver stored
// it as given.  Regression: 83ebbd1ff ("fix(security): keep Opus RTP instance
// names from breaking out of PipeWire configs").

async function applyOpusMember(request: APIRequestContext) {
  seedOutputGroup();
  const save = await request.post('/api/pipewire/audio/input-groups', {
    data: { inputGroups: [{ id: 1, name: 'fpp-tests in', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'opus_rtp_receive', instanceId: 1, name: '' }] }] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
  const conf = readConf('pipewire-input-groups.conf');
  expect(conf, 'the Opus member was not generated').toContain('Opus RTP');
  return conf;
}

test('an Opus RTP instance name stays inside the input group config', async ({ request }) => {
  const opus = await request.post('/api/pipewire/opusrtp/instances', {
    data: { instances: [{ id: 1, name: EVIL, mode: 'receive', enabled: true }] },
  });
  expect(opus.ok(), await opus.text()).toBe(true);
  const stored = JSON.parse(readConf('pipewire-opus-rtp-instances.json'));
  expect(stored.instances[0].name).not.toMatch(/["\n\\]/);
  const conf = await applyOpusMember(request);
  expect(injected(conf), conf).toEqual([]);
});

test('an Opus RTP instance file saved as it was stays inside the input group config', async ({ request }) => {
  // As a file saved before the saver sanitized names.
  const legacy = Buffer.from(JSON.stringify({ instances: [{ id: 1, name: EVIL, mode: 'receive', enabled: true }] }));
  inPlayer('sh', '-c', `echo ${legacy.toString('base64')} | base64 -d > /home/fpp/media/config/pipewire-opus-rtp-instances.json`);
  expect(JSON.parse(readConf('pipewire-opus-rtp-instances.json')).instances[0].name).toBe(EVIL);
  const conf = await applyOpusMember(request);
  expect(injected(conf), conf).toEqual([]);
});
