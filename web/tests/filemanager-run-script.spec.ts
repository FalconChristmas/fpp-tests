import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Running a script from the File Manager's Scripts tab, and a plugin's own
// script through the same endpoint (runEventScript.php).

test.skip(!container, 'seeds scripts inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SCRIPT = 'fpp-tests-run.sh';
const PLUGIN = 'fpp-tests-run-plugin';

test.afterEach(() => {
  inPlayer('rm', '-rf', `${MEDIA}/scripts/${SCRIPT}`, `${MEDIA}/plugins/${PLUGIN}`);
});

test('Run shows the script\'s output in a dialog on the page', async ({ page, context }) => {
  // Regression: e04452d0e.  Run opened runEventScript.php in a new tab,
  // leaving the File Manager behind.
  inPlayer('sh', '-c', `printf '#!/bin/sh\\necho fpp-tests ran with "$@"\\n' > ${MEDIA}/scripts/${SCRIPT} && chmod 755 ${MEDIA}/scripts/${SCRIPT}`);
  let tabs = 0;
  context.on('page', () => tabs++);
  await page.goto('/filemanager.php#tab-scripts');
  await page.locator('#tab-scripts-tab').click();
  const row = page.locator('#tblScripts tbody tr').filter({ has: page.locator('td', { hasText: SCRIPT }) });
  await row.click();
  await page.locator('#tab-scripts input[value="Run"]').click();
  const dialog = page.locator('#runScriptDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#runScriptText')).toHaveValue(/fpp-tests ran with/, { timeout: 15_000 });
  // The output is plain text, not the page's HTML.
  await expect(dialog.locator('#runScriptText')).not.toHaveValue(/<pre>|<html/i);
  expect(tabs, 'Run opened another tab').toBe(0);
});

test("a plugin's script runs from the plugin's scripts directory", async ({ request }) => {
  // Regression: e04452d0e.  runEventScript.php only ran scripts from the
  // media scripts directory; ?plugin= points it at the plugin's own.
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/plugins/${PLUGIN}/scripts && printf '#!/bin/sh\\necho fpp-tests plugin script ran\\n' > ${MEDIA}/plugins/${PLUGIN}/scripts/${SCRIPT} && chmod 755 ${MEDIA}/plugins/${PLUGIN}/scripts/${SCRIPT}`);
  const out = await (await request.get(`/runEventScript.php?nohtml=1&plugin=${PLUGIN}&scriptName=${SCRIPT}`)).text();
  expect(out).toContain('fpp-tests plugin script ran');
  // The control: the same name is no script in the media scripts directory.
  const plain = await (await request.get(`/runEventScript.php?nohtml=1&scriptName=${SCRIPT}`)).text();
  expect(plain).toContain('ERROR: Unknown script');
});
