import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, exists, readFile } from './pw-helpers';

// VBAN (VB-Audio Network) streams: the instance API, the PipeWire modules
// generated from it, and Reset Config's audio area clearing them.
// Feature: 8e9b21c9e.  The container runs no PipeWire, so only what the PHP
// side stores and generates is checked.

test.skip(!container, 'reads the generated config inside the run-web.sh container');

test.afterEach(cleanupPipeWire);

const CONF = `${CONFIG}/pipewire-vban.conf`;
const ETC_CONF = '/etc/pipewire/pipewire.conf.d/94-fpp-vban.conf';

async function save(request: APIRequestContext, instances: unknown[]) {
  return request.post('/api/pipewire/vban/instances', { data: { instances } });
}

async function apply(request: APIRequestContext) {
  const r = await request.post('/api/pipewire/vban/apply', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  await settleAfterApply(request);
}

// The text of the module block that starts with `name = <module>`.
function moduleBlock(conf: string, module: string): string {
  const at = conf.indexOf(`name = ${module}`);
  expect(at, `no ${module} in:\n${conf}`).toBeGreaterThan(-1);
  const next = conf.indexOf('{ name = libpipewire-module', at + 1);
  return conf.slice(at, next === -1 ? undefined : next);
}

test('instances are saved with defaults and generate one module per direction', async ({ request }) => {
  const r = await save(request, [
    { name: 'Desk In', mode: 'receive', streamName: 'Stream1', enabled: true },
    { name: 'Desk Out', mode: 'send', destIP: '192.0.2.10', port: 6990, enabled: true },
    { name: 'Bad Dest', mode: 'send', destIP: 'not-an-address', port: 6991, enabled: true },
  ]);
  expect(r.ok(), await r.text()).toBe(true);

  const got = await (await request.get('/api/pipewire/vban/instances')).json();
  expect(got.instances.map((i: any) => i.name)).toEqual(['Desk In', 'Desk Out', 'Bad Dest']);
  const recv = got.instances[0];
  expect(recv.id).toBe(1);
  expect(recv.port).toBe(6980);
  expect(recv.latency).toBe(100);
  expect(recv.dscp).toBe(34);
  expect(recv.sourceIP).toBe('0.0.0.0');

  await apply(request);
  const conf = readFile(CONF);
  expect(readFile(ETC_CONF), 'the conf PipeWire loads differs from the saved copy').toBe(conf);

  const rx = moduleBlock(conf, 'libpipewire-module-vban-recv');
  expect(rx).toMatch(/source\.port = 6980\n/);
  expect(rx).toContain('sess.name = "Stream1"');
  expect(rx).toContain('node.name = "vban_desk_in_recv"');
  expect(rx).toContain('media.class = "Audio/Source"');

  const tx = moduleBlock(conf, 'libpipewire-module-vban-send');
  expect(tx).toMatch(/destination\.ip = 192\.0\.2\.10\n/);
  expect(tx).toMatch(/destination\.port = 6990\n/);
  expect(tx).toContain('node.name = "vban_desk_out_send"');
  // Nothing feeds a sender until an output group member names it.
  expect(tx).toContain('node.autoconnect = false');
  // A destination that is not an address is skipped: it is written unquoted.
  expect(conf).not.toContain('not-an-address');
  expect(conf.match(/libpipewire-module-vban-send/g)?.length).toBe(1);

  const status = await request.get('/api/pipewire/vban/status');
  expect(status.ok(), await status.text()).toBe(true);
  expect((await status.json()).instances.length).toBe(3);
  const ifaces = await request.get('/api/pipewire/vban/interfaces');
  expect(ifaces.ok(), await ifaces.text()).toBe(true);
  expect(Array.isArray(await ifaces.json())).toBe(true);

  // Nothing enabled any more: the conf goes away rather than staying loaded.
  expect((await save(request, [{ name: 'Desk In', mode: 'receive', enabled: false }])).ok()).toBe(true);
  await apply(request);
  expect(exists(CONF)).toBe(false);
  expect(exists(ETC_CONF)).toBe(false);
});

test('streams that could not be told apart are refused', async ({ request }) => {
  const twoSenders = await save(request, [
    { name: 'A', mode: 'send', destIP: '192.0.2.10', port: 6980, enabled: true },
    { name: 'B', mode: 'send', destIP: '192.0.2.10', port: 6980, enabled: true },
  ]);
  expect(twoSenders.status()).toBe(400);
  expect((await twoSenders.json()).message).toContain('both send to');

  const twoCatchAll = await save(request, [
    { name: 'A', mode: 'receive', port: 6980, streamName: '', enabled: true },
    { name: 'B', mode: 'receive', port: 6980, streamName: 'Named', enabled: true },
  ]);
  expect(twoCatchAll.status()).toBe(400);

  // Distinct stream names share a port, in one socket.
  const shared = await save(request, [
    { name: 'A', mode: 'receive', port: 6980, streamName: 'One', enabled: true },
    { name: 'B', mode: 'receive', port: 6980, streamName: 'Two', enabled: true },
  ]);
  expect(shared.ok(), await shared.text()).toBe(true);
  await apply(request);
  const conf = readFile(CONF);
  expect(conf.match(/libpipewire-module-vban-recv/g)?.length, conf).toBe(1);
  expect(conf).toContain('vban_a_recv');
  expect(conf).toContain('vban_b_recv');
});

test('Reset Config clears the VBAN streams with the audio backend', async ({ request }) => {
  expect((await save(request, [{ name: 'Desk In', mode: 'receive', enabled: true }])).ok()).toBe(true);
  await apply(request);
  expect(exists(CONF), 'nothing to reset, so this proves nothing').toBe(true);
  const backend = await (await request.get('/api/settings/MediaBackend')).json();
  try {
    const r = await request.get('/resetConfig.php?areas=audiobackend', { timeout: 120_000 });
    expect(r.ok()).toBe(true);
    expect(await r.text()).toContain('Area: audiobackend');
    await settleAfterApply(request);
    expect(exists(`${CONFIG}/pipewire-vban-instances.json`)).toBe(false);
    expect(exists(CONF)).toBe(false);
    expect(exists(ETC_CONF)).toBe(false);
  } finally {
    // The reset also sets the backend back to its default; leave it as found.
    if (backend && typeof backend.value === 'string') {
      await request.put('/api/settings/MediaBackend', { data: backend.value });
    }
  }
});
