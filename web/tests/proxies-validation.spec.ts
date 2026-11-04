import { test, expect } from './fixtures';

// The Proxies page checks each host before it will save it.

test('a proxy host that is not an address or a host name is flagged and not saved', async ({ page, request }) => {
  // 46b30f062 (validation of proxy names, a huntr report), 09d6d3e43 (the
  // check at save time).
  const before = await (await request.get('/api/proxies')).json();
  try {
    await request.delete('/api/proxies');
    await page.goto('/proxies.php');
    const add = page.locator("button[value='Add']");
    await add.click();
    await add.click();
    const hosts = page.locator('input.ipaddress');
    await expect(hosts).toHaveCount(2);

    await hosts.nth(0).fill('bad name!/<x>');
    await expect(page.locator('#linkRow0, #linkRow1').first()).toBeAttached();
    await expect(page.locator('td[id^=linkRow]').first()).toContainText('Must be either valid IP address or Valid Hostname');

    await hosts.nth(1).fill('192.0.2.50');
    await expect(page.locator('td[id^=linkRow]').nth(1)).not.toContainText('Must be either');

    await page.locator('#btnSave').click();
    await expect.poll(async () => (await (await request.get('/api/proxies')).json()).map((p: any) => p.host),
      { timeout: 10_000 }).toEqual(['192.0.2.50']);
  } finally {
    await request.delete('/api/proxies');
    if (Array.isArray(before) && before.length) await request.post('/api/proxies', { data: before });
  }
});

test('after a row is deleted, the rows left are still saved', async ({ page, request }) => {
  // Regression: 09d6d3e43.  Saving read the hosts as ipRow0, ipRow1, ...
  // up to the number of rows; once a row was deleted the ids had a gap, the
  // lookup of the missing one threw, and nothing was saved: a proxy could
  // not be deleted without starting over.
  const before = await (await request.get('/api/proxies')).json();
  try {
    await request.delete('/api/proxies');
    await page.goto('/proxies.php');
    const add = page.locator("button[value='Add']");
    for (let i = 0; i < 3; i++) await add.click();
    const hosts = page.locator('input.ipaddress');
    await expect(hosts).toHaveCount(3);
    await hosts.nth(0).fill('192.0.2.51');
    await hosts.nth(1).fill('192.0.2.52');
    await hosts.nth(2).fill('192.0.2.53');

    await page.locator('#proxyTable .proxyRow').nth(0).locator('td').first().click();
    await page.locator('#btnDelete').click();
    await expect(hosts).toHaveCount(2);

    await page.locator('#btnSave').click();
    await expect.poll(async () => (await (await request.get('/api/proxies')).json()).map((p: any) => p.host),
      { timeout: 10_000 }).toEqual(['192.0.2.52', '192.0.2.53']);
  } finally {
    await request.delete('/api/proxies');
    if (Array.isArray(before) && before.length) await request.post('/api/proxies', { data: before });
  }
});
