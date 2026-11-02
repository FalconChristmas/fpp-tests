import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: f13a96cee.  A cape's name labels the Channel Outputs tabs it
// provides: a cape that drives both strings and panels names both ("<cape>
// Pixel Strings", "<cape> LED Panels") so the two tabs are told apart, and a
// cape that drives one names just that tab.  The tab it does not provide
// keeps its generic name.  (See channeloutputs-cape-tabs.spec.ts for which
// tabs appear.)  The player claims to be a Raspberry Pi, which is where the
// strings tab is drawn, and the cape is media/tmp/cape-info.json.

test.skip(!container, 'changes the platform and gives the run-web.sh container a cape');

const PLATFORM = '/etc/fpp/platform';
const INFO = '/home/fpp/media/tmp/cape-info.json';
let kept: string | null = null;

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${INFO} ]; then echo yes; cat ${INFO}; else echo no; fi`);
  kept = out.startsWith('yes\n') ? out.slice(4) : null;
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && echo 'Raspberry Pi' > ${PLATFORM}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', kept === null ? `rm -f ${INFO}` : `printf '%s' '${kept.replace(/'/g, "'\\''")}' > ${INFO}`);
  inPlayer('rm', '-f', PLATFORM);
});

async function tabNames(page: import('@playwright/test').Page, provides: string[]) {
  inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && printf '%s' '${JSON.stringify({ id: 'fpp-tests', name: 'FtCape', provides })}' > ${INFO}`);
  await page.goto('/channeloutputs.php?p=' + provides.join('-'));
  await expect(page.locator('#tab-LEDPanels-tab')).toBeAttached();
  return {
    strings: (await page.locator('#stringTab-tab').textContent())!.trim(),
    panels: (await page.locator('#tab-LEDPanels-tab').textContent())!.trim(),
  };
}

test('a cape that drives strings and panels names both tabs', async ({ page }) => {
  expect(await tabNames(page, ['strings', 'panels'])).toEqual({ strings: 'FtCape Pixel Strings', panels: 'FtCape LED Panels' });
});

test('a cape that drives only one of them names only that tab', async ({ page }) => {
  expect(await tabNames(page, ['strings'])).toEqual({ strings: 'FtCape', panels: 'LED Panel Matrices' });
  expect(await tabNames(page, ['panels'])).toEqual({ strings: 'Pixel Strings', panels: 'FtCape' });
});
