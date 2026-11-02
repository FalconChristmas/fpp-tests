import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The File Manager's Delete buttons: styled like the other action buttons
// until hovered, and only an enabled one turns the danger colour.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);

test('a File Manager Delete button turns red only while hovered, and never while disabled', async ({ page }) => {
  // Regression: 6d42b649a.  Delete buttons were btn-outline-danger, red all
  // the time and standing out on the page.  They now take btn-hover-danger
  // (via data-btn-enabled-class, so a disabled one never gets it) and show
  // the danger colour only on hover.
  inPlayer('sh', '-c', `echo x > ${MEDIA}/sequences/fpp-tests-hoverdel.fseq`);
  try {
    await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-sequence`);
    await page.waitForLoadState('load');
    await page.locator('#tab-sequence-tab').click();
    const pane = page.locator('#tab-sequence');
    const fileRow = pane.locator('#tblSequences tbody tr', { hasText: 'fpp-tests-hoverdel.fseq' });
    await expect(fileRow).toBeVisible();
    const del = pane.locator('input[value="Delete"]');
    const other = pane.locator('input[value="Download"]');

    // Nothing selected: disabled, no hover class, and hovering it stays plain.
    await expect(del).toHaveClass(/disableButtons/);
    await expect(del).not.toHaveClass(/btn-hover-danger/);
    const plain = await bg(other);
    await del.hover({ force: true });
    await page.waitForTimeout(500);
    expect(await bg(del), 'a disabled Delete hovered').toBe(plain);

    await fileRow.click();
    await expect(del).toHaveClass(/btn-hover-danger/);
    await expect(del).not.toHaveClass(/disableButtons/);
    await page.mouse.move(5, 5);
    // At rest it looks like the other action buttons, not red.
    await expect(other).not.toHaveClass(/disableButtons/);
    await expect.poll(async () => (await bg(del)) === (await bg(other)), { message: 'Delete at rest matches Download' }).toBe(true);
    const danger = await page.evaluate(() => {
      const p = document.createElement('i');
      p.style.color = 'var(--bs-danger)';
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    });
    expect(await bg(del)).not.toBe(danger);
    await del.hover();
    await expect.poll(() => bg(del), { message: 'an enabled Delete hovered' }).toBe(danger);
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await bg(del)) === (await bg(other))).toBe(true);
  } finally {
    inPlayer('sh', '-c', `rm -f ${MEDIA}/sequences/fpp-tests-hoverdel.fseq`);
  }
});
