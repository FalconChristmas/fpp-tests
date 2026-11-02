import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, SETTINGS, readFile, putFile, setSettingInFile } from './settings-file';
import { PLUGINS, CONFIG, sh, writeFile } from './plugin-backfill';

// Regression: e01f40d4f.  A setting that is shown only while another has a
// value (settings.json "settingValues") compared against that other setting
// without checking it was set at all, so a setting gated on one the settings
// file had never held logged a PHP "Undefined array key" warning each time its
// page was drawn (the page does not show PHP warnings; Apache's error log gets
// them).  The built-in gate, MultiSyncEnabled, is always printed first, which
// sets it, so the case is a plugin's setting with a gate of its own.

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

const NAME = 'fpp-tests-gated-setting';
const GATE = 'fppTestsGate';
const LOG = `${MEDIA}/logs/apache2-error.log`;
const logged = (pattern: string) =>
  Number(inPlayer('sh', '-c', `grep -c '${pattern}' ${LOG} 2>/dev/null || true`).trim() || 0);

let saved = '';
test.beforeEach(() => { saved = readFile(SETTINGS); });
test.afterEach(() => {
  putFile(SETTINGS, saved);
  sh(`rm -rf ${PLUGINS}/${NAME} ${CONFIG}/plugin.${NAME}`);
});

test('a plugin setting gated on a setting that was never set is hidden quietly', async ({ page }) => {
  writeFile(`${PLUGINS}/${NAME}/pluginInfo.json`, JSON.stringify({
    name: NAME, repoName: NAME, versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
  }));
  writeFile(`${PLUGINS}/${NAME}/settings.json`, JSON.stringify({
    settings: {
      fppTestsGated: { name: 'fppTestsGated', description: 'Gated option', type: 'checkbox', default: 0,
                       settingValues: { [GATE]: 1 } },
    },
    settingGroups: {},
  }));
  writeFile(`${PLUGINS}/${NAME}/page.php`, `<div id="fppTestsPluginPage">
<?php PrintSetting('fppTestsGated', '', array(), '${NAME}'); ?>
</div>
`);
  const open = async (q: string) => {
    await page.goto(`/plugin.php?plugin=${NAME}&page=page.php&${q}`);
    await expect(page.locator('#fppTestsPluginPage')).toBeAttached();
  };

  // The control: the gate has its value, the option is drawn.
  setSettingInFile(GATE, '1');
  await open('on=1');
  await expect(page.locator('#fppTestsGated'), 'the gated option is missing with its gate on').toBeAttached();

  // The gate absent from the settings file.
  setSettingInFile(GATE, undefined);
  const undef = logged('Undefined array key');
  await open('unset=1');
  await page.waitForTimeout(500);
  const tail = inPlayer('sh', '-c', `tail -4 ${LOG} 2>/dev/null || true`);
  expect(logged('Undefined array key') - undef, tail).toBe(0);
  await expect(page.locator('#fppTestsGated'), 'the option was drawn with its gate unset').toHaveCount(0);
});
