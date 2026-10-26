import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';

// The Restart Required banner under the header: its message and its button.
// On a phone the message takes two lines and the button goes under it; it
// was an inline-block sitting right against the message's last line, and is
// now the second item of a wrapping flex row with a gap between the two.
// The banner is raised the way a settings change raises it, through the
// restartFlag setting.

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

test('on a phone the Restart Required button sits clear of its message', async ({ page, request }) => {
  // Regression: 50616a38b.  The message and the button were inline-blocks
  // in the banner; on a phone the button sat against the message.
  expect((await request.put('/api/settings/restartFlag', { data: '1' })).ok()).toBe(true);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/index.php');
    const banner = page.locator('#restartFlag');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    const message = banner.getByText('Settings have changed.');
    const button = banner.locator('button[name=btnRestartFPPD]');
    await expect(button).toBeVisible();

    const m = await box(message);
    const b = await box(button);
    // The control: on a phone width the two don't fit on one line.
    expect(m.width + b.width).toBeGreaterThan((await box(banner)).width - 32);
    // The button is under the message, with a gap, and inside the banner.
    expect(b.y, JSON.stringify({ message: m, button: b })).toBeGreaterThanOrEqual(m.y + m.height + 4);
    const outer = await box(banner);
    expect(b.y + b.height).toBeLessThanOrEqual(outer.y + outer.height);
  } finally {
    await request.put('/api/settings/restartFlag', { data: '0' });
  }
});
