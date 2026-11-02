import { test, expect } from './fixtures';

// SetRestartFlag(2) is the page asking for "a quick restart is enough"; the
// flag stored must be 2 (the header's Restart FPPD then asks fppd for a
// quick one), and a full restart (1) must not be downgraded by it.

async function stored(page: import('@playwright/test').Page): Promise<string> {
  return (await (await page.request.get('/api/settings/restartFlag')).json()).value;
}

test('a quick-restart request is stored as 2, and does not replace a pending full restart', async ({ page }) => {
  // Regression: b3c83a169.  SetRestartFlag() saved through
  // SetSettingRestart('restartFlag', value), which tells SetSetting() to
  // raise the restart flag to 1 once the save succeeds, so a quick restart
  // (2) ended up stored as a full one (1).
  await page.request.put('/api/settings/restartFlag', { data: '0', headers: { 'Content-Type': 'text/plain' } });
  try {
    await page.goto('/about.php');
    await page.waitForFunction(() => typeof (window as any).SetRestartFlag === 'function');
    await page.evaluate(() => (window as any).SetRestartFlag(2));
    expect(await stored(page)).toBe('2');
    // The old path raised the flag to 1 in the save's success handler, a
    // moment after the request that stored 2.
    await page.waitForTimeout(1_500);
    expect(await stored(page)).toBe('2');

    await page.evaluate(() => (window as any).SetRestartFlag(1));
    expect(await stored(page)).toBe('1');
    // A full restart is pending: asking for a quick one leaves it alone.
    await page.evaluate(() => (window as any).SetRestartFlag(2));
    expect(await stored(page)).toBe('1');

    await page.evaluate(() => (window as any).SetRestartFlag(0));
    expect(await stored(page)).toBe('0');
  } finally {
    await page.request.put('/api/settings/restartFlag', { data: '0', headers: { 'Content-Type': 'text/plain' } });
  }
});
