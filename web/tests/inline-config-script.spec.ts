import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Every page's inline config script (config.php, and backup.php's own copy)
// printed values taken from the request URL -- REQUEST_URI and PHP_SELF --
// into double-quoted JavaScript strings as they were, so a backslash at the
// end of the query escaped the closing quote and the script block failed: a
// reflected injection point, and a page with no settings script.  Fixed in
// fpp 031d0c71f ("fix(config): Encode server vars as JS strings") and, for
// backup.php, 25644b825 ("fix(backup): Encode server vars as JS strings").
//
// 031d0c71f's own comment held a literal "</script>", which ended the block
// early on every page; fixed in fpp 067006446 ("fix(config): Literal
// </script> in inline script comment cut off the script block, breaking
// Status page (#3084)").

async function load(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') sent.push(r.url());
  });
  await page.goto(path);
  await page.waitForLoadState('load');
  return { errors, sent };
}

test('the status page config script runs', async ({ page }) => {
  const { errors } = await load(page, '/index.php');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => typeof (window as any).pageName)).toBe('string');
});

for (const path of ['/index.php', '/backup.php']) {
  test(`a backslash in the query does not break ${path}'s config script`, async ({ page }) => {
    const { errors, sent } = await load(page, `${path}?x=\\`);
    // The control: the backslash went to the server as it was.
    expect(sent[0]).toMatch(/\?x=\\$/);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => typeof (window as any).pageName)).toBe('string');
  });
}
