import { test, expect } from './fixtures';
import http from 'http';
import { container, inPlayer } from './container';

// Assorted inputs that were taken as given, fixed together in fpp 1160d126d
// ("fix(security): assorted low-severity hardening from the web UI review"):
//   - a schedule save that is not a JSON array of entries was written anyway,
//     leaving the player with no schedule;
//   - the /proxy WebSocket rule proxied to 127.x and 0.x, which then arrive
//     from the local address that "Require local" lets through;
//   - ping.php passed a host starting with '-' to ping, as an option;
//   - an event id went into an fppd URL as limonade had decoded it, so a ?
//     or # in it reached fppd as more URL than an id;
//   - saving PipeWire video sources wrote the saved config (credentials in
//     stream URLs included) to a fixed file in /tmp.

test('a schedule that is not a list of entries is refused', async ({ request }) => {
  const before = await (await request.get('/api/schedule')).text();
  try {
    for (const body of ['{"x": 1}', '[1']) {
      // A Buffer, sent as is: Playwright would treat a string as JSON to encode.
      const r = await request.post('/api/schedule', { headers: { 'Content-Type': 'application/json' }, data: Buffer.from(body) });
      expect(r.status(), body).toBe(400);
      expect(await (await request.get('/api/schedule')).text(), body).toBe(before);
    }
  } finally {
    await request.post('/api/schedule', { headers: { 'Content-Type': 'application/json' }, data: Buffer.from(before) });
  }
});

test('the WebSocket proxy does not reach the player itself', async ({ baseURL }) => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.get(new URL('/proxy/127.0.0.1/api/fppd/status', baseURL), {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'ZnBwLXRlc3RzLWtleS0xMjM0' },
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timed out')));
  });
  expect(status).toBe(404);
});

test('ping takes a host, not an option', async ({ request }) => {
  // The control: a real address is pinged.
  expect(await (await request.get('/ping.php?ip=127.0.0.1&count=1')).text()).toContain('127.0.0.1');

  const body = await (await request.get('/ping.php?ip=-V&count=1')).text();
  expect(body).not.toContain('iputils');
  expect(body).toContain('Invalid host name or address');
});

test('an event id that is not a name is refused', async ({ request }) => {
  // (An encoded slash never gets past Apache, which answers 404 itself.)  By
  // GET, which every FPP since the fix answers; POST came later.
  const r = await request.get('/api/events/fpp-tests%3Fx%3D1/trigger');
  expect(r.status(), await r.text()).toBe(400);
});

test.describe('PipeWire', () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

  test('saving video sources leaves no debug copy in /tmp', async ({ request }) => {
    inPlayer('rm', '-f', '/tmp/debug_save_vis.txt');
    const before = await request.get('/api/pipewire/video/input-sources');
    const saved = before.ok() ? await before.text() : '[]';
    try {
      const r = await request.post('/api/pipewire/video/input-sources', { headers: { 'Content-Type': 'application/json' }, data: saved });
      // The control: the save went through to the write.
      expect(r.ok(), await r.text()).toBe(true);
      expect(inPlayer('sh', '-c', 'test -e /tmp/debug_save_vis.txt && echo written || echo absent').trim()).toBe('absent');
    } finally {
      inPlayer('rm', '-f', '/tmp/debug_save_vis.txt');
    }
  });
});
