import { test, expect } from './fixtures';

// Three pages put what the request asked for into the page as markup: Reset
// Config printed every requested area name, the setup wizard followed its
// ?redirect= to any URL (javascript: included) when setup finished, and the
// setup gate built that redirect from PHP_SELF -- which carries any path
// tacked on after the script -- inside a single-quoted attribute.  Fixed in
// fpp 63dad8654 ("fix(security): stop echoing request input into pages as
// markup").

test('Reset Config does not echo an area it does not know', async ({ page }) => {
  // An unknown area: nothing is deleted on any tree.
  await page.goto('/resetConfig.php?areas=' + encodeURIComponent('<img src=x onerror=window.__fppTestsArea=1>'));
  await expect(page.locator('body')).toContainText('Resetting FPP Configuration');
  expect(await page.evaluate(() => (window as any).__fppTestsArea)).toBeUndefined();
});

test('the setup wizard does not take a javascript: redirect', async ({ request }) => {
  const r = await request.get('/initialSetup.php?redirect=' + encodeURIComponent('javascript:void(window.__fppTestsRedirect=1)'));
  const body = await r.text();
  // The control: the redirect variable is in the page.
  expect(body).toContain('var redirectURL =');
  expect(body).not.toContain('redirectURL = "javascript:');
});

test('the setup gate does not echo a path tacked onto the page', async ({ request }) => {
  const before = (await (await request.get('/api/settings/initialSetup-02')).json()).value ?? '1';
  try {
    // The gate sends a page here only while setup is not done.
    expect((await request.put('/api/settings/initialSetup-02', { data: '0' })).ok()).toBe(true);
    // The control: a path after the script still reaches it, and the gate.
    const plain = await request.get('/index.php/x', { maxRedirects: 0 });
    expect(plain.status()).toBe(200);
    expect(await plain.text()).toContain("content='0;url=initialSetup.php?redirect=index.php");

    const r = await request.get("/index.php/'><img src=x>", { maxRedirects: 0 });
    const refresh = /<meta http-equiv='refresh' content='([^']*)'/.exec(await r.text());
    expect(refresh?.[1]).toBe('0;url=initialSetup.php?redirect=index.php');
  } finally {
    await request.put('/api/settings/initialSetup-02', { data: before });
  }
});
