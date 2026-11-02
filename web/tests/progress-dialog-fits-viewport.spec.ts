import { test, expect } from './fixtures';

// The progress dialog (plugin install, upgrades) shows a running log in a
// textarea inside a scrollable modal.

test('the progress dialog log fills the dialog without making its body scroll', async ({ page }) => {
  // Regression: 02b0fb0bb.  The log was a fixed 25-row textarea in a dialog
  // that was only as tall as its content: on a short window the textarea ran
  // past the dialog body, which grew a scrollbar of its own around the log's.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/index.php');
  await page.evaluate(() => (window as any).DisplayProgressDialog('pgTest', 'Installing'));
  const text = page.locator('#pgTestText');
  await expect(text).toBeVisible();
  await expect(page.locator('#pgTest.show')).toBeVisible();
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const body = document.querySelector('#pgTest .modal-body') as HTMLElement;
    const ta = document.getElementById('pgTestText') as HTMLElement;
    const content = document.querySelector('#pgTest .modal-content') as HTMLElement;
    return {
      bodyScroll: body.scrollHeight, bodyClient: body.clientHeight,
      ta: ta.getBoundingClientRect().height, bodyH: body.getBoundingClientRect().height,
      bottom: content.getBoundingClientRect().bottom, vh: window.innerHeight,
    };
  });
  expect(m.bodyScroll, 'body scrolls').toBeLessThanOrEqual(m.bodyClient + 20);
  expect(m.bottom, 'dialog runs off the window').toBeLessThanOrEqual(m.vh);
  expect(m.ta, 'log is small').toBeGreaterThan(m.bodyH * 0.7);
});
