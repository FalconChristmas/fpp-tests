import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The AES67 page and its API.  AES67Manager runs in fppd only under
// MediaBackend "pipewire"; the player has no PipeWire running, so a send
// stream fails to start at once, but its config, SDP and apply path all work
// without one.

const CONFIG = '/home/fpp/media/config/pipewire-aes67-instances.json';
const INSTANCE = {
  id: 1, name: 'fpp-tests tx', mode: 'send', enabled: true, sapEnabled: false,
  multicastIP: '239.69.0.9', port: 5004, channels: 2, ptime: 1,
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await request.put('/api/settings/MediaBackend', { data: 'pipewire' });
});

test.afterAll(async ({ request }) => {
  if (container) inPlayer('rm', '-f', CONFIG);
  await request.post('/api/pipewire/aes67/apply', { timeout: 120_000 });
  await request.put('/api/settings/MediaBackend', { data: 'pipewire-simple' });
  await request.put('/api/settings/rebootFlag', { data: '0' });
});

test('a send instance is applied and exported as SDP through the API', async ({ request }) => {
  // Feature: a33868385 (SDP export).  87594a379: the apply reaches fppd
  // directly and reports its success as success.
  const save = await request.post('/api/pipewire/aes67/instances', {
    data: { ptpEnabled: false, ptpInterface: 'lo', instances: [INSTANCE] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/aes67/apply', { timeout: 120_000 });
  const applied = await apply.json();
  expect(applied.status, JSON.stringify(applied)).toBe('OK');

  const list = await (await request.get('/api/pipewire/aes67/sdp')).json();
  expect(list.status).toBe('OK');
  expect(list.streams.map((s: any) => s.instanceId)).toEqual([1]);
  expect(list.streams[0].sdp).toContain('c=IN IP4 239.69.0.9/');

  const file = await request.get('/api/pipewire/aes67/sdp/1');
  expect(file.status()).toBe(200);
  const h = file.headers();
  expect(h['content-type']).toContain('application/sdp');
  expect(h['content-disposition']).toContain('filename="fpp-tests_tx.sdp"');
  // A year-long Expires from Apache would keep a stale description around.
  expect(h['cache-control']).toContain('no-store');
  expect(await file.text()).toBe(list.streams[0].sdp);

  expect((await request.get('/api/pipewire/aes67/sdp/99')).status()).toBe(404);
});

test('a failed apply reports fppd\'s own error, not an unreachable fppd', async ({ request }) => {
  // Regression: 87594a379.  The apply went through Apache back to
  // /api/command with a 10 s timeout, and any failure -- a slow apply or an
  // error from fppd -- came back as "Failed to signal fppd - is it running?".
  test.skip(!container, 'writes a broken config inside the run-web.sh container');
  inPlayer('sh', '-c', `echo '{"instances": [' > ${CONFIG}`);
  const apply = await request.post('/api/pipewire/aes67/apply', { timeout: 120_000 });
  const body = await apply.json();
  expect(body.status, JSON.stringify(body)).toBe('ERROR');
  expect(body.message).toContain('AES67 apply failed');
  expect(body.message).not.toContain('Failed to signal fppd');
});

test('an instance stored without a packet time shows 1 ms, as fppd uses', async ({ page }) => {
  // Regression: a6a6ba663.  The page showed 4 ms for an instance stored with
  // no ptime, while fppd falls back to 1 ms (312d823c6).
  test.skip(!container, 'writes the stored config inside the run-web.sh container');
  const stored = { ...INSTANCE } as any;
  delete stored.ptime;
  inPlayer('sh', '-c', `cat > ${CONFIG} <<'EOF'\n${JSON.stringify({ ptpEnabled: false, instances: [stored] })}\nEOF`);
  await page.goto('/aes67-config.php');
  const ptime = page.locator('select[onchange*="\'ptime\'"]').first();
  await expect(ptime).toHaveValue('1');
});

test('an instance saved through the API without a packet time gets 1 ms', async ({ request }) => {
  // Regression: c0ba73cc4.  The save filled a missing ptime with 4 ms, the
  // old default, while fppd and the page use 1 ms.
  const stored = { ...INSTANCE } as any;
  delete stored.ptime;
  const save = await request.post('/api/pipewire/aes67/instances', {
    data: { ptpEnabled: false, ptpInterface: 'lo', instances: [stored] },
  });
  expect(save.ok(), await save.text()).toBe(true);
  const saved = await (await request.get('/api/pipewire/aes67/instances')).json();
  expect(saved.instances[0].ptime).toBe(1);
});
