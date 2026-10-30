import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager's column filters (the Filter setting at the bottom of the
// page, Advanced level and up), the item count they change, and sorting by
// date.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

function sh(cmd: string): string {
  return inPlayer('sh', '-c', cmd);
}

let saved: Record<string, string> = {};

test.beforeEach(async ({ request }) => {
  for (const key of ['uiLevel', 'fileManagerTableFilter']) {
    saved[key] = String((await (await request.get(`/api/settings/${key}`)).json()).value ?? '');
  }
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
  expect((await request.put('/api/settings/fileManagerTableFilter', { data: '1' })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: saved.uiLevel || '0' });
  await request.put('/api/settings/fileManagerTableFilter', { data: saved.fileManagerTableFilter || '1' });
});

async function openTab(page: Page, tab: string, table: string) {
  // A query that differs each time: a URL differing only in its #hash
  // doesn't load the page again.
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-${tab}`);
  await page.waitForLoadState('load');
  await page.locator(`#tab-${tab}-tab`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
  await expect(page.locator(`#tbl${table} tbody tr`).first()).toBeVisible();
}

// The File column's filter box.  Bootstrap Table filters as keys are typed.
function nameFilter(page: Page, tab: string) {
  return page.locator(`#tab-${tab} .filter-control input.bootstrap-table-filter-control-filename:visible`).first();
}

for (const [tab, table, dir, ext] of [
  ['sequence', 'Sequences', 'sequences', 'fseq'],
  ['video', 'Videos', 'videos', 'mp4'],
] as const) {
  test(`filtering the ${table} tab counts what is shown and says "Filtered items"`, async ({ page }) => {
    // Regression: 151b8dbef.  The tabs' divs were divSeq and divVideo, but the
    // heading is found through '#div' + the table's name: filtering threw a
    // TypeError there and the heading kept saying "Items".
    //
    // Regression: 8737b7746.  Broken again by 6274b3d72 (Bootstrap Table in
    // place of tablesorter): a filter drops the rows it hides from the DOM,
    // so UpdateFileCount() counted as many rows as were left and never took
    // the table for filtered; and bootstrapTableOptions_Sequences had no
    // onPostFilter, so the Sequences count was not updated at all.
    const files = [`fpp-tests-filter-a.${ext}`, `fpp-tests-filter-b.${ext}`];
    sh(files.map((f) => `echo x > ${MEDIA}/${dir}/${f}`).join(' && '));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await openTab(page, tab, table);
      const heading = page.locator(`#div${table} .fileCountlabelHeading`).first();
      await expect(heading).toHaveText(/^Items:/);
      await nameFilter(page, tab).pressSequentially('fpp-tests-filter-a');
      await expect(page.locator(`#tbl${table} tbody tr`)).toHaveCount(1);
      expect.soft(errors, 'page errors').toEqual([]);
      await expect.soft(page.locator(`#fileCount_${table}`)).toHaveText('1');
      await expect.soft(heading).toHaveText(/^Filtered items:/);
    } finally {
      sh(files.map((f) => `rm -f ${MEDIA}/${dir}/${f}`).join(' && '));
    }
  });
}

test('turning the filter off shows every row again', async ({ page }) => {
  // Regression: d7afdf9db.  Unticking Filter hid the filter boxes but left
  // their filter applied, with nothing on screen to clear it.
  //
  // Regression: fb5eb22d7.  Broken again by 6274b3d72:
  // FileManagerFilterToggled() only called Bootstrap Table's
  // toggleFilterControl, which left the filter rows on screen (the fixed
  // header's copy included) and the filter applied.
  const files = ['fpp-tests-filter-a.fseq', 'fpp-tests-filter-b.fseq'];
  sh(files.map((f) => `echo x > ${MEDIA}/sequences/${f}`).join(' && '));
  try {
    await openTab(page, 'sequence', 'Sequences');
    const rows = page.locator('#tblSequences tbody tr').filter({ hasText: 'fpp-tests-filter-' });
    await expect(rows).toHaveCount(2);
    await nameFilter(page, 'sequence').pressSequentially('fpp-tests-filter-a');
    await expect(rows).toHaveCount(1);
    await page.locator('#fileManagerTableFilter').uncheck();
    await expect.soft(page.locator('#tab-sequence .filter-control input:visible'), 'filter boxes left on screen').toHaveCount(0);
    await expect(rows).toHaveCount(2);
  } finally {
    sh(files.map((f) => `rm -f ${MEDIA}/sequences/${f}`).join(' && '));
  }
});

test('Date Modified sorts by date, not by the text of the date', async ({ page }) => {
  // Regression: 2e8c734d8.  The column sorted as text ("mm/dd/yy hh:mm AM"),
  // so January 2026 came before December 2025, and 1 PM before 9 AM.  (Its
  // sugar parser went with tablesorter in 6274b3d72; Bootstrap Table's
  // dateSorter does the job now.)
  // In date order; the names sort otherwise, and so does the dates' text.
  const files: [string, string][] = [
    ['fpp-tests-date-d.fseq', '2025-02-01 10:00'],
    ['fpp-tests-date-c.fseq', '2025-12-31 23:00'],
    ['fpp-tests-date-b.fseq', '2026-01-02 09:00'],
    ['fpp-tests-date-a.fseq', '2026-01-02 13:00'],
  ];
  sh(files.map(([f, d]) => `echo x > ${MEDIA}/sequences/${f} && touch -d '${d}' ${MEDIA}/sequences/${f}`).join(' && '));
  try {
    await openTab(page, 'sequence', 'Sequences');
    // Bootstrap Table draws the header twice (a fixed copy over the body).
    await page.locator('#divSequences th[data-field="dateModified"] .sortable:visible').first().click();
    const names = () => page.locator('#tblSequences tbody tr td:first-child').allInnerTexts()
      .then((t) => t.map((s) => s.trim()).filter((s) => s.startsWith('fpp-tests-date-')));
    await expect.poll(names).toEqual(files.map(([f]) => f));
  } finally {
    sh(files.map(([f]) => `rm -f ${MEDIA}/sequences/${f}`).join(' && '));
  }
});
