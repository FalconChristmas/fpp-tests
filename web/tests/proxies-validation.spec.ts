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
