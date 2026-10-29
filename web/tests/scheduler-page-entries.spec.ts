import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Scheduler page (scheduler.php): what a row shows for an entry, what
// Save stores, the user-defined holiday editor, and fppd's schedule built
// from what was saved.  Each test puts the schedule back as it found it.

const PLAYLIST = 'fpp-tests-sched-page';
const HOLIDAYS = '/home/fpp/media/config/user-holidays.json';

let before: unknown;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(pl.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  await request.delete(`/api/playlist/${PLAYLIST}`);
});

const year = new Date().getFullYear();

function entry(extra: object = {}) {
  return {
    enabled: 1, day: 7, type: 'playlist', playlist: PLAYLIST, startTime: '19:00:00', endTime: '20:00:00',
    startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
  };
}

async function storeSchedule(request: APIRequestContext, schedule: object[]) {
  expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function openScheduler(page: Page) {
  await page.goto('/scheduler.php');
  // getSchedule() has run: the template's playlist list is filled.
  await expect(page.locator('.fppTableRowTemplate .schPlaylist option', { hasText: PLAYLIST })).toHaveCount(1);
}

const rows = (page: Page) => page.locator('#tblScheduleBody > tr');

// Save, and the schedule Save stored.
async function save(page: Page, request: APIRequestContext) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.evaluate(() => (window as any).SaveSchedule());
  expect((await posted).ok()).toBe(true);
  return (await request.get('/api/schedule')).json();
}

async function addEntry(page: Page) {
  const n = await rows(page).count();
  await page.locator('[onclick="AddScheduleEntry();"]:visible').first().click();
  await expect(rows(page)).toHaveCount(n + 1);
  return rows(page).nth(n);
}

test.describe('command entries', () => {
  test('the command list does not offer Start Playlist', async ({ page }) => {
    // Regression: 83b9d7a2c (#1966).  A scheduled Start Playlist command
    // only half works next to scheduling the playlist itself, so the
    // scheduler's command list leaves it out.
    await openScheduler(page);
    const row = await addEntry(page);
    await row.locator('.schType').selectOption('command');
    const commands = row.locator('select.cmdTmplCommand');
    // The control: the list is filled, with its neighbours.
    await expect(commands.locator('option[value="Stop Now"]')).toHaveCount(1);
    await expect(commands.locator('option[value="Start Playlist"]')).toHaveCount(0);
  });

  test('a command that does not repeat has no end time, and saves its start time as its end', async ({ page, request }) => {
    // Regression: da664c528.  A command entry with Repeat None showed an end
    // time that meant nothing, and saved whatever it held (24:00 for a new
    // entry).
    await storeSchedule(request, []);
    await openScheduler(page);
    const row = await addEntry(page);
    await row.locator('.schType').selectOption('command');
    await row.locator('select.cmdTmplCommand').selectOption('Stop Now');
    await expect(row.locator('.schRepeat')).toHaveValue('0');
    await expect(row.locator('.schEndTime')).toBeHidden();
    await row.locator('.schStartTime').fill('21:30');
    await row.locator('.schStartTime').press('Tab');
    // A repeating command needs one, and gets it back.
    await row.locator('.schRepeat').selectOption('500');
    await expect(row.locator('.schEndTime')).toBeVisible();
    await row.locator('.schRepeat').selectOption('0');
    await expect(row.locator('.schEndTime')).toBeHidden();
    const [saved] = await save(page, request);
    expect(saved).toMatchObject({ command: 'Stop Now', repeat: 0 });
    expect(saved.endTime).toBe(saved.startTime);
    expect(saved.startTime).toMatch(/^21:30/);
  });

  test('a command row with nothing chosen saves without a script error, as an empty command', async ({ page, request }) => {
    // Regression: 20054b05d.  GetScheduleEntryRowData() used an undefined
    // "command" for a row with no command JSON, so Save threw before it
    // stored anything; it also stored a null command (shown as "null") and
    // leaked its entry into a global "e".
    await storeSchedule(request, []);
    const errors = pageErrors(page);
    await openScheduler(page);
    const row = await addEntry(page);
    await row.locator('.schType').selectOption('command');
    // No command picked, and no command JSON yet.
    await row.evaluate((r) => {
      (r.querySelector('select.cmdTmplCommand') as HTMLSelectElement).selectedIndex = -1;
      r.querySelector('.cmdTmplJSON')!.textContent = '';
    });
    const saved = await save(page, request);
    expect(errors).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].command).toBe('');
    expect(await page.evaluate(() => 'e' in window), 'a global "e" leaked from the row reader').toBe(false);
    // fppd takes the schedule it was given.
    expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
    expect((await request.get('/api/fppd/schedule')).ok()).toBe(true);
  });
});

