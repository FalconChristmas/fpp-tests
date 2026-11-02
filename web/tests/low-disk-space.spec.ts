import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// What the pages do when the media drive is nearly full: a warning in the
// header, no list of OS images to download below 1GB free, and no OS image
// to apply below 200MB.  php-fpm is restarted with fakefree.so preloaded (see
// fakefree.c) so disk_free_space() reports the figure a test sets.

test.skip(!container, 'restarts php-fpm inside the run-web.sh container');
test.describe.configure({ mode: 'serial' });

const SO = '/tmp/fpp-tests-fakefree.so';
const CONTROL = '/tmp/fpp-tests-free';
const MB = 1000 * 1000;

function restartPhpFpm(preload: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${preload ? `LD_PRELOAD=${preload} ` : ''}php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

const setFree = (bytes: number) => putFile(CONTROL, String(bytes));

test.beforeAll(() => {
  inPlayer('rm', '-f', CONTROL);
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/web/tests/fakefree.c', '-ldl');
  restartPhpFpm(SO);
});

test.afterAll(() => {
  inPlayer('rm', '-f', CONTROL);
  restartPhpFpm('');
});

test('the header warns when the media drive has under 50MB free, and not before', async ({ request }) => {
  // Feature: 0a5fe4f94.  A full media drive makes saving settings and
  // uploading fail with no word of why; every page now says so.
  setFree(10 * MB);
  expect(await (await request.get('/index.php')).text()).toContain('is running low on space');
  setFree(500 * MB);
  expect(await (await request.get('/index.php')).text()).not.toContain('is running low on space');
});

test('About does not list OS images to download below 1GB free, nor offer to apply one below 200MB', async ({ page }) => {
  // Feature: 0a5fe4f94.  An OS image is downloaded to the upload directory and
  // then applied from it, which needs about that much room.
  const asked: string[] = [];
  page.on('request', (r) => { if (/api\/git\/releases\/os/.test(r.url())) asked.push(r.url()); });
  const osFns = async () => {
    const html = await (await page.request.get('/about.php')).text();
    return { listsReleases: /api\/git\/releases\/os/.test(html), appliesNone: /os = '';/.test(html) };
  };
  setFree(5000 * MB);
  expect(await osFns(), 'the control: plenty of room').toEqual({ listsReleases: true, appliesNone: false });
  setFree(500 * MB);
  expect(await osFns()).toEqual({ listsReleases: false, appliesNone: false });
  setFree(100 * MB);
  expect(await osFns()).toEqual({ listsReleases: false, appliesNone: true });
  // The receiving end is the page: with room it asks for the list, without
  // it does not.
  await page.goto('/about.php');
  await page.waitForLoadState('networkidle');
  expect(asked, 'the page asked for OS images with 100MB free').toEqual([]);
  setFree(5000 * MB);
  await page.goto('/about.php');
  await expect.poll(() => asked.length, { timeout: 15_000 }).toBeGreaterThan(0);
});
