import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager's tables are Bootstrap Tables over a tbody the page
// writes itself.  Bootstrap Table's destroy() puts back the HTML it found at
// init, so a tbody rewritten while it managed the table, or a row taken out
// of it, came back as it was at init on the next destroy: deleted files as
// ghosts and new uploads missing until the page was reloaded (#3078).

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

function sh(cmd: string): string {
  return inPlayer('sh', '-c', cmd);
}

function exists(path: string): boolean {
  return sh(`test -e "${path}" && echo yes || echo no`).trim() === 'yes';
}

function row(page: Page, table: string, name: string) {
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

async function openAudio(page: Page) {
  await page.goto('/filemanager.php#tab-audio');
  await page.locator('#tab-audio-tab').click();
  await expect(page.locator('#tab-audio')).toBeVisible();
  await expect(page.locator('#tblMusic tbody tr').first()).toBeVisible();
}

test('a deleted file stays gone across a tab switch', async ({ page }) => {
  // Regression: 31916f7c7.  Delete took the row out of the tbody, and the
  // tab switch's destroy and re-init brought it back from the init snapshot.
  const keep = 'fpp-tests-keep.mp3';
  const gone = 'fpp-tests-ghost.mp3';
  sh(`echo x > ${MEDIA}/music/${keep}; echo x > ${MEDIA}/music/${gone}`);
  try {
    await openAudio(page);
    await expect(row(page, 'Music', gone)).toHaveCount(1);
    await row(page, 'Music', gone).click();
    await page.locator('#btnDeleteMusic').click();
    await page.locator('#confirmDeleteFile').getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => exists(`${MEDIA}/music/${gone}`)).toBe(false);
    await expect(row(page, 'Music', gone)).toHaveCount(0);

    await page.locator('#tab-sequence-tab').click();
    await expect(page.locator('#tab-sequence')).toBeVisible();
    await page.locator('#tab-audio-tab').click();
    await expect(page.locator('#tab-audio')).toBeVisible();
    // The control: the table is drawn again, with the file that is left.
    await expect(row(page, 'Music', keep)).toHaveCount(1);
    await expect(row(page, 'Music', gone)).toHaveCount(0);
  } finally {
    sh(`rm -f ${MEDIA}/music/${keep} ${MEDIA}/music/${gone}`);
  }
});

test('an upload shows up in its table without a reload', async ({ page }) => {
  // Regression: 31916f7c7.  The listing an upload's completion asks for
  // rewrote the tbody while Bootstrap Table managed it, and the destroy
  // before re-init put back the rows from before the upload.
  // Also 4f55f2ec4: the listing is asked for once the upload has been moved
  // into place, not before.
  const old = 'fpp-tests-before-upload.mp3';
  const name = 'fpp-tests-uploaded.mp3';
  sh(`echo x > ${MEDIA}/music/${old}`);
  try {
    await openAudio(page);
    await expect(row(page, 'Music', old)).toHaveCount(1);
    await page.locator('input.filepond--browser').setInputFiles({ name, mimeType: 'audio/mpeg', buffer: Buffer.alloc(4096, 1) });
    await expect.poll(() => exists(`${MEDIA}/music/${name}`), { timeout: 30_000 }).toBe(true);
    await expect(row(page, 'Music', name)).toHaveCount(1, { timeout: 15_000 });
    await expect(row(page, 'Music', old)).toHaveCount(1);
  } finally {
    sh(`rm -f ${MEDIA}/music/${old} ${MEDIA}/music/${name} ${MEDIA}/upload/${name}`);
  }
});
