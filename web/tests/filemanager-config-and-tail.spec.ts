import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { answerUpdateCheck } from './standin-http';

// The File Manager's Developer-level Config tab, the directory listing depth
// it asks for, and following a log as it grows.

test.skip(!container, 'seeds files inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';
const LOGS = '/home/fpp/media/logs';

test.describe('the config directory', () => {
  const top = `${CONFIG}/fpp-tests-top.json`;
  const sub = `${CONFIG}/fpp-tests-sub`;
  let uiLevel = '0';

  test.beforeEach(async ({ request }) => {
    uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
    inPlayer('sh', '-c', `echo '{}' > ${top} && mkdir -p ${sub} && echo '{}' > ${sub}/inner.json`);
  });
  test.afterEach(async ({ request }) => {
    inPlayer('rm', '-rf', top, sub);
    await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  });

  test('is listed one level deep with maxdepth=1, and in full without it', async ({ request }) => {
    // Feature: eacdf6c7f.
    const names = async (q: string) =>
      ((await (await request.get(`/api/files/config${q}`)).json()).files as any[]).map((f) => f.name);
    const shallow = await names('?maxdepth=1');
    expect(shallow).toContain('fpp-tests-top.json');
    expect(shallow.some((n: string) => n.includes('inner.json')), JSON.stringify(shallow)).toBe(false);
    // The control: the full listing goes down into the subdirectory.
    const full = await names('');
    expect(full).toContain('fpp-tests-top.json');
    expect(full.some((n: string) => n.includes('fpp-tests-sub/inner.json')), JSON.stringify(full)).toBe(true);
  });

  test('has a File Manager tab at the Developer UI level only', async ({ page, request }) => {
    // Feature: eacdf6c7f.
    await answerUpdateCheck(page);
    expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
    await page.goto('/filemanager.php');
    await expect(page.locator('#tab-audio-tab')).toBeVisible();
    await expect(page.locator('#tab-config-tab')).toHaveCount(0);

    expect((await request.put('/api/settings/uiLevel', { data: '3' })).ok()).toBe(true);
    const listed = page.waitForRequest((r) => /\/api\/files\/Config\?.*maxdepth=1/i.test(r.url()));
    await page.goto('/filemanager.php');
    await listed;
    await page.locator('#tab-config-tab').click();
    const rows = page.locator('#tblConfig tbody tr');
    await expect(rows.filter({ hasText: 'fpp-tests-top.json' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'inner.json' })).toHaveCount(0);
  });
});

test('a followed log streams as an event stream, line by line', async ({ page }) => {
  // Regression: 1a6f78205.  The headers were committed (by the flush that
  // turns output buffering off) before Content-Type was set, so the stream
  // went out as text/html and the browser's EventSource dropped it at once
  // ("Connection error or stream ended").
  const log = `${LOGS}/fpp-tests-follow.log`;
  inPlayer('sh', '-c', `printf 'fpp-tests first line\\n' > ${log}`);
  try {
    await answerUpdateCheck(page);
    await page.goto('/filemanager.php');
    const url = '/api/file/Logs/tailfollow/fpp-tests-follow.log';
    const contentType = await page.evaluate(async (u) => {
      const ctl = new AbortController();
      const r = await fetch(u, { signal: ctl.signal });
      const t = r.headers.get('content-type');
      ctl.abort();
      return t;
    }, url);
    expect(contentType).toMatch(/^text\/event-stream/);

    await page.evaluate((u) => {
      const w = window as any;
      w.__fppTestsLines = [];
      w.__fppTestsErrors = 0;
      w.__fppTestsSource = new EventSource(u);
      w.__fppTestsSource.onmessage = (e: MessageEvent) => w.__fppTestsLines.push(e.data);
      w.__fppTestsSource.onerror = () => w.__fppTestsErrors++;
    }, url);
    const lines = () => page.evaluate(() => (window as any).__fppTestsLines.join('\n'));
    await expect.poll(lines, { timeout: 15_000 }).toContain('fpp-tests first line');
    inPlayer('sh', '-c', `printf 'fpp-tests appended line\\n' >> ${log}`);
    await expect.poll(lines, { timeout: 15_000 }).toContain('fpp-tests appended line');
    await page.evaluate(() => (window as any).__fppTestsSource.close());
  } finally {
    inPlayer('rm', '-f', log);
  }
});
