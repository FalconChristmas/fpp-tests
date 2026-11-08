import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// User data with quotes and markup in it, where the Scheduler, the playlist
// editor and Recurring Tasks build HTML: the calendar's tooltip for an entry,
// the Scheduler's playlist and sequence lists, the playlist cards and an
// entry's details line, and the Result Variable suggestions.  Each shows the
// text as written, keeps it as the value saved, and none of it runs.
// (command-presets-page.spec.ts, other-output-control-presets.spec.ts: the
// command rows and preset lists.)

const MARKUP = `it's <img src=x onerror="window.fppTestsRan=1"> <i>i</i> & "x"`;
// No "/": a playlist name is a file name.
const PLAYLIST = `fpp-tests "q" <b>bold`;
const SEQUENCE = `fpp-tests "s" <b>seq`;
const SEQ_DIR = '/home/fpp/media/sequences';
let before: unknown;

const year = new Date().getFullYear();
const entry = (extra: object = {}) => ({
  enabled: 1, day: 7, type: 'playlist', playlist: PLAYLIST, command: '', args: [],
  startTime: '12:00:00', endTime: '13:00:00',
  startDate: `${year - 1}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});
// Port 9 (discard) on the player itself: if the entry fires while the test
// runs, it goes nowhere.
const urlCommand = { type: 'command', command: 'URL', args: [`http://127.0.0.1:9/${MARKUP}`, 'POST', MARKUP] };

async function putPlaylist(request: APIRequestContext, mainPlaylist: object[] = [], description = '') {
  const r = await request.post(`/api/playlist/${encodeURIComponent(PLAYLIST)}`, {
    data: { name: PLAYLIST, version: 4, desc: description, description, repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `the control: a playlist can be named ${PLAYLIST}`).toBe(true);
}

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  await putPlaylist(request);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  await request.delete(`/api/playlist/${encodeURIComponent(PLAYLIST)}`);
});

async function useSchedule(request: APIRequestContext, entries: object[]) {
  expect((await request.post('/api/schedule', { data: entries })).ok()).toBe(true);
  expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
  const want = entries.map((e: any) => e.playlist || e.command);
  await expect.poll(async () =>
    ((await (await request.get('/api/fppd/schedule')).json()).schedule?.entries ?? [])
      .map((e: any) => e.playlist || e.command), { message: 'the control: fppd runs the schedule', timeout: 10_000 })
    .toEqual(want);
}

const ran = (page: Page) => page.evaluate(() => (window as any).fppTestsRan);
// Elements made from the markup above (the page has <b> and <i> of its own).
const drawn = (l: Locator) => l.locator('img[src="x"], i:text-is("i"), i:text-is("topic"), i:text-is("about"), b:text-is("bold")');

test("the calendar's tooltip shows a command's arguments and hosts as written", async ({ page, request }) => {
  // Regression: 5e1d6aad9.  ScheduleCalendarItemInfo() put the entry's command, args
  // and MultiSync hosts into the HTML tooltip as markup.  Bootstrap's
  // sanitizer strips onerror, but keeps <img src> and <i>: those are what
  // show the bug.
  await useSchedule(request, [entry({ ...urlCommand, playlist: '', startTime: '12:30:00', endTime: '12:30:00',
    multisyncCommand: true, multisyncHosts: '<i>hosts</i>' })]);
  await page.goto('/scheduler.php');
  await page.locator('#schedulerPreviewActions').click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Calendar View' }).click();
  const calendar = page.locator('#scheduleCalendarModal');
  await calendar.locator('.fc-listWeek-button').click();
  const event = calendar.locator('.fc-list-event').first();
  await event.hover();
  await expect(event).toHaveAttribute('aria-describedby', /.+/);
  const tip = page.locator(`#${await event.getAttribute('aria-describedby')}`);
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(`POST | ${MARKUP}`);
  await expect(tip).toContainText('Multisync: <i>hosts</i>');
  await expect(tip.locator('img, i')).toHaveCount(0);
  expect(await ran(page)).toBeUndefined();
});

test.describe("the Scheduler's playlist and sequence lists", () => {
  test.skip(!container, 'puts a sequence file on the player');
  test.beforeEach(() => { inPlayer('sh', '-c', `: > '${SEQ_DIR}/${SEQUENCE}.fseq'`); });
  test.afterEach(() => { inPlayer('rm', '-f', `${SEQ_DIR}/${SEQUENCE}.fseq`); });

  test('offer and save names with quotes and markup', async ({ page, request }) => {
    // Regression: 5e1d6aad9.  getSchedule() built each list's value="..." from the raw
    // name, so a name with a quote was cut off there and saved as a playlist
    // or sequence that isn't there, and markup in a name was drawn.
    // Disabled: these only need to be listed and saved, not run.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    expect((await request.post('/api/schedule', { data: [
      entry({ enabled: 0, startTime: '19:00:00', endTime: '20:00:00' }),
      entry({ enabled: 0, playlist: `${SEQUENCE}.fseq`, sequence: 1, startTime: '20:00:00', endTime: '21:00:00' }),
    ] })).ok()).toBe(true);
    await page.goto('/scheduler.php');
    const template = page.locator('.fppTableRowTemplate');
    const playlistOption = template.locator('.schPlaylist option').filter({ hasText: PLAYLIST });
    await expect(playlistOption).toHaveCount(1);
    await expect(playlistOption).toHaveAttribute('value', PLAYLIST);
    const sequenceOption = template.locator('.schSequence option').filter({ hasText: SEQUENCE });
    await expect(sequenceOption).toHaveCount(1);
    await expect(sequenceOption).toHaveAttribute('value', `${SEQUENCE}.fseq`);
    const rows = page.locator('#tblScheduleBody > tr');
    await expect(rows.nth(0).locator('.schPlaylist')).toHaveValue(PLAYLIST);
    await expect(rows.nth(1).locator('.schSequence')).toHaveValue(`${SEQUENCE}.fseq`);

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await page.evaluate(() => (window as any).SaveSchedule());
    expect((await posted).ok()).toBe(true);
    const saved = await (await request.get('/api/schedule')).json();
    expect(saved.map((e: any) => e.playlist)).toEqual([PLAYLIST, `${SEQUENCE}.fseq`]);
    expect(errors).toEqual([]);
  });
});

