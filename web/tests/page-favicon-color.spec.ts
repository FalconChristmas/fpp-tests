import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile, dropSettings } from './privacy-helpers';

// The browser-tab icon follows the header colour the user picked.

test.skip(!container, 'sets the background colour in the settings file inside the run-web.sh container');

test('the favicon is drawn in the chosen background colour', async ({ page, request }) => {
  // Regression: e5a17ef11.  The page always linked the one favicon.ico; with a
  // backgroundColor setting it gets a second, inline SVG icon filled with that
  // colour, so a tab on a coloured player is told apart from the others.
  await keepingSettings(async () => {
    dropSettings('backgroundColor');
    await page.goto('/index.php?plain=1');
    // The control: without a colour there is only the stock icon.
    await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveCount(0);

    setSettingInFile('backgroundColor', '3366CC');
    await page.goto('/index.php?coloured=1');
    const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(icon).toHaveCount(1);
    const href = (await icon.getAttribute('href'))!;
    expect(href).toMatch(/^data:image\/svg\+xml,/);
    // The receiving end: it decodes to an SVG whose background rectangle has the colour.
    const svg = decodeURIComponent(href.slice(href.indexOf(',') + 1));
    expect(svg).toContain('<svg');
    expect(svg).toMatch(/<rect[^>]*fill='#3366CC'/);
    // The stock icon is still linked, and served.
    expect((await request.get('/favicon.ico')).status()).toBe(200);
  });
});
