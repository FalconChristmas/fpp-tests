import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';
import { putFile, readFile } from './settings-file';

// The end of a successful OS upgrade.  upgradeOS.php reboots the player with
// "echo b > /proc/sysrq-trigger", an instant reset that never closes the
// HTTP response: the browser gets no FIN or RST, so a request still open at
// that point stays pending for good.  The progress dialog only enabled its
// Close button when the request ended, so it sat on "Please Wait" after the
// player was back up on the new OS.  Nothing is upgraded or rebooted here.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const IMAGE = 'Pi64-98.9_2098-11.fppos';
const UPLOAD = `/home/fpp/media/upload/${IMAGE}`;
const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';

test("the OS upgrade dialog can be closed once it says Rebooting, though the request never ends", async ({ page, baseURL }) => {
  // Regression: b6959eca1 ("the OS upgrade dialog can be closed once it
  // says Rebooting").  The stream here is a page that prints what
  // upgradeOS.php prints up to the reboot and then holds the response open,
  // as the reboot leaves it.
  const HELD = '/opt/fpp/www/fpp-tests-held-os-upgrade.php';
  putFile(HELD, `<?php
header('X-Accel-Buffering: no');
while (ob_get_level() > 0) ob_end_clean();
ob_implicit_flush(true);
echo "===== Applying OS image =====\\nfpp-tests: copying\\n";
echo "===== Rebooting =====\\nRebooting.....Close this window and refresh the screen.\\n";
flush();
sleep(30);
`);
  inPlayer('chmod', '644', HELD);
  try {
    const origin = new URL(baseURL!).origin;
    await page.route((url) => url.origin !== origin, (route) => route.abort());
    let ended = false;
    page.on('requestfinished', (r) => { if (r.url().includes('fpp-tests-held-os-upgrade.php')) ended = true; });
    page.on('requestfailed', (r) => { if (r.url().includes('fpp-tests-held-os-upgrade.php')) ended = true; });
    await page.route('**/upgradeOS.php*', (route) => route.continue({ url: `${origin}/fpp-tests-held-os-upgrade.php` }));
    await page.goto('/about.php');
    // (Opened the way UpgradeOS() opens it, without its confirm and image checks.)
    await page.evaluate(() => (window as any).DisplayProgressDialog('osUpgrade', 'FPP OS Upgrade'));
    await page.evaluate(() => (window as any).StreamURL('upgradeOS.php?wrapped=1&os=x', 'osUpgradeText', 'OSUpgradeDone', 'OSUpgradeDone',
      'POST', null, null, true, false, 'OSUpgradeProgress'));
    await expect(page.locator('#osUpgradeText')).toHaveValue(/Rebooting\.\.\.\.\./, { timeout: 15_000 });
    await expect(page.locator('#osUpgrade .modal-title')).toHaveText('FPP OS Upgrade — Rebooting');
    const close = page.locator('#osUpgradeCloseButton');
    await expect(close, 'Close stayed on "Please Wait" after Rebooting').toBeEnabled({ timeout: 10_000 });
    await expect(close).toHaveText('Close');
    expect(ended, 'the control: the request is still open').toBe(false);
    // Close only closes: a reload here would load a page from a box that is
    // going down.
    await page.evaluate(() => { (window as any).fppTestsSamePage = true; });
    await close.click();
    await expect(page.locator('#osUpgrade')).toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).fppTestsSamePage === true), 'Close reloaded the page').toBe(true);
  } finally {
    inPlayer('rm', '-f', HELD);
  }
});

test('upgradeOS.php ends its response before it reboots', async ({ request }) => {
  // Regression: 4e047ef01 ("end the response before the post-upgrade
  // reboot").  The real upgradeOS.php runs, with its OS-writing script
  // (upgradeOS-part1.sh) stood in for by one that succeeds without writing
  // anything, so it goes on to its reboot.  shutdown, its last try, is a
  // stand-in that records the call.  The sysrq writes before it fail in an unprivileged container, where
  // /proc/sysrq-trigger is read-only -- and if it is not, this test must not
  // run: that trigger is the host kernel's.
  test.skip(inPlayer('sh', '-c', 'test -w /proc/sysrq-trigger && echo yes || echo no').trim() !== 'no',
    '/proc/sysrq-trigger is writable here: this would reboot the host');
  const SD = '/opt/fpp/SD';
  const DIR = '/tmp/fpp-tests-os-reboot';
  const SHUTDOWN_LOG = `${DIR}/shutdown.log`;
  inPlayer('sh', '-c', `set -e; mv ${SD} ${SD}.fpp-tests-orig; cp -aL ${SD}.fpp-tests-orig ${SD}
    printf '#!/bin/sh\\necho "===== Finalizing ====="\\nexit 0\\n' > ${SD}/upgradeOS-part1.sh
    chmod 755 ${SD}/upgradeOS-part1.sh
    mkdir -p ${DIR}; : > ${SHUTDOWN_LOG}; chmod 777 ${DIR}; chmod 666 ${SHUTDOWN_LOG}
    printf '#!/bin/sh\\necho "$*" >> ${SHUTDOWN_LOG}\\n' > /usr/local/bin/shutdown; chmod 755 /usr/local/bin/shutdown`);
  putFile(UPLOAD, 'fpp-tests image');
  try {
    await keepingFile(LOG, async () => {
      const r = await request.post(`/upgradeOS.php?wrapped=1&os=${IMAGE}`, { timeout: 60_000 });
      const body = await r.text();
      const shutdownAtEnd = readFile(SHUTDOWN_LOG).trim();
      expect(body).toContain('===== Rebooting =====');
      expect(shutdownAtEnd, 'the response stayed open until the reboot').toBe('');
      // ... and the script still went on to the reboot after it.
      await expect.poll(() => readFile(SHUTDOWN_LOG).trim(), { timeout: 20_000 }).toBe('-r now');
    });
  } finally {
    inPlayer('sh', '-c', `rm -rf ${SD} && mv ${SD}.fpp-tests-orig ${SD}; rm -rf ${DIR} /usr/local/bin/shutdown ${UPLOAD} /home/fpp/media/tmp/upgradeOS-part1.sh`);
  }
});