test('a row naming a playlist or command that is not there is marked, and choosing one clears the mark', async ({ page, request }) => {
  // Regression: 3b28e6ed3.  A row whose playlist had been deleted (or whose
  // command no longer existed) showed an empty list and nothing else, and
  // saved a null.
  await storeSchedule(request, [
    entry({ playlist: 'fpp-tests-no-such-playlist' }),
    entry(),
    entry({ type: 'command', playlist: '', command: 'fpp-tests no such command', args: [] }),
  ]);
  await openScheduler(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0).locator('.schPlaylist')).toHaveClass(/inputWarning/);
  // The control: a row whose playlist is there is not marked.
  await expect(rows(page).nth(1).locator('.schPlaylist')).not.toHaveClass(/inputWarning/);
  await expect(rows(page).nth(2).locator('.cmdTmplCommand')).toHaveClass(/inputWarning/);

  await rows(page).nth(0).locator('.schPlaylist').selectOption(PLAYLIST);
  await expect(rows(page).nth(0).locator('.schPlaylist')).not.toHaveClass(/inputWarning/);
});

test.describe('user-defined holidays', () => {
  test.skip(!container, 'reads and restores config/user-holidays.json inside the run-web.sh container');
  let holidaysBefore: string | null = null;
  test.beforeEach(() => {
    holidaysBefore = inPlayer('sh', '-c', `cat ${HOLIDAYS} 2>/dev/null || true`) || null;
    inPlayer('rm', '-f', HOLIDAYS);
  });
  test.afterEach(() => {
    if (holidaysBefore) inPlayer('sh', '-c', `cat > ${HOLIDAYS} <<'EOF'\n${holidaysBefore}\nEOF`);
    else inPlayer('rm', '-f', HOLIDAYS);
  });

  async function openEditor(page: Page) {
    await page.evaluate(() => {
      (window as any).fppTestsModalShown = false;
      document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
    });
    await page.locator('[onclick="OpenHolidayEditor();"]:visible').first().click();
    await page.waitForFunction(() => (window as any).fppTestsModalShown);
    return page.locator('#holidayEditorModal');
  }

  const storedHolidays = () => {
    const text = inPlayer('sh', '-c', `cat ${HOLIDAYS} 2>/dev/null || true`);
    return text ? JSON.parse(text) : null;
  };

  test('a holiday added in the editor is saved, offered for a date, and scheduled by fppd', async ({ page, request }) => {
    // Feature: 31b095147.  The Scheduler's Edit Holidays dialog keeps the
    // user's own holidays in config/user-holidays.json, and the date lists
    // offer them beside the locale's.
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await storeSchedule(request, [entry()]);
    await openScheduler(page);
    const modal = await openEditor(page);
    await modal.getByRole('button', { name: 'Add Holiday' }).click();
    const row = modal.locator('#tblUserHolidaysBody tr').last();
    await row.locator('.holName').fill('Fpp Tests Day');
    await row.locator('.holName').blur();
    await row.locator('.holShortName').fill('FppTestsDay');
    await row.locator('.holMonth').selectOption(String(tomorrow.getMonth() + 1));
    await row.locator('.holDay').selectOption(String(tomorrow.getDate()));
    const reloaded = page.waitForEvent('load');
    await modal.getByRole('button', { name: 'Save' }).click();
    await reloaded;
    expect(storedHolidays()).toEqual([
      { name: 'Fpp Tests Day', shortName: 'FppTestsDay', month: tomorrow.getMonth() + 1, day: tomorrow.getDate() },
    ]);

    // The date lists offer it, and an entry can be pinned to it.
    await expect(rows(page)).toHaveCount(1);
    const hol = rows(page).first().locator('select.holStartDate');
    await expect(hol.locator('option[value="FppTestsDay"]')).toHaveText('Fpp Tests Day');
    await rows(page).first().evaluate((r) => {
      for (const c of ['.schStartDate', '.schEndDate']) (r.querySelector(c) as HTMLInputElement).value = 'FppTestsDay';
    });
    const saved = await save(page, request);
    expect(saved[0]).toMatchObject({ startDate: 'FppTestsDay', endDate: 'FppTestsDay' });

    // The receiving end: fppd schedules the entry on that day only.
    await request.post('/api/schedule/reload');
    await expect.poll(async () => {
      const items = (await (await request.get('/api/fppd/schedule')).json()).schedule.items as { startTime: number }[];
      return [...new Set(items.map((i) => new Date(i.startTime * 1000).toDateString()))];
    }, { timeout: 10_000 }).toEqual([tomorrow.toDateString()]);
  });

  test('the config name fills in from the display name, and a half-filled holiday is refused', async ({ page }) => {
    // Regression: 30d87b7f8.  The Config name had to be typed by hand, and a
    // row with only one of the two names was dropped on Save without a
    // word.
    await openScheduler(page);
    const modal = await openEditor(page);
    await modal.getByRole('button', { name: 'Add Holiday' }).click();
    const row = modal.locator('#tblUserHolidaysBody tr').last();
    await row.locator('.holName').fill('Fpp Tests: Day 2!');
    await row.locator('.holName').blur();
    await expect(row.locator('.holShortName')).toHaveValue('FppTestsDay2');

    await row.locator('.holShortName').fill('');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(row.locator('.holShortName')).toHaveClass(/is-invalid/);
    await expect(modal).toBeVisible();
    expect(storedHolidays()).toBeNull();
  });

  test('renaming a holiday\'s config name moves the schedule entries that use it', async ({ page, request }) => {
    // Regression: 30d87b7f8.  Renaming a holiday left the schedule naming
    // the old config name, which no holiday had any more: the entry fell
    // back to running across its whole date range.
    inPlayer('sh', '-c', `echo '[{"name":"Fpp Tests Day","shortName":"FppTestsOld","month":6,"day":20}]' > ${HOLIDAYS}`);
    await storeSchedule(request, [entry({ startDate: 'FppTestsOld', endDate: 'FppTestsOld' }), entry()]);
    await openScheduler(page);
    const modal = await openEditor(page);
    const row = modal.locator('#tblUserHolidaysBody tr').first();
    await expect(row.locator('.holShortName')).toHaveValue('FppTestsOld');
    await row.locator('.holShortName').fill('FppTestsNew');
    const reloaded = page.waitForEvent('load');
    await modal.getByRole('button', { name: 'Save' }).click();
    await reloaded;
    expect(storedHolidays()[0].shortName).toBe('FppTestsNew');
    const schedule = await (await request.get('/api/schedule')).json();
    expect(schedule[0]).toMatchObject({ startDate: 'FppTestsNew', endDate: 'FppTestsNew' });
    expect(schedule[1]).toMatchObject({ startDate: `${year}-01-01` });
  });
});

