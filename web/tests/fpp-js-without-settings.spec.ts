import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, CONFIG, sh, writeFile } from './plugin-backfill';

// fpp.js on a page that has no `settings` array: config.php leaves the
// page's JS settings out when $skipJSsettings is set, as plugin.php does
// for a plugin's bare page (nopage=1).  A bare plugin page that pulls in
// FPP's usual head (menuHead.inc: jQuery, Bootstrap, fpp.js) for its
// helpers is such a page.

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

const NAME = 'fpp-tests-bare-page';

test.afterEach(() => {
  sh(`rm -rf ${PLUGINS}/${NAME} ${CONFIG}/plugin.${NAME}`);
});

test("fpp.js loads without errors on a page that has no settings", async ({ page }) => {
  // Regression: 9f40f8a63.  fpp.js read settings['temperatureInF'] as it
  // loaded, and settings['disableUIWarnings'] etc. in
  // CheckRestartRebootFlags(): on a page without the array, fpp.js threw
  // "settings is not defined" as it loaded, and so did any call of that.
  writeFile(`${PLUGINS}/${NAME}/pluginInfo.json`, JSON.stringify({
    name: NAME, repoName: NAME, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
  }));
  writeFile(`${PLUGINS}/${NAME}/bare.php`, `<!DOCTYPE html>
<html><head>
<?php include 'common/htmlMeta.inc'; include 'common/menuHead.inc'; ?>
</head><body>
<div id="fppTestsBare">bare page</div>
<script>
  window.fppTestsFppJs = typeof GetFPPStatus === 'function' && typeof CheckRestartRebootFlags === 'function';
  CheckRestartRebootFlags();
  window.fppTestsDone = true;
</script>
</body></html>
`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/plugin.php?plugin=${NAME}&page=bare.php&nopage=1`);
  await expect(page.locator('#fppTestsBare')).toHaveText('bare page');
  // The control: this page really has no settings array.
  expect(await page.evaluate(() => typeof (window as any).settings)).toBe('undefined');
  await page.waitForTimeout(1_000);
  expect(errors).toEqual([]);
  // The control: fpp.js was there to call.
  expect(await page.evaluate(() => (window as any).fppTestsFppJs)).toBe(true);
  expect(await page.evaluate(() => (window as any).fppTestsDone), 'CheckRestartRebootFlags() returned').toBe(true);
});
