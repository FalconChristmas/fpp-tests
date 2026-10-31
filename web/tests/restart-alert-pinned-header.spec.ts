import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A page's table header is pinned under the page header once the page is
// scrolled past it (Zebra Pin, which works out where that is when it is set
// up).  The restart and reboot notices sit above the page's content: showing
// or hiding one moves the table header down or up.

const HEADER = '.tableTabPageHeader:visible';

// Where the table header is now, and where scrolling pins it: the fixed page
// header's height above it.
async function layout(page: Page) {
  return page.evaluate((sel) => {
    const $ = (window as any).$;
    const el = $(sel).first();
    return {
      top: el.offset().top as number,
      spacing: ($('.header').css('position') == 'fixed' ? $('.header').outerHeight(true) : 0) as number,
    };
  }, HEADER);
}

// Whether the table header is pinned with the page scrolled to y.
async function pinnedAt(page: Page, y: number) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(Math.round(y));
  // Zebra Pin acts on the scroll event.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.locator(HEADER).first().evaluate((el) => el.classList.contains('Zebra_Pin'));
}

// Back to the top, the table header unpinned.
async function toTop(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(HEADER).first()).not.toHaveClass(/Zebra_Pin/);
}

async function setFlag(page: Page, flag: string, value: number) {
  await page.evaluate(({ flag, value }) => {
    (window as any).settings[flag] = value;
    (window as any).CheckRestartRebootFlags();
  }, { flag, value });
}

test('the table header pins where it is after a restart or reboot notice comes or goes', async ({ page }) => {
  // Regression: 5f64d4afa.  The notice was shown or hidden without the pin
  // being set up again, so the table header was pinned at the scroll position
  // it had before: with a notice shown it jumped to the top while still a
  // notice's height below it, and with one hidden it scrolled away under the
  // page header before pinning.
  await page.setViewportSize({ width: 1400, height: 600 });
  await page.goto('/channeloutputs.php');
  await expect(page.locator(HEADER).first()).toBeVisible();
  await page.waitForFunction(() => !!(window as any).zp_tablePageHeader);
  // Room to scroll, whatever this player's outputs are.
  await page.evaluate(() => { document.body.style.paddingBottom = '3000px'; });

  for (const flag of ['restartFlag', 'rebootFlag']) {
    await toTop(page);
    const before = await layout(page);
    await setFlag(page, flag, 1);
    await expect(page.locator(`#${flag}`)).toBeVisible();
    const shown = await layout(page);
    expect(shown.top, `${flag} moved the table header down`).toBeGreaterThan(before.top + 10);
    // Just short of where it now pins, and just past it.
    expect(await pinnedAt(page, shown.top - shown.spacing - 5), `${flag} shown: pinned early`).toBe(false);
    expect(await pinnedAt(page, shown.top - shown.spacing + 5), `${flag} shown: not pinned`).toBe(true);

    await toTop(page);
    await setFlag(page, flag, 0);
    await expect(page.locator(`#${flag}`)).toBeHidden();
    const hidden = await layout(page);
    expect(await pinnedAt(page, hidden.top - hidden.spacing + 5), `${flag} hidden: not pinned`).toBe(true);
    expect(await pinnedAt(page, hidden.top - hidden.spacing - 5), `${flag} hidden: pinned early`).toBe(false);
  }
});
