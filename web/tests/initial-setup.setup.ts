import { test as setup, expect } from '@playwright/test';

// Finish the setup wizard on the fresh player the way a user does: US
// jurisdiction (privacy answers come pre-filled there), no UI password,
// defaults everywhere else. Until it is done every other page redirects to the wizard, so a wizard
// that cannot be finished fails this, and everything after it is skipped.
setup('finish the initial setup wizard', async ({ page }) => {
  // Leaving step 1 asks cape detection for its defaults, and fppcapedetect
  // waits up to 15 s for an I2C bus to appear before giving up. A player
  // always has one; the container has none, so it waits out the whole time.
  setup.setTimeout(120_000);
  await page.goto('/initialSetup.php');
  if (await page.locator('#setupNextBtn').count() === 0) {
    // Before 0e5557818 (2026-09-08) the setup was one page, whose save of
    // the UI password fails in this container on trees from before 2026-07.
    // A test is still to be run on such a tree, so set the flag the page
    // sets when it is done.
    const r = await page.request.put('/api/settings/initialSetup-02', { data: '1' });
    expect(r.ok()).toBe(true);
  } else {
    await finishWizard(page);
  }

  // The gate that sent every page here is off now.
  const index = await (await page.request.get('/index.php')).text();
  expect(index).not.toContain('url=initialSetup.php');
});

async function finishWizard(page) {
  // Step 1 can't be left until the jurisdiction is answered (0e5557818).
  page.once('dialog', (d) => d.accept());
  await page.click('#setupNextBtn');
  await expect(page.locator('.setupStep[data-step="1"]')).toBeVisible();
  await expect(page.locator('.setupStep[data-step="2"]')).toBeHidden();
  await page.selectOption('#LegalJurisdiction', 'US');
  for (const step of [2, 3, 4]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }
  await page.selectOption('#passwordEnable', '0');
  await page.click('#finishSetupBtn');
  await expect(page).toHaveURL(/index\.php/, { timeout: 30_000 });
}
