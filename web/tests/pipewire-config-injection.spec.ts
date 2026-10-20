import { test, expect } from './fixtures';
import { container } from './container';
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
