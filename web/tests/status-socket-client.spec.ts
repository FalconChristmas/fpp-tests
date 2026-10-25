import { test, expect } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

// The status WebSocket client in js/fpp.js: fppd pushes a status snapshot
// over /fppdws about once a second, and while it does the page polls
// api/system/status only for the PHP half (?systemonly=1, every 30 s);
// without it the page polls the full status every 5 s.  The socket is played
// by the test (page.routeWebSocket); the snapshots are this player's own
// fppd status with the fields under test changed.

type Status = Record<string, any>;

async function fppdStatus(page: Page): Promise<Status> {
  return (await page.request.get('/api/fppd/status')).json();
}

function snapshot(status: Status): string {
  return JSON.stringify({ type: 'snapshot', data: { status } });
}

// Every api/system/status request the page makes, with when it was made.
function statusPolls(page: Page) {
  const polls: { at: number; url: string }[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/system/status')) polls.push({ at: Date.now(), url: r.url() });
  });
  return polls;
}

test("the player's own fppd feeds the page over the socket", async ({ page }) => {
  // The control for the tests below: the snapshots they play are the shape
  // this fppd pushes.  With its socket the page drops to the PHP half.
  const polls = statusPolls(page);
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  await page.goto('/index.php');
  await expect.poll(() => polls.some((p) => p.url.includes('systemonly=1')), { timeout: 15_000 }).toBe(true);
  const msg = JSON.parse(frames.find((f) => f.includes('"snapshot"'))!);
  expect(msg.type).toBe('snapshot');
  expect(Object.keys(msg.data.status)).toEqual(expect.arrayContaining(['status', 'status_name', 'current_playlist']));
});

test('a frame that is not a status snapshot does not switch the page to the socket', async ({ page }) => {
  // Regression: 497f934ea.  Any frame on the socket marked it connected, so
  // a garbage first frame switched the poll to the PHP half only
  // (?systemonly=1, every 30 s) while the page had no fppd status at all.
  // Now only a parsed snapshot does.
  const polls = statusPolls(page);
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/fppdws', (ws) => {
    socket = ws;
  });
  await page.goto('/index.php');
  await expect.poll(() => socket !== undefined, { timeout: 15_000 }).toBe(true);
  // Frames often enough that the watchdog (8 s of silence) never fires.
  const since = Date.now();
  const timer = setInterval(() => socket!.send('fpp-tests: not a status snapshot'), 1000);
  try {
    socket!.send('fpp-tests: not a status snapshot');
    await page.waitForTimeout(12_000);
  } finally {
    clearInterval(timer);
  }
  const after = polls.filter((p) => p.at >= since).map((p) => new URL(p.url).search);
  expect(after.filter((s) => s.includes('systemonly')), JSON.stringify(after)).toEqual([]);
  // The control: the page went on polling the full status, every 5 s.
  expect(after.length, JSON.stringify(after)).toBeGreaterThanOrEqual(2);
});

test('a snapshot without breadcrumbs clears the nested playlist label', async ({ page }) => {
  // Regression: 497f934ea.  Each snapshot was merged into the last, so a
  // key fppd sends only some of the time -- breadcrumbs, while a nested
  // playlist runs -- kept its last value, and the status heading went on
  // reading "(Main -> Inner)" after the nested playlist ended.
  const base = await fppdStatus(page);
  const playing: Status = {
    ...base, status: 1, status_name: 'playing',
    current_playlist: { count: '2', description: '', index: '1', playlist: 'Inner', type: 'sequence' },
    current_sequence: 'fpp-tests.fseq', current_song: '', time_elapsed: '00:05', time_remaining: '00:55',
    seconds_elapsed: '5', seconds_remaining: '55', seconds_played: '5',
  };
  // The playlist the page loads for the playing entry.
  await page.route('**/api/playlist/Inner*', (route) => route.fulfill({
    json: { name: 'Inner', mainPlaylist: [{ type: 'sequence', enabled: 1, playOnce: 0, sequenceName: 'fpp-tests.fseq' }], playlistInfo: { total_items: 1 } },
  }));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/fppdws', (ws) => {
    socket = ws;
  });
  await page.goto('/index.php');
  await expect.poll(() => socket !== undefined, { timeout: 15_000 }).toBe(true);
  let current = { ...playing, breadcrumbs: ['Main'] };
  const timer = setInterval(() => socket!.send(snapshot(current)), 500);
  try {
    const label = page.locator('#txtPlayerStatusLabel');
    // The control: the label shows the breadcrumb while it is sent.
    await expect(label).toHaveText('Player Status (Main -> Inner):', { timeout: 15_000 });
    current = { ...playing };
    delete (current as Status).breadcrumbs;
    await expect(label).toHaveText('Player Status:', { timeout: 10_000 });
  } finally {
    clearInterval(timer);
  }
});

test('a replaced socket closing late does not stop the page noticing the new one wedge', async ({ page }) => {
  // Regression: 497f934ea.  When the socket went 8 s without a frame the
  // watchdog closed it and opened another, but a wedged socket's close event
  // can arrive long after (a TCP timeout).  That late event ran the old
  // socket's onclose against the new connection: it stopped the watchdog,
  // which only a socket's onopen starts again, so when the new socket wedged
  // too nothing noticed and the page showed frozen status for good.  Here
  // the first socket's close is held back until the second is live (an
  // onClose handler keeps Playwright from finishing it), then let through.
  test.setTimeout(90_000);
  const base = await fppdStatus(page);
  const sockets: WebSocketRoute[] = [];
  const sending = new Set<WebSocketRoute>();
  await page.routeWebSocket('**/fppdws', (ws) => {
    sockets.push(ws);
    sending.add(ws);
    // Closed by the page: not passed on until the test says so.
    ws.onClose(() => {});
  });
  const timer = setInterval(() => {
    for (const ws of sending) ws.send(snapshot(base));
  }, 1000);
  try {
    await page.goto('/index.php');
    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBe(1);
    // The first socket wedges; the watchdog replaces it.
    await page.waitForTimeout(2000);
    sending.delete(sockets[0]);
    await expect.poll(() => sockets.length, { timeout: 30_000 }).toBe(2);
    await page.waitForTimeout(2000);
    // Its close arrives now, with the second socket live.
    await sockets[0].close();
    await page.waitForTimeout(2000);
    // The second wedges too; the watchdog must replace it as well.
    sending.delete(sockets[1]);
    await expect.poll(() => sockets.length, { timeout: 30_000 }).toBe(3);
  } finally {
    clearInterval(timer);
  }
});
