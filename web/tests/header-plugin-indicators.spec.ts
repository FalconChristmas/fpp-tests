import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { MEDIA, PLUGINS, sh } from './plugin-repo';

// The header bar's plugin indicators: each installed plugin with an api.php
// can answer /api/plugin/<name>/headerIndicator, GetPluginHeaderIndicators()
// collects the answers into api/system/status, and RefreshHeaderBar draws one
// icon per visible indicator.  Every field of one is the plugin's, so none
// may reach the page as markup or script.

test.skip(!container, 'puts plugin directories inside the run-web.sh container');

// Closes the attribute it lands in, if it isn't escaped.
const ATTR = (n: string) => `"><u class=fpptestsinj>${n}</u><i x="`;

const plugins: string[] = [];

// A plugin whose headerIndicator endpoint answers `indicator`.
function indicatorPlugin(name: string, indicator: Record<string, unknown>) {
  plugins.push(name);
  const fn = name.replace(/-/g, '');
  const php = `<?php
function getEndpoints${fn}() {
    return array(array('method' => 'GET', 'endpoint' => 'headerIndicator', 'callback' => '${fn}Header'));
}
function ${fn}Header() {
    return json(json_decode(base64_decode('${Buffer.from(JSON.stringify(indicator)).toString('base64')}'), true));
}
`;
  sh(`mkdir -p '${PLUGINS}/${name}' && echo '${Buffer.from(php).toString('base64')}' | base64 -d > '${PLUGINS}/${name}/api.php'`);
}

test.afterEach(() => {
  sh(`rm -rf ${plugins.splice(0).map((n) => `'${PLUGINS}/${n}'`).join(' ')} ${MEDIA}/tmp/plugin-header-indicators.json`);
});

async function openIndex(page: Page) {
  // The collected indicators are cached for 5 s; start from the plugins above.
  sh(`rm -f ${MEDIA}/tmp/plugin-header-indicators.json`);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
}

test("a plugin's header indicator fields stay text", async ({ page }) => {
  // Regression: 1658bb456.  RefreshHeaderBar concatenated the plugin's
  // color, tooltip, icon and animation into the indicator's markup, so each
  // could break out of its attribute into the page.  The indicator comes
  // from a real plugin's api.php, through the real api/system/status.
  indicatorPlugin('fpp-tests-hdr-markup', {
    visible: true,
    tooltip: ATTR('tooltip'),
    icon: `fa-star${ATTR('icon')}`,
    color: `red;${ATTR('color')}`,
    animate: `pulse;${ATTR('animate')}`,
  });
  await openIndex(page);

  const box = page.locator('#header_plugin_indicators');
  const ind = box.locator('.pluginIndicator[data-plugin="fpp-tests-hdr-markup"]');
  // The control: the plugin's indicator reached the header.
  await expect(ind).toHaveCount(1, { timeout: 20_000 });
  await expect(box.locator('.fpptestsinj')).toHaveCount(0);
  // Bootstrap's tooltip takes the title over on hover; it shows it as text.
  await ind.hover();
  await expect(page.locator('.tooltip .tooltip-inner')).toContainText(ATTR('tooltip'));
  await expect(page.locator('.tooltip .fpptestsinj')).toHaveCount(0);
});

test("a plugin's javascript: header link does nothing, and a plain one still opens", async ({ page }) => {
  // Regression: 1658bb456.  The indicator's link went into an inline
  // onclick as window.location.href='<link>', so a javascript: link ran in
  // the page when the icon was clicked.  Now only http(s) links are kept.
  indicatorPlugin('fpp-tests-hdr-js', {
    visible: true, tooltip: 'fpp-tests javascript link', link: 'javascript:window.__fppTestsIndicator=1',
  });
  indicatorPlugin('fpp-tests-hdr-good', {
    visible: true, tooltip: 'fpp-tests plain link', icon: 'fa-star', color: '#00ff00', link: '/about.php',
  });
  await openIndex(page);

  const box = page.locator('#header_plugin_indicators');
  const js = box.locator('.pluginIndicator[data-plugin="fpp-tests-hdr-js"]');
  const good = box.locator('.pluginIndicator[data-plugin="fpp-tests-hdr-good"]');
  await expect(good).toHaveCount(1, { timeout: 20_000 });
  await expect(js).toHaveCount(1);

  await js.click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__fppTestsIndicator)).toBeUndefined();
  expect(new URL(page.url()).pathname).toBe('/index.php');

  // The control: a plain link still opens.  (Moved off first: the other
  // icon's tooltip covers this one.)
  await page.mouse.move(0, 500);
  await expect(page.locator('.tooltip')).toHaveCount(0);
  await good.click();
  await expect(page).toHaveURL(/\/about\.php$/);
});
