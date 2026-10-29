import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The UI under the operating system's forced colours (Windows' contrast
// themes): fpp.css opts the page out (forced-color-adjust: none on html),
// so its own colour scheme is kept rather than replaced by the system's.

const colours = (page: Page) => page.evaluate(() => {
  const pick = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, color: cs.color };
  };
  return { body: pick('body'), header: pick('.header'), content: pick('.pageContent') };
});

test('forced colours leave the page in its own colour scheme', async ({ page }) => {
  // Regression: f3f3f0057.  With forced colours on, the browser repainted
  // the page in the system palette: the dark page background, the header
  // bar and the content cards all came out in the system's Canvas colour.
  await page.goto('/index.php');
  const normal = await colours(page);
  // The control: the page has colours of its own to lose.
  expect(normal.body?.background).not.toBe(normal.content?.background);

  await page.emulateMedia({ forcedColors: 'active' });
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  expect(await colours(page)).toEqual(normal);
});
