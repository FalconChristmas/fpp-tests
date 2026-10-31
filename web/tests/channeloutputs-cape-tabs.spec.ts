import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Which tabs the Channel Outputs page offers for a cape, from the cape's
// "provides" list and the UI level.  The cape is media/tmp/cape-info.json,
// as the cape detection leaves it.

test.skip(!container, 'gives the run-web.sh container a cape');

const INFO = '/home/fpp/media/tmp/cape-info.json';
let kept: string | null = null;

test.beforeEach(() => {
  const out = inPlayer('sh', '-c', `if [ -e ${INFO} ]; then echo yes; cat ${INFO}; else echo no; fi`);
  kept = out.startsWith('yes\n') ? out.slice(4) : null;
});
test.afterEach(async ({ request }) => {
  inPlayer('sh', '-c', kept === null ? `rm -f ${INFO}` : `printf '%s' '${kept.replace(/'/g, "'\\''")}' > ${INFO}`);
  await request.put('/api/settings/uiLevel', { data: '0' });
});

function cape(info: object) {
  inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && printf '%s' '${JSON.stringify(info)}' > ${INFO}`);
}

test('a strings-only cape gets the LED Panels tab from the Advanced level and not below', async ({ page, request }) => {
  // Regression: 0ec97516d (#1569).  The Advanced level (1) offers E1.31/DDP
  // output for any cape ("udp" is added to what it provides); ColorLight
  // output, which is on the LED Panels tab, is offered with it.
  cape({ id: 'fpp-tests', name: 'fpp-tests strings cape', provides: ['strings'] });
  await request.put('/api/settings/uiLevel', { data: '1' });
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#tab-LEDPanels-LI')).not.toHaveClass(/hidden/);
  await request.put('/api/settings/uiLevel', { data: '0' });
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#tab-LEDPanels-LI')).toHaveClass(/hidden/);
});

test('a cape whose info has no provides list still gets the page, with its tabs', async ({ page, request }) => {
  // Regression: 9cae9f861.  The page indexed the cape's "provides" without
  // checking it was there.
  cape({ id: 'fpp-tests', name: 'fpp-tests cape without provides' });
  await request.put('/api/settings/uiLevel', { data: '0' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/channeloutputs.php');
  const body = await page.content();
  expect(body).not.toMatch(/Warning:|Notice:|Fatal error|Undefined (array key|index)/);
  await expect(page.locator('#tab-e131-tab')).toBeVisible();
  expect(errors).toEqual([]);
});
