import { test, expect } from './fixtures';

// The hot links at the top of each Troubleshooting group: a link to each
// command's output and, beside it, the verdict badge the page fills in.

test('a hot link\'s badge stays on its link\'s line, at phone and desktop widths', async ({ page }) => {
  // Regression: f0ec428cb.  The links were in a four-column grid with the
  // badge as inline text, so a link with a long title and a two-badge verdict
  // wrapped the badge onto a line of its own, away from its link.
  for (const width of [375, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/troubleshooting.php');
    const spans = page.locator('span[id^="hotlinkstatus_"]');
    await expect(spans.first()).toBeAttached();
    const count = await spans.count();
    expect(count).toBeGreaterThan(3);
    // Put the widest verdict a command can have in every badge slot, and
    // measure in the same task: the page fills the slots itself as its
    // commands finish.
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('span[id^="hotlinkstatus_"]').forEach((s) => {
        s.innerHTML = '<span class="badge text-bg-danger ms-1">12 failed</span> <span class="badge text-bg-warning">12 warnings</span>';
      });
      document.querySelectorAll('span[id^="hotlinkstatus_"]').forEach((s) => {
        const link = s.parentElement!.querySelector('a');
        const badge = s.firstElementChild as HTMLElement | null;
        if (!link || !badge || !(s as HTMLElement).offsetParent) return;
        const a = link.getClientRects(), b = badge.getClientRects();
        if (!a.length || !b.length) return;
        // The badge's first line starts where the link's last line is.
        const last = a[a.length - 1];
        if (Math.abs(b[0].top - last.top) > 8 && Math.abs(b[0].bottom - last.bottom) > 8) out.push(s.id);
      });
      return out;
    });
    expect(bad, `badges off their link's line at ${width}px`).toEqual([]);
  }
});
