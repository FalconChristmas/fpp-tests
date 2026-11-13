import { test, expect } from './fixtures';
import { container } from './container';
import { sh, writeFile, PLUGINS } from './plugin-backfill';

// A plugin's theme.inc.php sets $themeInfo, which config.php includes for
// every page: the footer link, extra stylesheets either side of FPP's own,
// and extra scripts.

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

// A new directory for each test: php-fpm's opcache keeps a file it has
// compiled for a few seconds without looking at it again, so a second test
// writing the same theme.inc.php path straight after the first is served the
// first test's theme.  A path it has not seen is always read fresh.
let PLUGIN = '';

test.beforeEach(() => { PLUGIN = `${PLUGINS}/fpp-tests-theme-${Date.now()}`; });
test.afterEach(() => sh(`rm -rf ${PLUGIN}`));

test('a plugin theme sets the footer link and adds stylesheets and a script to the page', async ({ page }) => {
  // Regression: 2e6d61547.  Plugins had no way to rebrand the UI: the footer
  // link and the stylesheet list were fixed.  theme.inc.php may now set
  // FOOTER_URL/FOOTER_URL_TEXT, preFPPStyleSheet, postFPPStyleSheet and
  // themeJS, and the head and footer include them.
  writeFile(`${PLUGIN}/theme.inc.php`, `<?php
$themeInfo["FOOTER_URL"] = "https://theme.example.com/";
$themeInfo["FOOTER_URL_TEXT"] = "theme.example.com";
$themeInfo["preFPPStyleSheet"] = array("plugin.php?theme=pre.css");
$themeInfo["postFPPStyleSheet"] = array("plugin.php?theme=post.css");
$themeInfo["themeJS"] = array("plugin.php?theme=theme.js");
`);
  await page.goto('/index.php');
  const footer = page.locator('.footerLink a').first();
  await expect(footer).toHaveText('theme.example.com');
  await expect(footer).toHaveAttribute('href', 'https://theme.example.com/');

  // Where the stylesheets sit matters: FPP's own comes between them, so the
  // theme can override it (post) or be overridden by it (pre).
  const order = await page.evaluate(() => {
    const hrefs = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.getAttribute('href') || '');
    return {
      pre: hrefs.findIndex((h) => h.includes('theme=pre.css')),
      fpp: hrefs.findIndex((h) => /^css\/fpp\.css/.test(h)),
      post: hrefs.findIndex((h) => h.includes('theme=post.css')),
      script: Array.from(document.querySelectorAll('script')).some((s) => (s.getAttribute('src') || '').includes('theme=theme.js')),
    };
  });
  expect(order.pre, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
  expect(order.pre).toBeLessThan(order.fpp);
  expect(order.post).toBeGreaterThan(order.fpp);
  expect(order.script, 'the theme script is in the page').toBe(true);
});

test('a theme script tag is closed, so the markup after it is not swallowed', async ({ page, request }) => {
  // Regression: themeJS was emitted as <script src=... />.  HTML never treats
  // a self-closing script as closed, so the tag ran on, as script text, over
  // whatever followed it up to the next </script>: a second theme script was
  // not an element and the head after it was lost.  Fixed by 4ebbe20d0.
  writeFile(`${PLUGIN}/theme.inc.php`, `<?php
$themeInfo["themeJS"] = array("plugin.php?theme=first.js", "plugin.php?theme=second.js");
`);
  const html = await (await request.get('/index.php')).text();
  for (const n of ['first', 'second']) {
    expect(html, `${n}.js is closed in the served markup`)
      .toMatch(new RegExp(`<script[^>]*theme=${n}\\.js'\\s*></script>`));
  }
  expect(html).not.toMatch(/theme=\w+\.js'\s*\/>/);

  await page.goto('/index.php');
  const found = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src*="theme="]'));
    return {
      srcs: scripts.map((s) => s.getAttribute('src')),
      swallowed: scripts.map((s) => (s.textContent || '').length),
      header: !!document.querySelector('.header'),
    };
  });
  expect(found.srcs, JSON.stringify(found)).toEqual(['plugin.php?theme=first.js', 'plugin.php?theme=second.js']);
  expect(found.swallowed, 'no markup inside the script tags').toEqual([0, 0]);
  expect(found.header, 'the page header after the scripts is in the DOM').toBe(true);
});
