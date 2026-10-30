import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager page's script tag, its Tail action on a log, its log
// streaming endpoint, and what it lets you do with a subdirectory.

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

async function openTab(page: Page, tab: string, table: string) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-${tab}`);
  await page.waitForLoadState('load');
  await page.locator(`#tab-${tab}-tab`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
  await expect(page.locator(`#tbl${table} tbody tr`).first()).toBeVisible();
}

test("the page's own script is asked for under its modification time, so a changed one is fetched", async ({ page }) => {
  // Regression: 73ef552aa.  js/fpp-filemanager.js was loaded under the same
  // URL whatever its contents, so after an upgrade the browser kept running
  // its cached copy against the new page.
  const js = '/opt/fpp/www/js/fpp-filemanager.js';
  const mtime = sh(`stat -c %Y ${js}`).trim();
  const asked: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('/js/fpp-filemanager.js')) asked.push(new URL(r.url()).search);
  });
  try {
    await page.goto('/filemanager.php');
    await page.waitForLoadState('load');
    expect(asked).toEqual([`?ref=${mtime}`]);
    // The receiving end: a new copy of the script (a new mtime) is a new URL,
    // which the browser has nothing cached for.
    sh(`touch -d '2026-01-02 03:04:05' ${js}`);
    const changed = sh(`stat -c %Y ${js}`).trim();
    expect(changed).not.toBe(mtime);
    await page.reload();
    await page.waitForLoadState('load');
    expect(asked).toEqual([`?ref=${mtime}`, `?ref=${changed}`]);
  } finally {
    sh(`touch -d @${mtime} ${js}`);
  }
});

test('Tail shows the last 250 lines of a log', async ({ page }) => {
  // Regression: b7d5c77ea.  Tail asked for the last 50 lines.
  const log = `${MEDIA}/logs/fpp-tests-tail.log`;
  sh(`seq -f 'fpp-tests line %g' 1 400 > ${log}`);
  try {
    await openTab(page, 'logs', 'Logs');
    await row(page, 'Logs', 'fpp-tests-tail.log').click();
    await page.locator('#tab-logs input[value="Tail"]').click();
    const text = page.locator('#fileViewerDialog #fileViewerText');
    await expect(text).toContainText('fpp-tests line 400', { timeout: 15_000 });
    const lines = (await text.innerText()).split('\n').filter((l) => l.startsWith('fpp-tests line'));
    expect(lines[0]).toBe('fpp-tests line 151');
    expect(lines).toHaveLength(250);
  } finally {
    sh(`rm -f ${log}`);
  }
});

test.describe('the log streaming endpoint', () => {
  const log = `${MEDIA}/logs/fpp-tests-tailfollow.log`;
  test.beforeEach(() => sh(`seq -f 'fpp-tests line %g' 1 600 > ${log}`));
  test.afterEach(() => sh(`rm -f ${log}`));

  // The data lines the stream sends before anything is appended.
  async function firstData(page: Page, query: string): Promise<string[]> {
    await page.goto('/filemanager.php');
    return page.evaluate(async (url) => {
      const ctl = new AbortController();
      const r = await fetch(url, { signal: ctl.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let text = '';
      const until = Date.now() + 3000;
      // Everything tail -n has to send comes at once; give it a moment.
      while (Date.now() < until) {
        const t = setTimeout(() => ctl.abort(), until - Date.now());
        try {
          const { value, done } = await reader.read();
          clearTimeout(t);
          if (done) break;
          text += dec.decode(value);
        } catch {
          break;
        }
      }
      ctl.abort();
      return text.split('\n').filter((l) => l.startsWith('data: ') && l.length > 6).map((l) => l.slice(6));
    }, `/api/file/Logs/tailfollow/fpp-tests-tailfollow.log${query}`);
  }

  test('starts with the last 50 lines, or as many as ?lines= asks, up to 500', async ({ page }) => {
    // Feature: 9606d6ea2 (GET /api/file/Logs/tailfollow/<log>, the log
    // streamed as Server-Sent Events from the last N lines on).
    const def = await firstData(page, '');
    expect(def[0]).toBe('fpp-tests line 551');
    expect(def).toHaveLength(50);
    const three = await firstData(page, '?lines=3');
    expect(three).toEqual(['fpp-tests line 598', 'fpp-tests line 599', 'fpp-tests line 600']);
    // (Counted by its first and last line: see the next test.)
    const many = await firstData(page, '?lines=100000');
    expect(many[0]).toBe('fpp-tests line 101');
    expect(many[many.length - 1]).toBe('fpp-tests line 600');
  });

  test('sends a burst longer than 4 kB as whole lines', async ({ page }) => {
    // Regression: 34149fbd9.  From 9606d6ea2 on, TailFollowFile() sent its
    // buffer whenever it passed 4096 bytes, wherever the last read ended, and
    // put "data: " before each piece.  A line that straddled a send arrived as
    // two, which the Tail Follow dialog showed on two lines.
    const many = await firstData(page, '?lines=500');
    expect(many.filter((l) => !/^fpp-tests line \d+$/.test(l))).toEqual([]);
    expect(many).toHaveLength(500);
  });

  test('streams only logs', async ({ request }) => {
    // Feature: 9606d6ea2.
    sh(`cp ${log} ${MEDIA}/config/fpp-tests-tailfollow.log`);
    try {
      const r = await request.get('/api/file/Config/tailfollow/fpp-tests-tailfollow.log', { timeout: 10_000 });
      expect(r.status()).toBe(403);
    } finally {
      sh(`rm -f ${MEDIA}/config/fpp-tests-tailfollow.log`);
    }
  });
});

test('a subdirectory can be selected and deleted, contents and all, but not played', async ({ page }) => {
  // Feature: 6e821e207.  A subdirectory row was unselectable ("Empty
  // Subdir"), and DeleteFile() only unlink()ed, which a directory refuses.
  // Now the row selects, the single-file actions that make no sense for a
  // directory (noDirButton) stay disabled, and Delete removes it with what
  // is in it.
  const sub = `${MEDIA}/sequences/fpp-tests-deldir`;
  sh(`mkdir -p ${sub}/deeper && echo x > ${sub}/inner.fseq && echo x > ${sub}/deeper/more.fseq`);
  try {
    await openTab(page, 'sequence', 'Sequences');
    const dirRow = row(page, 'Sequences', 'fpp-tests-deldir');
    await dirRow.click();
    await expect(dirRow).toHaveClass(/selectedEntry/);
    const pane = page.locator('#tab-sequence');
    await expect(pane.locator('input[value="Delete"]')).toBeEnabled();
    for (const name of ['Sequence Info', 'Add To Playlist', 'Download', 'Rename']) {
      await expect.soft(pane.locator(`input[value="${name}"]`), name).toHaveClass(/disableButtons/);
    }
    await pane.locator('input[value="Delete"]').click();
    const dialog = page.locator('#confirmDeleteFile');
    await expect(dialog).toContainText('fpp-tests-deldir');
    await dialog.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => exists(sub)).toBe(false);
    await expect(dirRow).toHaveCount(0);
  } finally {
    sh(`rm -rf ${sub}`);
  }
});
