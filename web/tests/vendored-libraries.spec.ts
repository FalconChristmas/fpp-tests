import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The third-party libraries www/ ships and the pages load from the player
// itself: each is served, loads, and what uses it still works.

// What went wrong while a page loaded: script errors, anything the CSP
// blocked, and any script, stylesheet, font or image that failed, came back
// an error or came from somewhere other than the player.  (The pages' API
// requests are left alone: some 404 by design, for a config file that
// isn't there yet, and the Plugin Manager asks GitHub from the browser.)
function watch(page: Page, origin: string) {
  const problems: string[] = [];
  const asset = (r: { resourceType(): string; url(): string }) =>
    ['script', 'stylesheet', 'font', 'image'].includes(r.resourceType()) && !/^(data|blob):/.test(r.url()) &&
    !r.url().startsWith(`${origin}/api/`);
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (asset(r)) problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (asset(r.request()) && r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    if (asset(r) && !r.url().startsWith(origin)) problems.push(`off the player: ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/.test(m.text())) problems.push(`csp: ${m.text()}`);
  });
  return problems;
}

test('the main pages load their libraries without errors', async ({ page, baseURL }) => {
  // Coverage: 806d530b3 (Zebra_Pin 3.0.1) and the other vendored libraries
  // every page loads through menuHead.inc (jQuery UI, jGrowl, Bootstrap,
  // Font Awesome, zero-md).
  test.setTimeout(120_000);
  const problems = watch(page, new URL(baseURL!).origin);
  for (const path of ['/index.php', '/playlists.php', '/scheduler.php', '/filemanager.php', '/settings.php',
    '/channeloutputs.php', '/multisync.php', '/effects.php', '/about.php']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    const libs = await page.evaluate(() => {
      const w = window as any;
      return {
        jquery: typeof w.jQuery, ui: typeof w.jQuery?.ui?.version, jgrowl: typeof w.jQuery?.jGrowl,
        bootstrap: typeof w.bootstrap?.Tooltip, zebra: typeof w.jQuery?.Zebra_Pin,
        // A solid Font Awesome icon drawn in its webfont.
        fontawesome: document.fonts.check('900 16px "Font Awesome 7 Free"'),
      };
    });
    expect(libs, path).toEqual({ jquery: 'function', ui: 'string', jgrowl: 'function', bootstrap: 'function', zebra: 'function', fontawesome: true });
  }
  expect(problems).toEqual([]);
});

test('standard pages provide Popper as a global for page and plugin scripts', async ({ page }) => {
  // Feature: 34abbaf3c.  menuHead.inc loads popper.min.js beside
  // Bootstrap's bundle (whose own Popper is private to it).
  await page.goto('/index.php');
  expect(await page.evaluate(() => typeof (window as any).Popper?.createPopper)).toBe('function');
});

test('a Bootstrap popover is drawn as a popover', async ({ page }) => {
  // Regression: 42b15c0fe.  fpp-bootstrap's build left out Bootstrap's
  // popover styles, so a popover (MultiSync's column chooser here) came up
  // as bare text with no box, background or stacking over the page.
  await page.goto('/multisync.php');
  await page.locator('#columnSelectorBtn').click();
  const pop = page.locator('.popover');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.popover-header')).toHaveText('Select Columns to Display');
  const style = await pop.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { zIndex: cs.zIndex, background: cs.backgroundColor, borderStyle: cs.borderTopStyle, maxWidth: cs.maxWidth };
  });
  expect(style.zIndex, JSON.stringify(style)).toBe('1070');
  expect(style.background, JSON.stringify(style)).not.toBe('rgba(0, 0, 0, 0)');
  expect(style.borderStyle, JSON.stringify(style)).toBe('solid');
});

test('markdown renders with zero-md loading nothing from off the player', async ({ page, baseURL }) => {
  // Regression: 95818ecd8.  zero-md's presets fetched marked, its plugins,
  // highlight.js and the GitHub stylesheets from cdn.jsdelivr.net: a player
  // with no internet (or the CSP) got no markdown help at all.  Also
  // ba3e8ddbd (zero-md shipped), 91b35657e (<zero-md> defined on every page)
  // and 17653774e (its stylesheets shipped with fpp).
  const problems = watch(page, new URL(baseURL!).origin);
  await page.goto('/index.php');
  await page.waitForFunction(() => !!customElements.get('zero-md'));
  await page.evaluate(() => {
    const md = document.createElement('zero-md');
    const src = document.createElement('script');
    src.type = 'text/markdown';
    src.textContent = '# fpp-tests heading\n\nSome *emphasis*.\n\n```js\nvar fppTests = 1;\n```\n';
    md.appendChild(src);
    md.id = 'fppTestsMarkdown';
    document.body.prepend(md);
  });
  const md = page.locator('#fppTestsMarkdown');
  // Soft, so a page that never renders still reports what it asked for.
  await expect.soft(md.locator('h1')).toHaveText('fpp-tests heading', { timeout: 15_000 });
  await expect.soft(md.locator('em')).toHaveText('emphasis');
  // The code block went through highlight.js.
  await expect.soft(md.locator('pre code .hljs-keyword').first()).toHaveText('var');
  expect(problems).toEqual([]);
});

test.describe('the LED panel layout canvas', () => {
  test.skip(!container, 'writes the channel output config inside the run-web.sh container');
  const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
  let saved: string | null = null;
  test.beforeEach(() => {
    const out = inPlayer('sh', '-c', `if [ -e ${OUTPUTS} ]; then echo yes; cat ${OUTPUTS}; else echo no; fi`);
    saved = out.startsWith('yes\n') ? out.slice(4) : null;
  });
  test.afterEach(() => {
    if (saved === null) {
      inPlayer('sh', '-c', `printf '{"channelOutputs":[]}' > ${OUTPUTS}`);
      inPlayer('rm', '-f', OUTPUTS);
    } else {
      inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', saved, OUTPUTS);
    }
  });

  test('draws the panels with fabric.js', async ({ page, baseURL }) => {
    // Regression: 487426f50.  co-ledPanels.php loads js/fabric/fabric.min.js
    // (since d45cdbe6a), which did not exist until fabric 6.6.4 was added
    // there: the advanced layout's canvas died with "fabric is not
    // defined" and drew nothing.
    const panels = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        panels.push({ outputNumber: 0, panelNumber: r * 2 + c, colorOrder: '', xOffset: c * 32, yOffset: r * 16, orientation: 'N', row: r, col: c });
      }
    }
    const matrix = {
      type: 'LEDPanelMatrix', subType: 'ColorLight5a75', enabled: 1, startChannel: 1, channelCount: 64 * 32 * 3,
      interface: 'eth0', ledPanelsWidth: 32, ledPanelsHeight: 16, ledPanelsScan: 8, colorOrder: 'RGB', gamma: '2.2',
      brightness: 10, ledPanelsOutputs: 24, ledPanelsPanelsPerOutput: 24, panels, cfgVersion: 3, ledPanelsLayout: '2x2',
      panelMatrixID: 1, advanced: 1,
    };
    inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: [matrix] }), OUTPUTS);
    const problems = watch(page, new URL(baseURL!).origin);
    page.on('dialog', (d) => d.accept());
    await page.goto('/channeloutputs.php');
    await page.locator('#tab-LEDPanels-tab').click();
    await expect(page.locator('#panelMatrix1 table.ledPanelCanvasUI')).toBeVisible({ timeout: 15_000 });
    // fabric wraps the canvas it draws on.
    await expect(page.locator('#panelMatrix1 .canvas-container canvas#ledPanelCanvas1')).toBeAttached();
    await expect.poll(() => page.evaluate(() => (0, eval)('AdvancedUIcanvas1').ledPanelCanvas?.getObjects().length ?? -1)).toBe(4);
    expect(problems).toEqual([]);
  });
});