test.describe('on a small touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 400, height: 800 } });

  test('an entry dated by holiday keeps its holiday through load and Save', async ({ page, request }) => {
    // Regression: d35d36e2c.  On a touch screen under 601px wide the date
    // boxes become native date inputs, which can't hold "Christmas": the
    // value was wiped, and Save stored the entry with no dates.
    await storeSchedule(request, [entry({ startDate: 'Christmas', endDate: 'Christmas' }), entry()]);
    await openScheduler(page);
    await expect(rows(page)).toHaveCount(2);
    // The control: a plain date does become a native date input here.
    await expect(rows(page).nth(1).locator('.schStartDate')).toHaveAttribute('type', 'date');
    await expect(rows(page).nth(0).locator('.schStartDate')).toHaveValue('Christmas');
    const saved = await save(page, request);
    expect(saved[0]).toMatchObject({ startDate: 'Christmas', endDate: 'Christmas' });
    expect(saved[1]).toMatchObject({ startDate: `${year}-01-01`, endDate: `${year + 1}-12-31` });
  });
});

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 700, height: 500 } });

  test('the floating table header is held inside the schedule table\'s scrolling box', async ({ page, request }) => {
    // Regression: 8162630d5.  On a narrow screen the schedule table scrolls
    // sideways inside its box, but the box had no fppFThScrollContainer
    // class: the header floated over the table once the page scrolled down
    // was the whole table's width, sticking out past both sides of the box
    // (and off the screen) instead of being clipped to it.
    await storeSchedule(request, Array.from({ length: 12 }, () => entry()));
    await openScheduler(page);
    await expect(rows(page)).toHaveCount(12);
    const box = page.locator('#tblSchedule').locator('xpath=ancestor::div[contains(@class,"fppTableContents")]');
    const overflow = await box.evaluate((b) => b.scrollWidth - b.clientWidth);
    expect(overflow, 'the control: the table is wider than its box').toBeGreaterThan(100);

    await page.evaluate(() => window.scrollTo(0, 400));
    await box.evaluate((b) => { b.scrollLeft = 100; b.dispatchEvent(new Event('scroll')); });
    const measure = () => page.evaluate(() => {
      const floated = document.querySelector('.floatThead-container');
      const th = document.querySelector('.floatThead-container th:nth-child(3)');
      const cell = document.querySelector('#tblScheduleBody > tr td:nth-child(3)');
      if (!floated || !th || !cell) return null;
      const f = floated.getBoundingClientRect();
      const b = document.querySelector('#tblSchedule')!.closest('.fppTableContents')!.getBoundingClientRect();
      return {
        // The floated header's columns still line up with the rows'.
        column: Math.abs(Math.round(th.getBoundingClientRect().left - cell.getBoundingClientRect().left)),
        // How far the floated header sticks out past the box, left and right.
        outLeft: Math.max(0, Math.round(b.left - f.left)),
        outRight: Math.max(0, Math.round(f.right - b.right)),
      };
    });
    await expect.poll(measure).toEqual({ column: 0, outLeft: 0, outRight: 0 });
  });
});
