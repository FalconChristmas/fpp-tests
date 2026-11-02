import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { sh, exists, readFile, writeFile } from './plugin-backfill';
import { setSettingInFile, snapshotSettings } from './settings-file';

// What the API hands to the operating system's tools: reboot and halt, the
// network apply step, the test email, and the SSH key install.  The tools are
// stand-ins in /usr/local/bin that record how they were called, so the tests
// see the receiving end and nothing in the container is rebooted or
// reconfigured.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const DIR = '/tmp/fpp-tests-callouts';
const SUDO_LOG = `${DIR}/sudo.log`;
const SHUTDOWN_LOG = `${DIR}/shutdown.log`;
const MARKER = '/etc/fpp/container';
const SIDE = '/etc/fpp/container.fpp-tests-aside';

// sudo records its argument list, then runs a command as itself (the player
// is root already) unless it is the fppinit helper, which only gets recorded.
function installSudoStub() {
  sh(`mkdir -p ${DIR}; : > ${SUDO_LOG}; : > ${SHUTDOWN_LOG}; chmod 777 ${DIR}; chmod 666 ${SUDO_LOG} ${SHUTDOWN_LOG}`);
  writeFile('/usr/local/bin/sudo', `#!/bin/sh
echo "$*" >> ${SUDO_LOG}
case "$1" in */fppinit) exit 0;; esac
exec "$@"
`, '755');
}

function sudoCalls(): string[] {
  return readFile(SUDO_LOG).split('\n').filter((l) => l !== '');
}

test.afterEach(() => {
  sh(`rm -f /usr/local/bin/sudo /usr/local/bin/shutdown /usr/local/bin/mail; rm -rf ${DIR}; [ -e ${SIDE} ] && mv ${SIDE} ${MARKER}; true`);
});

for (const [route, flag] of [['reboot', '-r'], ['shutdown', '-h']]) {
  test(`${route} returns before the OS shutdown command runs`, async ({ request }) => {
    // Regression: 40efbe8cb (#1086).  Halting ran "shutdown -h now" in the
    // foreground under sudo, so the API call did not return until the box
    // was going down.  Both commands are now handed to a backgrounded shell
    // that sleeps first, so the {"status":"OK"} gets out.
    installSudoStub();
    writeFile('/usr/local/bin/shutdown', `#!/bin/sh\necho "$*" >> ${SHUTDOWN_LOG}\n`, '755');
    // The container build kills apache instead; the real-OS branch is
    // taken when this marker is absent.
    sh(`[ -e ${MARKER} ] && mv ${MARKER} ${SIDE}; true`);
    const r = await request.post(`/api/system/${route}`);
    expect(r.ok()).toBe(true);
    expect(await r.json()).toEqual({ status: 'OK' });
    expect(readFile(SHUTDOWN_LOG), 'shutdown ran before the response was returned').toBe('');
    expect(sudoCalls().join('\n')).toContain('bash -c');
    await expect.poll(() => readFile(SHUTDOWN_LOG).trim(), { timeout: 8000 }).toBe(`${flag} now`);
  });
}

test('applying a network interface runs fppinit setupNetwork for it', async ({ request }) => {
  // Regression: 45aa28fee.  The apply step still called scripts/config_network,
  // which the network setup had moved out of; the interface was never
  // reconfigured.  fppinit's setupNetwork is the entry point.
  installSudoStub();
  const r = await request.post('/api/network/interface/eth0/apply');
  expect(r.ok()).toBe(true);
  expect((await r.json()).status).toBe('OK');
  const calls = sudoCalls();
  expect(calls, JSON.stringify(calls)).toHaveLength(1);
  expect(calls[0]).toMatch(/\/src\/fppinit setupNetwork eth0$/);
  expect(calls[0]).not.toContain('config_network');
});

test('the test email reports the mail command failing, and stays quiet when it works', async ({ request, page }) => {
  // Regression: 69032d634.  The test-email call ignored mail's exit status,
  // so a relay that refused the message still got "Test Email sent."; the
  // status and mail's stderr are now in the response and shown as an error.
  const restore = snapshotSettings();
  try {
    setSettingInFile('emailtoemail', 'fpp-tests@example.com');
    writeFile('/usr/local/bin/mail', '#!/bin/sh\necho "mail: cannot connect to relay" >&2\nexit 1\n', '755');
    const bad = await (await request.post('/api/email/test')).json();
    expect(bad.result_code).toBe(1);
    expect(bad.stderr).toContain('cannot connect to relay');

    await page.goto('/settings.php?tab=Email');
    await page.locator('input[value="Send Test Email"]').click();
    const dialog = page.locator('.ui-dialog, .modal.show').filter({ hasText: 'Error sending email' }).first();
    await expect(dialog).toContainText('cannot connect to relay');

    writeFile('/usr/local/bin/mail', '#!/bin/sh\ncat > /dev/null\nexit 0\n', '755');
    const ok = await (await request.post('/api/email/test')).json();
    expect(ok.result_code).toBe(0);
    expect(ok.stderr).toBe('');
  } finally {
    restore();
  }
});

test('uploading the authorized_keys config file installs the keys for root', async ({ request }) => {
  // Regression: 6c6320995.  The keys the Initial Setup and System settings
  // pages upload only landed in the config directory; nothing installed them
  // for the SSH login, so a key the user added never let them in.
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfpptestsfakekeyfpptestsfakekeyfpptests fpp-tests';
  const keep = '/tmp/fpp-tests-keys-before';
  sh(`rm -rf ${keep}; mkdir -p ${keep}; for d in /root /home/fpp; do n=$(echo $d | tr / _); [ -e $d/.ssh/authorized_keys ] && cp -p $d/.ssh/authorized_keys ${keep}/$n; done; true`);
  const cfg = '/home/fpp/media/config/authorized_keys';
  const hadCfg = exists(cfg);
  if (hadCfg) sh(`cp -p ${cfg} ${keep}/cfg`);
  installSudoStub();
  try {
    const r = await request.post('/api/configfile/authorized_keys', { headers: { 'Content-Type': 'text/plain' }, data: `${KEY}\n` });
    expect(r.ok(), await r.text()).toBe(true);
    expect(readFile('/root/.ssh/authorized_keys')).toContain(KEY);
    expect(sudoCalls().join('\n')).toContain('installSSHKeys');
  } finally {
    sh(`rm -f /root/.ssh/authorized_keys /home/fpp/.ssh/authorized_keys ${cfg}; ` +
      `[ -e ${keep}/_root ] && cp -p ${keep}/_root /root/.ssh/authorized_keys; ` +
      `[ -e ${keep}/_home_fpp ] && cp -p ${keep}/_home_fpp /home/fpp/.ssh/authorized_keys; ` +
      `[ -e ${keep}/cfg ] && cp -p ${keep}/cfg ${cfg}; rm -rf ${keep}; true`);
  }
});
