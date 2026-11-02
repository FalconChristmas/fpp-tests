import { test, expect } from './fixtures';

// The page's CSS gives native form controls (spinners, scrollbars, date
// pickers) their colour scheme from the theme.  htmlMeta.inc also sets it
// inline from the theme script; these tests drop that inline value to see
// what the stylesheets alone decide.

test('the stylesheets set the colour scheme from the theme, whatever the OS prefers', async ({ page }) => {
  // Regression: 2d0241b76.  Nothing in the CSS set color-scheme for the
  // light theme (the page's meta tag allows both), so with an OS preference
  // of dark and the theme forced light, the browser drew native controls dark
  // on a light page.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/index.php');
  const scheme = (theme: string) =>
    page.evaluate((t) => {
      const html = document.documentElement;
      html.style.colorScheme = '';
      html.setAttribute('data-bs-theme', t);
      return getComputedStyle(html).colorScheme;
    }, theme);
  expect(await scheme('light')).toBe('light');
  expect(await scheme('dark')).toBe('dark');
});
