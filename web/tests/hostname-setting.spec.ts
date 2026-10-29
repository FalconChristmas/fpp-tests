import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { putFile, settingInFile } from './settings-file';

// Saving the host name: from the Network page and from the setup wizard.
// The API writes /etc/hostname and /etc/hosts and runs `hostname <name>`
// through sudo.  The player's /etc/hostname and /etc/hosts are Docker's bind
// mounts and it may not rename itself, so hostname, systemctl and the
// avahi-daemon init script are stand-ins (sudo's secure_path finds
// /usr/local/bin first) that log their calls; both files are put back.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-hostname-stub';
const CALLS = '/tmp/fpp-tests-hostname-calls.log';
const STUBS = ['/usr/local/bin/hostname', '/usr/local/bin/systemctl', '/etc/init.d/avahi-daemon'];
const NAME = 'fpp-tests-host';

function sh(script: string): string {
  return inPlayer('sh', '-c', script);
}

test.beforeEach(() => {
  for (const s of STUBS) {
    if (sh(`test -e ${s} && ! grep -q ${MARK} ${s} && echo real || true`).trim() === 'real') {
      throw new Error(`${s} is a real program in the player; not replacing it`);
    }
    putFile(s, `#!/bin/sh\n# ${MARK}\necho "$(basename $0) $*" >> ${CALLS}\nexit 0\n`);
    sh(`chmod 755 ${s}`);
  }
  sh(`rm -f ${CALLS}; cp /etc/hostname /tmp/fpp-tests-etc-hostname; cp /etc/hosts /tmp/fpp-tests-etc-hosts`);
});

test.afterEach(() => {
  for (const s of STUBS) sh(`grep -q ${MARK} ${s} 2>/dev/null && rm -f ${s}; true`);
  sh(`cat /tmp/fpp-tests-etc-hostname > /etc/hostname; cat /tmp/fpp-tests-etc-hosts > /etc/hosts; ` +
    `rm -f ${CALLS} /tmp/fpp-tests-etc-hostname /tmp/fpp-tests-etc-hosts`);
});

function calls(): string[] {
  return sh(`cat ${CALLS} 2>/dev/null || true`).split('\n').filter((l) => l !== '');
}

test('a host name saved on the Network page renames the host, flags a reboot and leaves avahi alone', async ({ page }) => {
  // Regression: 0b77904a7 ("Don't restart avahi on hostname change, just flag
  // the reboot").  The save restarted avahi-daemon twice (its init script and
  // systemctl) and slept a second for it; the new name only reaches mDNS
  // properly after the reboot the setting already asks for.
  await keepingSettings(async () => {
    setSettingInFile('rebootFlag', '0');
    await page.goto('/networkconfig.php');
    await page.click('#tab-global-network-tab');
    const input = page.locator('#HostName');
    await expect(input).toBeVisible({ timeout: 15_000 });
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/HostName') && r.request().method() === 'PUT');
    await input.fill(NAME);
    await input.press('Enter');
    await input.blur();
    expect((await saved).ok()).toBe(true);
    expect(settingInFile('HostName')).toBe(NAME);
    // The receiving end that matters now: the running host name is set.
    await expect.poll(calls, { message: 'hostname was not run' }).toContain(`hostname ${NAME}`);
    await expect.poll(() => settingInFile('rebootFlag'), { message: 'no reboot was flagged' }).toBe('1');
    expect(calls().filter((c) => /avahi/.test(c)), 'avahi was restarted').toEqual([]);
  });
});

test('the setup wizard asks for the host name and description, and Finish saves them', async ({ page }) => {
  // Feature: 2e149baac ("Add hostname and description back to initialsetup").
  // The receiving end: the name is applied as the Network page's save is.
  test.setTimeout(180_000);
  await keepingSettings(async () => {
    await page.goto('/initialSetup.php');
    // Leaving step 1 waits out cape detection in the container (see the setup project).
    await page.click('#setupNextBtn');
    await expect(page.locator('.setupStep[data-step="2"]')).toBeVisible({ timeout: 60_000 });
    const step = page.locator('.setupStep[data-step="2"]');
    await expect(step.locator('#HostName')).toHaveValue(settingInFile('HostName') ?? 'FPP');
    await expect(step.locator('#HostDescription')).toBeVisible();
    await step.locator('#HostName').fill(NAME);
    await step.locator('#HostDescription').fill('fpp-tests description');
    for (const n of [3, 4]) {
      await page.click('#setupNextBtn');
      await expect(page.locator(`.setupStep[data-step="${n}"]`)).toBeVisible({ timeout: 60_000 });
    }
    await page.selectOption('#passwordEnable', '0');
    await page.click('#finishSetupBtn');
    await expect(page).toHaveURL(/index\.php/, { timeout: 60_000 });
    expect(settingInFile('HostName')).toBe(NAME);
    expect(settingInFile('HostDescription')).toBe('fpp-tests description');
    await expect.poll(calls, { message: 'hostname was not run' }).toContain(`hostname ${NAME}`);
  });
});
