import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The status page's player section: what it shows about the playlist fppd
// is playing.  The playlists are played by the real fppd.

const NAME = 'fpp-tests-global-pause';

const command = (request: APIRequestContext, cmd: string, args: string[]) =>
  request.post('/api/command', { data: { command: cmd, args } });

async function setting(request: APIRequestContext, name: string) {
  return String((await (await request.get(`/api/settings/${name}`)).json())?.value ?? '');
}

test('the Global Pause indicator follows Verbose Playlist Item Details', async ({ page, request }) => {
  // Regression: 687971406.  The Global Pause (and Randomised) indicators
  // showed whatever the verbose setting said; now they show only with it on,
  // and turning it on or off shows or hides them at once.
  const verbose = await setting(request, 'verbosePlaylistItemDetails');
  await request.put('/api/settings/verbosePlaylistItemDetails', { data: '0' });
  const saved = await request.post(`/api/playlist/${NAME}`, {
    data: {
      name: NAME, desc: '', repeat: 0, loopCount: 0, random: 1, globalPauseBetweenSequencesMS: 500, leadIn: [], leadOut: [],
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 60 }, { type: 'pause', enabled: 1, playOnce: 0, duration: 60 }],
    },
  });
  expect(saved.ok()).toBe(true);
  try {
    await command(request, 'Start Playlist', [NAME, 'false', 'false']);
    // The control: fppd says the playing playlist has a global pause.
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).global_pause?.configured).toBe(true);

    await page.goto('/index.php');
    await expect(page.locator('#txtPlayerStatus')).toContainText('Playing', { timeout: 15_000 });
    const pause = page.locator('#globalPauseIndicator');
    const random = page.locator('#randomizeIndicator');
    const toggle = page.locator('#verbosePlaylistItemDetails');
    await expect(toggle).not.toBeChecked();
    await page.waitForTimeout(2000);
    await expect(pause).toBeHidden();
    await expect(random).toBeHidden();

    await toggle.check();
    await expect(pause).toBeVisible();
    await expect(random).toBeVisible();
    // The page saved it, for the next status push and the next page.
    await expect.poll(() => setting(request, 'verbosePlaylistItemDetails')).toBe('1');
    await page.waitForTimeout(2000);
    await expect(pause).toBeVisible();

    await toggle.uncheck();
    await expect(pause).toBeHidden();
    await expect(random).toBeHidden();
    await page.waitForTimeout(2000);
    await expect(pause).toBeHidden();
  } finally {
    await command(request, 'Stop Now', []);
    await request.put('/api/settings/verbosePlaylistItemDetails', { data: verbose });
    await request.delete(`/api/playlist/${NAME}`);
  }
});

test('Preview offers the nested table and the calendar view of the schedule', async ({ page }) => {
  // Feature: bf77ff66a.  Preview opened the nested table only; it is a menu
  // now, with the calendar view next to it.
  await page.goto('/index.php');
  const preview = page.locator('#statusPreviewActions');
  await expect(preview).toBeVisible({ timeout: 15_000 });

  await preview.click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Nested Table View' }).click();
  const table = page.locator('#schedulePreview');
  await expect(table.locator('.modal-title')).toHaveText('Schedule Preview: Nested Table View');
  await table.locator('.modal-header .close, .modal-header [data-bs-dismiss="modal"]').first().click();
  await expect(table).toBeHidden();

  // The calendar asks fppd for the schedule over the range it shows.
  const range = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/fppd/schedule/range');
  await preview.click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Calendar View' }).click();
  const calendar = page.locator('#scheduleCalendarModal');
  await expect(calendar.locator('.modal-title')).toHaveText('Schedule Preview: Calendar View');
  const answer = await range;
  expect(answer.ok()).toBe(true);
  expect(typeof (await answer.json())).toBe('object');
  await expect(calendar.locator('.fc')).toBeVisible();
});

test("streamed output keeps its line breaks as text in a <pre>, and as <br> elsewhere", async ({ page }) => {
  // Regression: 3e100296e.  StreamURL() tested outputArea.nodename (never
  // set) instead of nodeName, so output streamed into a <pre> got <br>
  // elements on top of its own line breaks: every line doubled.
  test.skip(!container, 'writes a log inside the run-web.sh container');
  const log = '/home/fpp/media/logs/fpp-tests-stream.log';
  inPlayer('sh', '-c', `printf 'one\\ntwo\\nthree\\n' > ${log}`);
  try {
    await page.goto('/index.php');
    const result = await page.evaluate(async () => {
      const run = (tag: string) => new Promise<{ html: string; text: string }>((resolve) => {
        const el = document.createElement(tag);
        el.id = 'fppTestsStream' + tag;
        document.body.appendChild(el);
        (window as any).fppTestsStreamDone = () => resolve({ html: el.innerHTML, text: el.textContent ?? '' });
        (window as any).StreamURL('api/file/Logs/fpp-tests-stream.log', el.id, 'fppTestsStreamDone', 'fppTestsStreamDone');
      });
      return { pre: await run('PRE'), div: await run('DIV') };
    });
    // The control: the same stream in a <div> gets <br>s.
    expect(result.div.html).toContain('<br>');
    expect(result.pre.html).not.toContain('<br>');
    expect(result.pre.text).toContain('one\ntwo\nthree');
  } finally {
    inPlayer('rm', '-f', log);
  }
});

