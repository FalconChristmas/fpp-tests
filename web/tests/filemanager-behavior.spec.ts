import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager's tables and buttons, against files put straight into the
// player's media directory.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sh(cmd: string): string {
  return inPlayer('sh', '-c', cmd);
}

function exists(path: string): boolean {
  return sh(`test -e "${path}" && echo yes || echo no`).trim() === 'yes';
}

async function openFileManager(page: Page, hash = '') {
  await page.goto(`/filemanager.php${hash}`);
  await page.waitForLoadState('load');
}

async function openTab(page: Page, tab: string, table: string) {
  await openFileManager(page, `#tab-${tab}`);
  await page.locator(`#tab-${tab}-tab`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
  // The listing is in once its rows are.
  await expect(page.locator(`#tbl${table} tbody tr`).first()).toBeVisible();
}

function row(page: Page, table: string, name: string) {
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

async function setSetting(request: APIRequestContext, name: string, value: string) {
  expect((await request.put(`/api/settings/${name}`, { data: value })).ok()).toBe(true);
}

test('Delete asks first, No leaves the file and its selection alone', async ({ page }) => {
  // Regression: 43b538317.  Delete removed the selected files the moment it
  // was clicked.
  const file = `${MEDIA}/music/fpp-tests-delete-me.mp3`;
  sh(`echo x > ${file}`);
  try {
    await openTab(page, 'audio', 'Music');
    await row(page, 'Music', 'fpp-tests-delete-me.mp3').click();
    await page.locator('#btnDeleteMusic').click();
    const dialog = page.locator('#confirmDeleteFile');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('fpp-tests-delete-me.mp3');
    expect(exists(file), 'deleted before the dialog was answered').toBe(true);

    await dialog.getByRole('button', { name: 'No' }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(500);
    expect(exists(file), 'No deleted the file').toBe(true);

    // Regression: 514184bc8.  The dialog coming and going redrew the table,
    // which dropped the selection and left Delete enabled for nothing: a
    // second click did nothing at all.  The selection survives the redraw.
    await expect(row(page, 'Music', 'fpp-tests-delete-me.mp3')).toHaveClass(/selectedEntry/);
    await expect(page.locator('#btnDeleteMusic')).toBeEnabled();
    await page.locator('#btnDeleteMusic').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => exists(file)).toBe(false);
  } finally {
    sh(`rm -f ${file}`);
  }
});

test('Add To Playlist follows the selection on the Videos tab', async ({ page }) => {
  // Regression: a4566ee25 (#3032).  The button carried the Music tab's
  // classes, so selecting a video never enabled it.
  const file = `${MEDIA}/videos/fpp-tests-video.mp4`;
  sh(`echo x > ${file}`);
  try {
    await openTab(page, 'video', 'Videos');
    const add = page.locator('#tab-video input[value="Add To Playlist"]');
    // Greyed out (still clickable) until a video is selected.
    await expect(add).toHaveClass(/disableButtons/);
    await row(page, 'Videos', 'fpp-tests-video.mp4').click();
    await expect(add).not.toHaveClass(/disableButtons/);
    await expect(add).toBeEnabled();
  } finally {
    sh(`rm -f ${file}`);
  }
});

test("a plugin's file action gets the file name as data, never as code", async ({ page }) => {
  // Regression: c0446fb12.  Actions with no branch of their own (a plugin's
  // <table><button>Pressed) were dispatched with eval('...("' + name + '")'),
  // escaping only the first quote, so a name with two ran as script.
  const name = 'fpp-tests"q");window.__fppTestsRan=1;("q.mp3';
  sh(`printf x > '${MEDIA}/music/${name}'`);
  try {
    await openTab(page, 'audio', 'Music');
    await page.evaluate(() => {
      (window as any).MusicfppTestsActionPressed = (f: string) => ((window as any).__fppTestsGot = f);
    });
    await row(page, 'Music', name).click();
    await page.evaluate(() => (window as any).ButtonHandler('Music', 'fppTestsAction'));
    expect(await page.evaluate(() => (window as any).__fppTestsGot)).toBe(name);
    expect(await page.evaluate(() => (window as any).__fppTestsRan)).toBeUndefined();

    // An action nobody handles is an error dialog, not an exception.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluate(() => (window as any).ButtonHandler('Music', 'fppTestsNoSuchAction'));
    await expect(page.getByText('Error, unknown file action.')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    sh(`rm -f '${MEDIA}/music/${name}'`);
  }
});

test.describe('a zero-byte file', () => {
  const seq = `${MEDIA}/sequences/fpp-tests-empty.fseq`;
  const sub = `${MEDIA}/sequences/fpp-tests-subdir`;

  test.beforeEach(() => {
    sh(`: > ${seq} && mkdir -p ${sub} && echo x > ${sub}/inner.fseq`);
  });
  test.afterEach(() => {
    sh(`rm -rf ${seq} ${sub}`);
  });

  test('is a file, and only a real subdirectory is listed as one', async ({ page, request }) => {
    // Regression: ce18c269d.  The File Manager took sizeBytes == 0 for a
    // directory, so an empty file lost its single-file actions.
    const files = (await (await request.get('/api/files/sequences')).json()).files as any[];
    const empty = files.find((f) => f.name === 'fpp-tests-empty.fseq');
    const dir = files.find((f) => f.name === 'fpp-tests-subdir');
    expect(empty).toBeTruthy();
    expect(empty.isDirectory).not.toBe(true);
    expect(dir?.isDirectory).toBe(true);

    await openTab(page, 'sequence', 'Sequences');
    await expect(row(page, 'Sequences', 'fpp-tests-empty.fseq')).not.toHaveClass(/fileIsDirectory/);
    await expect(row(page, 'Sequences', 'fpp-tests-subdir')).toHaveClass(/fileIsDirectory/);
    await row(page, 'Sequences', 'fpp-tests-empty.fseq').click();
    await expect(page.locator('#tab-sequence input[value="Sequence Info"]')).toBeEnabled();
  });
});

test.describe('the Images tab', () => {
  const empty = `${MEDIA}/images/fpp-tests-empty.png`;
  const real = `${MEDIA}/images/fpp-tests-real.png`;

  test.beforeEach(() => {
    sh(`: > ${empty} && echo ${PNG} | base64 -d > ${real}`);
  });
  test.afterEach(async ({ request }) => {
    sh(`rm -f ${empty} ${real}`);
    await setSetting(request, 'fileManagerThumbnailSize', '0');
  });

  test('asks for no thumbnail of an empty image', async ({ page, request }) => {
    // Regression: 0cee57a9e.  Every row got an <img> of the file, so an
    // empty one was fetched and rendered as a broken image.
    await setSetting(request, 'fileManagerThumbnailSize', '50');
    const fetched: string[] = [];
    page.on('request', (r) => {
      const m = new URL(r.url()).pathname.match(/\/api\/file\/Images\/(.*)$/);
      if (m) fetched.push(decodeURIComponent(m[1]));
    });
    await openTab(page, 'images', 'Images');
    await expect(row(page, 'Images', 'fpp-tests-real.png').locator('img')).toHaveCount(1);
    await expect(row(page, 'Images', 'fpp-tests-empty.png').locator('img')).toHaveCount(0);
    await expect.poll(() => fetched).toContain('fpp-tests-real.png');
    expect(fetched).not.toContain('fpp-tests-empty.png');
  });

  for (const size of ['50', '0']) {
    test(`puts the date under Date Modified, thumbnails ${size === '0' ? 'off' : 'on'}`, async ({ page, request }) => {
      // Regression: bd1318502.  With thumbnails the date and the thumbnail
      // sat under each other's heading; without them the date sat under
      // Thumbnail and the Date Modified column was empty.
      await setSetting(request, 'fileManagerThumbnailSize', size);
      await openTab(page, 'images', 'Images');
      const headers = await page.locator('#tblImages thead th').evaluateAll((ths) => ths.map((th) => th.textContent!.trim()));
      const cells = row(page, 'Images', 'fpp-tests-real.png').locator('td');
      const at = headers.indexOf('Date Modified');
      expect(at).toBeGreaterThan(0);
      await expect(cells).toHaveCount(headers.length);
      await expect(cells.nth(at)).toHaveText(/\d\d\/\d\d\/\d\d/);
      await expect(cells.nth(headers.indexOf('Thumbnail'))).not.toHaveText(/\d\d\/\d\d\/\d\d/);
    });
  }
});

test('Hide Empty Tabs hides the empty ones, never the open one, and brings one back when it fills', async ({ page, request }) => {
  // Feature: 960149295.
  const effect = `${MEDIA}/effects/fpp-tests.eseq`;
  const song = `${MEDIA}/music/fpp-tests-hide.mp3`;
  sh(`rm -f ${MEDIA}/effects/* ${MEDIA}/sequences/*; echo x > ${song}`);
  await setSetting(request, 'fileManagerHideEmptyTabs', '1');
  try {
    await openFileManager(page);
    // The open tab (Sequences) stays though it is empty.
    await expect(page.locator('#tab-sequence-tab')).toBeVisible();
    await expect(page.locator('#tab-effects-tab')).toBeHidden();
    await expect(page.locator('#tab-audio-tab')).toBeVisible();

    sh(`echo x > ${effect}`);
    await page.evaluate(() => (window as any).GetFiles('Effects'));
    await expect(page.locator('#tab-effects-tab')).toBeVisible();

    sh(`rm -f ${effect}`);
    await setSetting(request, 'fileManagerHideEmptyTabs', '0');
    await openFileManager(page);
    await expect(page.locator('#tab-audio-tab')).toBeVisible();
    await expect(page.locator('#tab-effects-tab')).toBeVisible();
  } finally {
    sh(`rm -f ${effect} ${song}`);
    await setSetting(request, 'fileManagerHideEmptyTabs', '0');
  }
});

test('an audio listing does not wait for durations, and the page fills them in', async ({ page, request }) => {
  // Regression: e3357c17f.  A listing ran ffprobe on every file with no cached
  // duration before it answered (minutes after a bulk upload).  Now it answers
  // from the cache alone, null where there is none, and the page asks for
  // each one at api/media/<name>/duration.
  const song = `${MEDIA}/music/fpp-tests-duration.mp3`;
  sh(`echo x > ${song}; rm -f ${MEDIA}/config/media_durations.cache`);
  try {
    const files = (await (await request.get('/api/files/music')).json()).files as any[];
    const f = files.find((x) => x.name === 'fpp-tests-duration.mp3');
    expect(f).toBeTruthy();
    expect(f.playtimeSeconds, 'the listing probed the file itself').toBeNull();

    const asked = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/media/fpp-tests-duration.mp3/duration');
    await openTab(page, 'audio', 'Music');
    await asked;
  } finally {
    sh(`rm -f ${song}`);
  }
});

test('a finished upload reads "Upload complete", not "Saving to disk"', async ({ page }) => {
  // Regression: 4829c4e60.  FilePond delivers the 100% progress event after
  // it has painted "Upload complete", and the handler that relabels a 100%
  // upload "Saving to disk" then overwrote the final label for good.
  const name = 'fpp-tests-label.mp3';
  try {
    await openFileManager(page);
    await page.locator('#filepondInput, .filepond--browser').first().waitFor({ state: 'attached' });
    await page.locator('input.filepond--browser').setInputFiles({ name, mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 1) });
    const item = page.locator('.filepond--item').filter({ hasText: name });
    await expect(item.locator('.filepond--file-status-main')).toHaveText('Upload complete', { timeout: 30_000 });
    await expect.poll(() => exists(`${MEDIA}/music/${name}`)).toBe(true);
    await page.waitForTimeout(1500);
    await expect(item.locator('.filepond--file-status-main')).toHaveText('Upload complete');
  } finally {
    sh(`rm -f ${MEDIA}/music/${name} ${MEDIA}/upload/${name}`);
  }
});

test('the page reads disk usage without a PHP warning when the media is not on a /dev device', async ({ request }) => {
  // Regression: 139cf962b.  The almost-full check took the df line matching
  // "/dev/", which media on an overlay or tmpfs (as in this container) does
  // not have, and indexed the empty result: a PHP warning on every load.
  expect(sh(`df -kP ${MEDIA}/upload | awk 'NR==2 {print $1}'`).trim(), 'the control: media is not on a /dev device').not.toMatch(/^\/dev\//);
  const LOG = `${MEDIA}/logs/apache2-error.log`;
  const warnings = () => Number(sh(`grep -c 'filemanager.php' ${LOG} 2>/dev/null || true`).trim() || 0);
  const before = warnings();
  expect((await request.get('/filemanager.php')).status()).toBe(200);
  await new Promise((r) => setTimeout(r, 500));
  expect(warnings() - before, sh(`tail -3 ${LOG} 2>/dev/null || true`)).toBe(0);
});
