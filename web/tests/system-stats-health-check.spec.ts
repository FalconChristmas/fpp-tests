import { test, expect } from './fixtures';
import { answerUpdateCheck } from './standin-http';

// System Stats runs the health check when it opens: healthCheckSSE.php
// streams one result per check (scripts/healthCheckSSE) and the page fills
// its grid with them, then a summary.

test('the health check grid fills from the stream, and fppd warnings open out of it', async ({ page }) => {
  // Feature: 066078513 (#2603).  The stream is the player's own; only the
  // fppd-warnings result is swapped for one carrying a warning, since this
  // fppd has none to report.
  let streamed = '';
  await page.route('**/healthCheckSSE.php*', async (route) => {
    const response = await route.fetch();
    streamed = await response.text();
    const warning = { id: 'warnings', status: 'warn', message: '1 warning', details: ['fpp-tests: an output is misconfigured'] };
    const lines = streamed.split('\n').filter((l) => !/^data: .*"id"\s*:\s*"warnings"/.test(l));
    const done = lines.findIndex((l) => /^data: .*"id"\s*:\s*"done"/.test(l));
    lines.splice(done < 0 ? lines.length : done, 0, `data: ${JSON.stringify(warning)}`, '');
    return route.fulfill({ response, body: lines.join('\n') });
  });
  await answerUpdateCheck(page);
  await page.goto('/system-stats.php');

  // The player's own fppd answers, so its check passes.
  const fppd = page.locator('#hc-fppd');
  await expect(fppd.locator('.fpp-status--pass')).toHaveCount(1, { timeout: 60_000 });
  expect(streamed).toMatch(/^data: .*"id"\s*:\s*"fppd"/m);
  // Every check that was sent has a verdict, and the summary counts them.
  await expect(page.locator('#hcPassCount')).toHaveText(/^\d+$/, { timeout: 60_000 });
  const counts = await Promise.all(['#hcPassCount', '#hcWarnCount', '#hcFailCount'].map(async (s) => Number(await page.locator(s).textContent())));
  expect(counts[0]).toBeGreaterThan(0);
  expect(await page.locator('.fpp-health-check__status .fa-spinner').count()).toBe(0);

  // The warning's details open out of its row.
  const row = page.locator('[data-check="warnings"]');
  await expect(row).toHaveClass(/fpp-health-check__item--expandable/);
  const details = page.locator('#details-warnings');
  await expect(details).toContainText('fpp-tests: an output is misconfigured');
  await expect(details).toBeHidden();
  await row.click();
  await expect(details).toBeVisible();
});