test('a sequence played outside a playlist shows on the status page as playing, by name', async ({ page, request }) => {
  // Regression: 3e100296e.  The status for a sequence playing outside a
  // playlist set playerStatusTest, a typo, so the page showed 'Playing '
  // without the sequence's name.
  // Regression: ae524f919.  And that branch could not run at all: fppd
  // reported such a sequence as status 0 (idle) beside status_name
  // "playing", and parseStatus() goes by status, so the page said Idle.
  test.skip(!container, 'writes a sequence inside the run-web.sh container');
  const seq = 'fpp-tests-solo.fseq';
  const path = `/home/fpp/media/sequences/${seq}`;
  // FSEQ v1, 3 channels, 2400 frames of 50 ms: two minutes, longer than the test.
  const header = Buffer.alloc(28);
  header.write('PSEQ', 0, 'latin1');
  header.writeUInt16LE(28, 4);
  header.writeUInt8(1, 7);
  header.writeUInt16LE(28, 8);
  header.writeUInt32LE(3, 10);
  header.writeUInt32LE(2400, 14);
  header.writeUInt8(50, 18);
  putFile(path, Buffer.concat([header, Buffer.alloc(3 * 2400, 0x40)]));
  try {
    const started = await request.get(`/api/sequence/${seq}/start/0`);
    expect(started.ok()).toBe(true);
    // The control: fppd is playing it.
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).current_sequence,
      { timeout: 10_000 }).toBe(seq);

    await page.goto('/index.php');
    await expect(page.locator('#txtPlayerStatus')).toHaveText(`'${seq}'`, { timeout: 15_000 });
    await expect(page.locator('#btnStopNow')).toBeEnabled();
    // fppd's side of it: status agrees with status_name.
    const s = await (await request.get('/api/fppd/status')).json();
    expect(`${s.status} ${s.status_name}`).toBe('1 playing');
  } finally {
    await request.get('/api/sequence/current/stop');
    inPlayer('rm', '-f', path);
  }
});

test.describe('while bridging', () => {
  // fppd says it is bridging (channel inputs on) in its status pushes; the
  // input stats come back empty.  The playlist list is slowed down so it
  // arrives after the first status, as on a busy player.
  async function bridgingPage(page: import('@playwright/test').Page, edit: Record<string, unknown> = {}, playlists?: unknown) {
    await page.routeWebSocket('**/fppdws', (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        if (typeof message !== 'string') return ws.send(message);
        try {
          const msg = JSON.parse(message);
          if (msg?.type === 'snapshot' && msg.data?.status) Object.assign(msg.data.status, { bridging: true, ...edit });
          return ws.send(JSON.stringify(msg));
        } catch {
          return ws.send(message);
        }
      });
    });
    // The page's first status says so too: PHP's copy of it is taken out of
    // the page (as when PHP's own fetch fails) and the poll answers bridging.
    await page.route('**/index.php', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/<script type="text\/javascript">lastStatusJSON = [\s\S]*?<\/script>/, '');
      return route.fulfill({ response, body });
    });
    await page.route('**/api/system/status**', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (!new URL(route.request().url()).searchParams.has('systemonly')) Object.assign(json, { bridging: true, ...edit });
      return route.fulfill({ response, json });
    });
    await page.route('**/api/channel/input/stats**', (route) => route.fulfill({ json: { status: 'OK', universes: [] } }));
    await page.route('**/api/playlists/validate**', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      if (playlists !== undefined) return route.fulfill({ json: playlists }).catch(() => {});
      return route.continue().catch(() => {});
    });
    if (playlists !== undefined) await page.route('**/api/sequence', (route) => route.fulfill({ json: [] }));
    await page.goto('/index.php');
    await expect(page.locator('#bridgeModeInfo')).toBeVisible({ timeout: 15_000 });
  }

  test.beforeEach(async ({ request }) => {
    await request.post(`/api/playlist/${NAME}`, {
      data: { name: NAME, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 5 }] },
    });
  });
  test.afterEach(async ({ request }) => {
    await request.delete(`/api/playlist/${NAME}`);
  });

  test('the player controls show once a slow playlist list arrives', async ({ page }) => {
    // Regression: 45ad90e73.  Whether to show them was decided when the
    // input stats came back, before the playlists had loaded, so a bridging
    // player with playlists hid them until a reload.
    await bridgingPage(page);
    await expect(page.locator('#playlistSelect option', { hasText: NAME })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#playerModeInfo')).toBeVisible({ timeout: 3_000 });
  });

  test('with nothing to play they stay hidden', async ({ page }) => {
    // The control for the test above.
    await bridgingPage(page, {}, []);
    await page.waitForTimeout(4000);
    await expect(page.locator('#playerModeInfo')).toBeHidden();
  });
});
