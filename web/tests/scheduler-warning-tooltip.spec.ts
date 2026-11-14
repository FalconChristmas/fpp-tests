import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The ⚠ after a Scheduler row's playlist or command says why it is there:
// hovering, tapping or tabbing to it shows a tooltip listing the problems
// (www/js/fpp.js WarningIcon, an ordinary SetupToolTips tooltip).  It used to
// carry only a native title, which
// shows after the pointer rests on it, never on a touch screen, and cut
// short in Chrome; a show playlist with 33 missing sequences gave no way to
// tell why it was marked.  Everything is seeded and put back through the
// API, so this runs against any player.  Fix: 4cd2c63f6.

const BAD = 'fpp-tests-warn-tip';
const GOOD = 'fpp-tests-warn-tip-ok';
const MISSING = 11; // more than the 8 the tooltip lists

let before: unknown;

async function putPlaylist(request: APIRequestContext, name: string, media: string[]) {
  const mainPlaylist = media.map((m) => ({ type: 'media', mediaName: m, enabled: 1, playOnce: 0 }));
  const r = await request.post(`/api/playlist/${name}`, {
    data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  await putPlaylist(request, GOOD, []);
});

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/schedule', { data: before })).ok()).toBe(true);
  await request.post('/api/schedule/reload');
  await request.delete(`/api/playlist/${BAD}`);
  await request.delete(`/api/playlist/${GOOD}`);
});

const year = new Date().getFullYear();
const entry = (extra: object) => ({
  enabled: 1, day: 7, type: 'playlist', playlist: GOOD, startTime: '19:00:00', endTime: '20:00:00',
  startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});

async function openScheduler(page: Page, request: APIRequestContext, schedule: object[]) {
  expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
  await page.goto('/scheduler.php');
  await expect(page.locator('#tblScheduleBody > tr')).toHaveCount(schedule.length);
}

const row = (page: Page, i: number) => page.locator('#tblScheduleBody > tr').nth(i);
const tip = (page: Page) => page.locator('.tooltip');

test('hovering a playlist\'s ⚠ lists its problems: the first 8, and how many more', async ({ page, request }) => {
  await putPlaylist(request, BAD, Array.from({ length: MISSING }, (_, i) => `fpp-tests-warn-${i + 1}.mp3`));
  await openScheduler(page, request, [entry({ playlist: BAD }), entry({})]);
  const icon = row(page, 0).locator('.schPlaylistWarning');
  await expect(icon).toBeVisible();
  // The control: a playlist with no problems gets no ⚠.
  await expect(row(page, 1).locator('.schPlaylistWarning')).toHaveCount(0);
  // Only the tooltip explains it; a native title too would show a second box.
  await expect(icon).not.toHaveAttribute('title');

  await icon.hover();
  await expect(tip(page)).toBeVisible();
  const text = await tip(page).innerText();
  expect(text).toContain(`This playlist has ${MISSING} problems`);
  expect(text).toContain("Media 'fpp-tests-warn-1.mp3' not found");
  expect(text).toContain("Media 'fpp-tests-warn-8.mp3' not found");
  expect(text).not.toContain('fpp-tests-warn-9.mp3');
  expect(text).toContain(`and ${MISSING - 8} more`);
  // A screen reader hears the heading; the tooltip it is described by lists the rest.
  await expect(icon).toHaveAttribute('aria-label', new RegExp(`^This playlist has ${MISSING} problems`));

  await page.mouse.move(1, 1);
  await expect(tip(page)).toHaveCount(0);
});

test('the ⚠ explains itself without a mouse: keyboard focus (or a tap) shows the tooltip', async ({ page, request }) => {
  await putPlaylist(request, BAD, ['fpp-tests-warn-1.mp3']);
  await openScheduler(page, request, [entry({ playlist: BAD })]);
  const icon = row(page, 0).locator('.schPlaylistWarning');
  await icon.focus();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toContainText('This playlist has 1 problem ');
});

test('a file name in a problem is shown as text, not markup', async ({ page, request }) => {
  const evil = '<img src=x onerror="window.fppTestsTipXss=1">.mp3';
  await putPlaylist(request, BAD, [evil]);
  await openScheduler(page, request, [entry({ playlist: BAD })]);
  await row(page, 0).locator('.schPlaylistWarning').hover();
  await expect(tip(page)).toContainText(`Media '${evil}' not found`);
  await expect(tip(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fppTestsTipXss)).toBeUndefined();
});

test('choosing a playlist with no problems takes the ⚠ away, and an open tooltip with it', async ({ page, request }) => {
  await putPlaylist(request, BAD, ['fpp-tests-warn-1.mp3']);
  await openScheduler(page, request, [entry({ playlist: BAD })]);
  const icon = row(page, 0).locator('.schPlaylistWarning');
  await icon.hover();
  await expect(tip(page)).toBeVisible();
  await row(page, 0).locator('.schPlaylist').selectOption(GOOD);
  await expect(icon).toHaveCount(0);
  await expect(tip(page)).toHaveCount(0);
});

test('a command\'s ⚠ says the command would fail, and why', async ({ page, request }) => {
  await openScheduler(page, request, [
    entry({ type: 'command', playlist: '', command: 'Run Script', args: ['fpp-tests-warn-none.sh', '', ''] }),
  ]);
  const icon = row(page, 0).locator('.cmdTmplWarning');
  await expect(icon).toBeVisible();
  await expect(icon).not.toHaveAttribute('title');
  await icon.hover();
  await expect(tip(page)).toContainText('This command would fail:');
  await expect(tip(page)).toContainText('fpp-tests-warn-none.sh');
});

test('opening a dialog hides a ⚠ tooltip that is showing, so it is not left over the dialog', async ({ page, request }) => {
  await putPlaylist(request, BAD, ['fpp-tests-warn-1.mp3']);
  await openScheduler(page, request, [entry({ playlist: BAD })]);
  await row(page, 0).locator('.schPlaylistWarning').focus();
  await expect(tip(page)).toBeVisible();
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = '<div class="modal-dialog"><div class="modal-content"><div class="modal-body">fpp-tests</div></div></div>';
    document.body.appendChild(el);
    new (window as any).bootstrap.Modal(el).show();
  });
  await expect(tip(page)).toHaveCount(0);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('tapping a ⚠ shows why', async ({ page, request }) => {
    await putPlaylist(request, BAD, ['fpp-tests-warn-1.mp3']);
    await openScheduler(page, request, [entry({ playlist: BAD })]);
    await row(page, 0).locator('.schPlaylistWarning').tap();
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toContainText("Media 'fpp-tests-warn-1.mp3' not found");
  });
});
