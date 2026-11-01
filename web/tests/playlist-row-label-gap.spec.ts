import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A playlist row's bold type label ("Command:") must not run into the entry's
// details, whatever the font size or zoom.

async function gotoPage(page: Page, path: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(path, { waitUntil: 'commit', timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }
  throw lastError;
}

test('a playlist row label has room before its details at a large font size', async ({ page }) => {
  // Regression: GitHub issue #3158.  .psiHeader was width:10% / min-width:100px
  // with nowrap, so a label wider than 100px ("Command:" at a larger font size
  // or browser zoom) spilled over .psiDataSimple.  .psiDuration had the same rule.
  await gotoPage(page, '/playlists.php');
  await page.waitForFunction(() => typeof (window as any).GetPlaylistRowHTML === 'function');
  await page.addStyleTag({ content: 'html, body { font-size: 24px !important; }' });

  const gaps = await page.evaluate(() => {
    const entries: Array<[string, any]> = [
      ['command', { type: 'command', command: 'FPP After Hours Plugin - Stop', args: ['0', '30'] }],
      ['playlist', { type: 'playlist', name: 'Some Long Playlist Name' }],
      ['both', { type: 'both', sequenceName: 'a.fseq', mediaName: 'a.mp3' }],
    ];
    const out: Record<string, number> = {};
    for (const [label, entry] of entries) {
      for (const editMode of [true, false]) {
        const table = document.createElement('table');
        table.style.cssText = 'position:fixed;top:0;left:0;width:1400px;';
        table.innerHTML = '<tbody>' + (window as any).GetPlaylistRowHTML(0, entry, editMode) + '</tbody>';
        document.body.appendChild(table);
        const header = table.querySelector('.psiHeader') as HTMLElement;
        const data = table.querySelector('.psiDataSimple') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(header);
        out[`${label} ${editMode ? 'edit' : 'view'}`] =
          data.getBoundingClientRect().left - range.getBoundingClientRect().right;
        table.remove();
      }
    }
    return out;
  });

  for (const [row, gap] of Object.entries(gaps)) {
    expect(gap, `${row} row: space between its label and its details`).toBeGreaterThanOrEqual(2);
  }
});
