import { test, expect } from './fixtures';

// The setup wizard run again once setup is done (as after an fppOS update).
// Feature: 0e5557818, the four-step wizard: a jurisdiction already given is
// not asked again, and nothing a step changes is saved before Finish.
//
// The setup project has finished the wizard (choosing US) before this runs.

test('a jurisdiction already given is preselected', async ({ page }) => {
  await page.goto('/initialSetup.php');
  await expect(page.locator('#LegalJurisdiction')).toHaveValue('US');
  await expect(page.locator('#LegalJurisdiction option[value=""]')).toHaveCount(0);
});

test('a change on a step is not saved until Finish', async ({ page, request }) => {
  test.setTimeout(120_000);
  const before = await (await request.get('/api/settings/HostDescription')).json();
  await page.goto('/initialSetup.php');
  // Leaving step 1 waits out cape detection in the container (see the setup project).
  await page.click('#setupNextBtn');
  await expect(page.locator('.setupStep[data-step="2"]')).toBeVisible({ timeout: 60_000 });
  await page.fill('#HostDescription', 'fpp-tests-unsaved');
  await page.locator('#HostDescription').blur();
  await page.click('#setupNextBtn');
  await expect(page.locator('.setupStep[data-step="3"]')).toBeVisible({ timeout: 60_000 });
  await page.reload();
  const after = await (await request.get('/api/settings/HostDescription')).json();
  expect(after.value ?? '').not.toBe('fpp-tests-unsaved');
  expect(after.value ?? '').toBe(before.value ?? '');
});
