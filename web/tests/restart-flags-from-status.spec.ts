import { test, expect } from './fixtures';

// The Restart and Reboot notices follow the flags as the player has them,
// not only what this page set: the status the page polls carries restartFlag
// and rebootFlag, and the notices are shown or hidden to match.  A flag set
// from another tab, or by the API, appears; clearing it takes the notice away.

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/restartFlag', { data: '0' });
  await request.put('/api/settings/rebootFlag', { data: '0' });
});

test('the status carries the restart and reboot flags', async ({ request }) => {
  // Regression: f34683beb ("Auto hide/show Restart/Reboot warning boxes").
  await request.put('/api/settings/restartFlag', { data: '1' });
  await request.put('/api/settings/rebootFlag', { data: '0' });
  const status = await (await request.get('/api/system/status')).json();
  expect(status).toMatchObject({ restartFlag: 1, rebootFlag: 0 });
  await request.put('/api/settings/rebootFlag', { data: '1' });
  expect(await (await request.get('/api/system/status')).json()).toMatchObject({ rebootFlag: 1 });
});

for (const flag of ['restartFlag', 'rebootFlag']) {
  test(`a ${flag} set elsewhere shows this page's notice, and clearing it hides the notice`, async ({ page, request }) => {
    // Regression: f34683beb.  The notices were only decided when this page
    // saved something; a flag raised by another tab, a remote or the API was
    // not shown until the page was reloaded, and a cleared one stayed up.
    test.setTimeout(120_000);
    await request.put('/api/settings/restartFlag', { data: '0' });
    await request.put('/api/settings/rebootFlag', { data: '0' });
    await page.goto('/index.php');
    const notice = page.locator(`#${flag}`);
    await expect(notice).toBeHidden();

    await request.put(`/api/settings/${flag}`, { data: '1' });
    await expect(notice, 'shown by a status update').toBeVisible({ timeout: 60_000 });

    await request.put(`/api/settings/${flag}`, { data: '0' });
    await expect(notice, 'hidden by a status update').toBeHidden({ timeout: 60_000 });
  });
}