test("a playlist's card and an entry's details line show names and arguments as written", async ({ page, request }) => {
  // Regression: 5e1d6aad9.  the playlists page drew a card's name and description, and
  // psiDetailsForEntrySimple() and its branch line an entry's args, MQTT
  // topic and branch playlist, as markup (and a "number" like 1<b> went in
  // raw).
  await putPlaylist(request, [
    { ...urlCommand, enabled: 1, playOnce: 0 },
    { type: 'branch', enabled: 1, playOnce: 0, branchTest: 'MQTT', mqttTopic: '<i>topic</i>', mqttMessage: MARKUP,
      trueNextBranchType: 'Playlist', trueBranchPlaylist: PLAYLIST, trueNextSection: '', trueNextItem: 1,
      falseNextBranchType: 'None', falseNextSection: '', falseNextItem: 1 },
  ], `<i>about</i> ${MARKUP}`);
  await page.goto('/playlists.php');
  const card = page.locator('.playlistCard').filter({ has: page.locator('h3', { hasText: PLAYLIST }) });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(`<i>about</i> ${MARKUP}`);
  await expect(drawn(card)).toHaveCount(0);
  await card.locator('h3').click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
  await expect(page.locator('.playlistEditorHeaderTitle')).toHaveText(PLAYLIST);
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  await expect(rows.nth(0)).toContainText(`"${MARKUP}"`);
  await expect(rows.nth(1)).toContainText(`MQTT: Topic: "<i>topic</i>", Message: "${MARKUP}`);
  await expect(rows.nth(1)).toContainText(`Call Playlist: "${PLAYLIST}"`);
  await expect(drawn(page.locator('#tblPlaylistMainPlaylist'))).toHaveCount(0);
  expect(await ran(page)).toBeUndefined();
});

test.describe('Recurring Tasks', () => {
  const VAR = "fpp-tests Santa's <i>list</i>";
  const enc = encodeURIComponent(VAR);
  test.afterEach(async ({ request }) => { await request.delete(`/api/variables/${enc}`); });

  test("suggests a Result Variable whose name has an apostrophe as it is", async ({ page, request }) => {
    // Regression: 5e1d6aad9.  LoadResultVariableNames() escaped the name for HTML but not
    // its ', inside a value='...': "Santa's" was offered as "Santa".
    const r = await request.post(`/api/variables/${enc}?persist=false`, { data: 'x', headers: { 'Content-Type': 'text/plain' } });
    expect(r.ok(), `the control: a variable can be named ${VAR}`).toBe(true);
    await page.goto('/recurringtasks.php');
    const values = page.locator('#ptResultVariableNames option');
    await expect.poll(() => values.evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)), { timeout: 10_000 })
      .toContain(VAR);
  });
});
