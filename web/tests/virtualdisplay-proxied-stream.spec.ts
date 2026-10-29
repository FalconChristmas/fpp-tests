import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// The Virtual Display page (virtualdisplay.php) streams the lights from
// fppd's HTTPVirtualDisplay output, a server-sent event stream on port
// 32328.  The page's CSP lets it connect only to its own origin, so Apache
// proxies the stream at /api/http-virtual-display/.  fppd's stream is the
// receiving end: the pixels the page is sent are the channels fppd holds.

test.skip(!container, 'configures an HTTPVirtualDisplay output in the run-web.sh container');

const MAP = '/home/fpp/media/config/virtualdisplaymap';

async function keep(request: APIRequestContext) {
  const r = await request.get('/api/channel/output/co-other');
  return r.ok() ? r.text() : null;
}

let before: string | null = null;
let mapBefore = '';
test.beforeEach(async ({ request }) => {
  before = await keep(request);
  mapBefore = inPlayer('sh', '-c', `cat ${MAP} 2>/dev/null || true`);
  // One RGB pixel at (2,2) of a 100x100 preview: channel 0 (zero-based), 3 per pixel.
  inPlayer('sh', '-c', `printf '100,100\\n2,2,0,3,RGB\\n' > ${MAP}`);
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'HTTPVirtualDisplay', enabled: 1, startChannel: 1, channelCount: 3, width: -1, height: -1,
    pixelSize: 1, colorOrder: 'RGB', port: 32328 }] } });
  expect(r.ok(), await r.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  await request.post('/api/channel/output/co-other', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}'),
  });
  if (mapBefore) inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', mapBefore, MAP);
  else inPlayer('rm', '-f', MAP);
});

test('the Virtual Display page streams fppd\'s pixels through /api/http-virtual-display/', async ({ page, request }) => {
  // Regression: d0fe51863.  The page opened its EventSource on the
  // player's port 32328, which the CSP's connect-src ('self') refuses, so
  // the display stayed black.
  const violations: string[] = [];
  const errors: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|EventSource/i.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => { violations.push(String(e)); errors.push(String(e)); });
  await page.addInitScript(() => {
    const Real = window.EventSource;
    (window as any).fppTestsStreams = [];
    (window as any).EventSource = function (url: string, init?: EventSourceInit) {
      const es = new Real(url, init);
      const rec = { url: es.url, messages: [] as string[] };
      (window as any).fppTestsStreams.push(rec);
      es.addEventListener('message', (e) => { if (rec.messages.length < 50) rec.messages.push(String((e as MessageEvent).data)); });
      return es;
    } as any;
    (window as any).EventSource.prototype = Real.prototype;
  });

  // fppd has the display up once it listens on its port.
  await expect.poll(() => /:32328\b/.test(inPlayer('ss', '-ltn')), { timeout: 15_000 }).toBe(true);

  await page.goto('/virtualdisplay.php');
  await expect.poll(() => page.evaluate(() => (window as any).fppTestsStreams.map((s: any) => new URL(s.url).pathname)),
    { message: `the page's event streams (${violations.join(' | ')})` }).toEqual(['/api/http-virtual-display/']);

  // A test pattern on channels 1-3: fppd sends the pixel's colours, and the
  // page gets them.
  const r = await request.post('/api/command', { data: { command: 'Test Start', args: ['1000', 'RGB Cycle', '1-3', 'R-G-B'] } });
  expect(r.ok()).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).fppTestsStreams[0].messages.join('\n')),
    { timeout: 10_000, message: 'what the page heard on the stream' }).toMatch(/[^\s]/);
  expect(violations.filter((v) => /Content Security Policy/i.test(v))).toEqual([]);

  // And the page draws it: the canvas, black until then, has a lit pixel.
  await expect.poll(() => page.evaluate(() => {
    const c = document.getElementById('vCanvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) lit++;
    return lit;
  }), { timeout: 10_000, message: 'lit pixels on the display canvas' }).toBeGreaterThan(0);

  // Regression: fpp ede5ff03e.  The page loaded jQuery, jQuery UI and fpp.js
  // a second time after menuHead.inc had, so fpp.js threw "Identifier
  // 'SwipeHandler' has already been declared" and the second jQuery replaced
  // the one Bootstrap's and jQuery UI's plugins were attached to.
  expect(errors, 'errors thrown on the page').toEqual([]);
  const scripts = await page.evaluate(() => Array.from(document.scripts).map((s) => new URL(s.src || location.href).pathname)
    .filter((p) => /\/js\/(jquery-latest\.min|jquery-ui\.min|fpp)\.js$/.test(p)));
  expect(scripts.sort(), 'jQuery, jQuery UI and fpp.js, each loaded once').toEqual(
    ['/js/fpp.js', '/js/jquery-latest.min.js', '/js/jquery-ui.min.js']);
});
