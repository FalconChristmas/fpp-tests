import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { answerUpdateCheck } from './standin-http';

// System Stats' uptime counter and memory gauge.  The uptime is the
// system's, from api/system/status (systemUptimeTotalSeconds), counted on
// in the page each second and reset at every status refresh (5 s); the
// memory gauge is rendered by the page's PHP from /proc/meminfo
// (get_server_memory_info()).

async function uptime(page: Page): Promise<string> {
  const parts = await Promise.all(['days', 'hours', 'minutes', 'seconds'].map((u) => page.locator(`#uptime-${u}`).textContent()));
  return parts.join(':');
}

// The status answer, the player's own with the uptimes set.
async function routeStatus(page: Page, systemUptime: number, fppdUptime: number) {
  await page.route('**/api/system/status', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.systemUptimeTotalSeconds = systemUptime;
    json.uptimeTotalSeconds = fppdUptime;
    return route.fulfill({ response, json });
  });
}

test('the uptime shown is the system\'s, not fppd\'s', async ({ page, request }) => {
  // Regression: 76fce7cdc.  The counter read uptimeTotalSeconds, how long
  // fppd has been running, under a heading that says System Uptime.
  // The receiving end: the real status answer carries both, and they differ.
  const real = await (await request.get('/api/system/status')).json();
  expect(Number(real.systemUptimeTotalSeconds)).toBeGreaterThan(Number(real.uptimeTotalSeconds));
  await answerUpdateCheck(page);
  // 1 day 2 h 3 min 4 s up; fppd up 5 s.
  await routeStatus(page, 93784, 5);
  await page.clock.install();
  await page.goto('/system-stats.php');
  // :05 too, on a tree from before 03946dc02, which drew it a second ahead.
  await expect.poll(() => uptime(page)).toMatch(/^01:02:03:0[45]$/);
});

test('the memory gauge shows used memory, not used plus buffers and cache', async ({ page }) => {
  // Regression: 76fce7cdc.  The gauge's figure was total_used_percent, which
  // counts the kernel's buffers and page cache as used.
  test.skip(!container, 'reads /proc/meminfo inside the run-web.sh container');
  const mem = () => {
    const m: Record<string, number> = {};
    for (const l of inPlayer('cat', '/proc/meminfo').split('\n')) {
      const x = l.match(/^(\w+):\s+(\d+) kB$/);
      if (x) m[x[1]] = Number(x[2]);
    }
    const used = m.MemTotal - m.MemFree - m.Buffers - m.Cached;
    return { used: (used / m.MemTotal) * 100, all: ((used + m.Buffers + m.Cached) / m.MemTotal) * 100 };
  };
  const before = mem();
  // The control: the two figures are far enough apart to tell apart.
  expect(before.all - before.used).toBeGreaterThan(3);
  await answerUpdateCheck(page);
  await page.goto('/system-stats.php');
  const shown = Number((await page.locator('#memValue').textContent())!.trim().match(/^(\d+)%/)![1]);
  const after = mem();
  expect(shown).toBeGreaterThanOrEqual(Math.floor(Math.min(before.used, after.used)) - 1);
  expect(shown).toBeLessThanOrEqual(Math.ceil(Math.max(before.used, after.used)) + 1);
});

test('the uptime counts one second per second, from what the status says', async ({ page }) => {
  // Regression: 03946dc02.  The function that drew the counter also added
  // the second, so drawing a fresh status value showed it one second ahead,
  // and every 5 s refresh jumped the count by an extra second.
  await answerUpdateCheck(page);
  await routeStatus(page, 3600, 5);
  // The page's clock stands still but for runFor() below.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const polled = page.waitForResponse((r) => r.url().endsWith('/api/system/status'));
  await page.goto('/system-stats.php');
  await polled;
  await expect.poll(() => uptime(page)).toBe('00:01:00:00');
  await page.clock.runFor(1000);
  expect(await uptime(page)).toBe('00:01:00:01');
  await page.clock.runFor(1000);
  expect(await uptime(page)).toBe('00:01:00:02');
});
