import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A big show: hundreds of sequences, songs and playlists.  The status
// page's picker lists them all under their groups, and the one picked at
// the end of the list is the one started; the File Manager lists every
// sequence, and its name filter narrows to the ones asked for.  The lists
// are answered here, and so is the start command, so nothing plays.

test.describe.configure({ timeout: 120_000 });

const pad = (i: number) => String(i).padStart(3, '0');
const SEQUENCES = Array.from({ length: 500 }, (_, i) => `fpp-tests Song ${pad(i)}`);
const MEDIA = Array.from({ length: 300 }, (_, i) => `fpp-tests Song ${pad(i)}.mp3`);
const PLAYLISTS = Array.from({ length: 200 }, (_, i) => `fpp-tests Show ${pad(i)}`);

async function bigLists(page: Page) {
  await page.route((u) => u.pathname.endsWith('/api/playlists/validate'), (r) =>
    r.fulfill({ json: PLAYLISTS.map((name) => ({ name, valid: true, messages: [] })) }));
  await page.route((u) => u.pathname.endsWith('/api/sequence'), (r) => r.fulfill({ json: SEQUENCES }));
  await page.route((u) => u.pathname.endsWith('/api/media'), (r) => r.fulfill({ json: MEDIA }));
}

test('the status picker lists every playlist, sequence and song, and starts the last one picked', async ({ page }) => {
  await bigLists(page);
  const sent: any[] = [];
  await page.route('**/api/command', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    sent.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ json: { status: 'OK' } });
  });
  // A playlist's details are asked for when it is picked: none to show.
  await page.route((u) => /\/api\/playlist\/fpp-tests/.test(decodeURIComponent(u.pathname)), (r) =>
    r.fulfill({ json: { name: 'x', leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } }));
  await page.goto('/index.php');
  const select = page.locator('#playlistSelect');
  await expect(select.locator('optgroup[label="Playlists"] option')).toHaveCount(200, { timeout: 30_000 });
  await expect(select.locator('optgroup[label="Sequences"] option')).toHaveCount(500);
  await expect(select.locator('optgroup[label="Media"] option')).toHaveCount(300);

  const last = `${SEQUENCES[499]}.fseq`;
  await select.selectOption(last);
  await page.locator('#btnPlay').click();
  await expect.poll(() => sent).toHaveLength(1);
  expect(sent[0].args[0]).toBe(last);
});

test('the File Manager lists every sequence, and its filter narrows them', async ({ page, request }) => {
  const was = String((await (await request.get('/api/settings/fileManagerTableFilter')).json()).value ?? '0');
  expect((await request.put('/api/settings/fileManagerTableFilter', { data: '1' })).ok()).toBe(true);
  try {
  const files = SEQUENCES.map((n, i) => ({ name: `${n}.fseq`, mtime: '11/13/26  10:00 AM', sizeBytes: 1000 + i, sizeHuman: '1 KB' }));
  await page.route((u) => /\/api\/files\/sequences$/i.test(u.pathname), (r) => r.fulfill({ json: { status: 'ok', files } }));
  await page.goto('/filemanager.php');
  const rows = page.locator('#tblSequences tbody tr.fileDetails');
  await expect(rows).toHaveCount(500, { timeout: 30_000 });
  await expect(rows.first()).toContainText('fpp-tests Song 000.fseq');

  // The name filter (shown with fileManagerTableFilter on): "Song 49" is 490..499.
  const filter = page.locator('#tab-sequence .bootstrap-table thead th[data-field="filename"] .filter-control input').locator('visible=true').first();
  await filter.fill('Song 49');
  await filter.press('Enter');
  await expect(rows).toHaveCount(10, { timeout: 10_000 });
  await expect(rows.last()).toContainText('fpp-tests Song 499.fseq');
  } finally {
    await request.put('/api/settings/fileManagerTableFilter', { data: was || '0' });
  }
});

test('a schedule of 120 entries loads whole and Save stores it unchanged', async ({ page, request }) => {
  const name = 'fpp-tests-big-schedule';
  const before = await (await request.get('/api/schedule')).json();
  expect((await request.post(`/api/playlist/${name}`, { data: { name, version: 4, desc: '', repeat: 0, loopCount: 0,
    leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } })).ok()).toBe(true);
  const year = new Date().getFullYear();
  const entries = Array.from({ length: 120 }, (_, i) => ({
    enabled: i % 7 ? 1 : 0, day: i % 15, type: 'playlist', playlist: name,
    startTime: `${String(10 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
    endTime: '23:30:00', startDate: `${year}-11-${String(1 + (i % 28)).padStart(2, '0')}`, endDate: `${year + 1}-01-06`,
    repeat: i % 3 ? 0 : 1, stopType: i % 3,
  }));
  try {
    expect((await request.post('/api/schedule', { data: entries })).ok()).toBe(true);
    const stored = await (await request.get('/api/schedule')).json();
    await page.goto('/scheduler.php');
    await expect(page.locator('#tblScheduleBody > tr')).toHaveCount(120, { timeout: 30_000 });
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await page.evaluate(() => (window as any).SaveSchedule());
    expect((await posted).ok()).toBe(true);
    // Save fills in defaults (offsets) and leaves out what is implied; what
    // each entry does must come back the same.
    const keys = ['enabled', 'day', 'playlist', 'startTime', 'endTime', 'startDate', 'endDate', 'repeat', 'stopType'];
    const pick = (l: any[]) => l.map((e) => Object.fromEntries(keys.map((k) => [k, String(e[k])])));
    expect(pick(await (await request.get('/api/schedule')).json())).toEqual(pick(stored));
  } finally {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    await request.delete(`/api/playlist/${name}`);
  }
});
