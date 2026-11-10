import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';

// upgradefpp.php, which the About page's Upgrade runs for a release
// (UpgradeFPPVersion() in fpp.js): it runs scripts/upgrade_FPP for the
// version, as root, and says whether it worked -- on the page and in
// logs/fpp_system_upgrades.log, which the update progress view reads after a
// reconnect -- holding the update lock throughout, so a second update can't
// run over the first.  upgrade_FPP is a stand-in here that records how it was
// run and exits as the test says; nothing is upgraded.

test.skip(!container, 'replaces scripts/upgrade_FPP inside the run-web.sh container');

const SCRIPT = '/opt/fpp/scripts/upgrade_FPP';
const REAL = `${SCRIPT}.fpp-tests-real`;
const CALLS = '/tmp/fpp-tests-upgrade_FPP.log';
const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';
const LOCK = '/home/fpp/media/tmp/fpp-update.lock';
const sh = (s: string) => inPlayer('sh', '-c', s);

// The stand-in exits with the code in /tmp/fpp-tests-upgrade_FPP.rc, after
// sleeping as long as /tmp/fpp-tests-upgrade_FPP.sleep says.
test.beforeEach(() => {
  sh(`[ -e ${REAL} ] || mv ${SCRIPT} ${REAL}
      cat > ${SCRIPT} <<'EOF'
#!/bin/sh
echo "$(id -un) $*" >> ${CALLS}
echo "fpp-tests upgrading to $1"
sleep "$(cat /tmp/fpp-tests-upgrade_FPP.sleep 2>/dev/null || echo 0)"
exit "$(cat /tmp/fpp-tests-upgrade_FPP.rc 2>/dev/null || echo 0)"
EOF
      chmod 755 ${SCRIPT}; rm -f ${CALLS} /tmp/fpp-tests-upgrade_FPP.rc /tmp/fpp-tests-upgrade_FPP.sleep`);
});
test.afterEach(() => {
  sh(`if [ -e ${REAL} ]; then mv -f ${REAL} ${SCRIPT}; fi; rm -f ${CALLS} /tmp/fpp-tests-upgrade_FPP.rc /tmp/fpp-tests-upgrade_FPP.sleep`);
});

const calls = () => sh(`cat ${CALLS} 2>/dev/null || true`).trim();
const logLines = (version: string) => sh(`grep -F -- '${version}' ${LOG} 2>/dev/null || true`);

test('a release is upgraded to by running upgrade_FPP for it as root, and the success is said and logged', async ({ request }) => {
  const version = `v99.${Date.now()}`;
  const r = await request.get(`/upgradefpp.php?version=${version}`, { timeout: 60_000 });
  const out = await r.text();
  expect(r.status()).toBe(200);
  expect(calls()).toBe(`root ${version}`);
  expect(out).toContain(`FPP Upgrade to version ${version}`);
  expect(out).toContain(`fpp-tests upgrading to ${version}`);
  expect(out).toContain('Upgrade complete.  Please reboot.');
  expect(logLines(version)).toContain('===== Upgrade Complete =====');
  expect(logLines(version)).not.toContain('Upgrade Failed');
});

test('an upgrade_FPP that fails is said to have failed, with its exit code, and logged so', async ({ request }) => {
  sh('echo 3 > /tmp/fpp-tests-upgrade_FPP.rc');
  const version = `v98.${Date.now()}`;
  const out = await (await request.get(`/upgradefpp.php?version=${version}`, { timeout: 60_000 })).text();
  expect(out).toContain('Upgrade FAILED (exit code 3).  See the errors above.');
  expect(out).not.toContain('Upgrade complete');
  expect(logLines(version)).toContain('ERROR: upgrade_FPP exited rc=3; not rebooting.');
  expect(logLines(version)).toContain('===== Upgrade Failed =====');
});

test('versions are tags, branches and SHAs only: anything else is refused before upgrade_FPP runs', async ({ request }) => {
  for (const ok of ['v10.1', 'master', 'feature/fpp-tests_1', '0123abcd']) {
    const r = await request.get(`/upgradefpp.php?version=${encodeURIComponent(ok)}`, { timeout: 60_000 });
    expect(r.status(), ok).toBe(200);
  }
  expect(calls().split('\n')).toEqual(['root v10.1', 'root master', 'root feature/fpp-tests_1', 'root 0123abcd']);
  sh(`rm -f ${CALLS}`);
  for (const bad of ['', '-rf', 'v10..1', 'v10 1', "v10';reboot", '../v10']) {
    const r = await request.get(`/upgradefpp.php?version=${encodeURIComponent(bad)}`);
    expect(r.status(), JSON.stringify(bad)).toBe(400);
    expect(await r.text()).toBe('Invalid version');
  }
  expect(calls(), 'upgrade_FPP ran for a refused version').toBe('');
});

// Held by another update (flock -o: only flock holds it, so killing it lets go).
async function withLockHeld(fn: () => Promise<void>) {
  docker('exec', '-d', container, 'flock', '-o', LOCK, 'sh', '-c', 'touch /tmp/fpp-tests-upgrade-lock; sleep 30');
  try {
    await expect.poll(() => sh('test -e /tmp/fpp-tests-upgrade-lock && echo yes || echo no').trim(), { timeout: 10_000 }).toBe('yes');
    await fn();
  } finally {
    sh(`pkill -f "[f]lock -o ${LOCK}" || true; rm -f /tmp/fpp-tests-upgrade-lock`);
  }
}

test('an upgrade while another update is running is refused, and does not run', async ({ request }) => {
  await withLockHeld(async () => {
    const r = await request.get('/upgradefpp.php?version=v10.1', { timeout: 60_000 });
    expect(await r.text()).toContain('Another FPP update is already running');
    expect(calls()).toBe('');
  });
  // With the lock free it runs.
  expect((await request.get('/upgradefpp.php?version=v10.1', { timeout: 60_000 })).status()).toBe(200);
  expect(calls()).toBe('root v10.1');
});

test('two upgrades started together: one runs, the other is refused while it does', async ({ request }) => {
  sh('echo 3 > /tmp/fpp-tests-upgrade_FPP.sleep');
  const [a, b] = await Promise.all([
    request.get('/upgradefpp.php?version=v10.1', { timeout: 60_000 }),
    new Promise((r) => setTimeout(r, 1000)).then(() => request.get('/upgradefpp.php?version=v10.2', { timeout: 60_000 })),
  ]);
  expect(await a.text()).toContain('Upgrade complete.');
  expect(await b.text()).toContain('Another FPP update is already running');
  expect(calls()).toBe('root v10.1');
});

// The refusal's 409 (UpdateLockAcquireOrConflict) is only set while no
// header has gone: these pages call DisableOutputBuffering(), which flushes,
// before taking the lock, so the refusal comes back as a 200, as
// changebranch.php's did until ba5d026aa (whose own spec is the control,
// changebranch-update-lock.spec.ts).  A caller going by the status (a script,
// another FPP) takes the refused update for one that ran.  In FUTURE.md.
for (const [page, url] of [
  ['upgradefpp.php', '/upgradefpp.php?version=v10.1'],
  ['upgradeOS.php', `/upgradeOS.php?os=${encodeURIComponent('https://fpp-tests.invalid/x.fppos')}&wrapped=1&downloadOnly=1`],
  ['manualUpdate.php', '/manualUpdate.php?wrapped=1'],
] as const) {
  test(`${page} refused by the update lock answers 409`, async ({ request }) => {
    await withLockHeld(async () => {
      const r = await request.get(url, { timeout: 60_000 });
      expect(await r.text()).toContain('Another FPP update is already running');
      test.fail(true, 'the 409 is lost to headers already sent (FUTURE.md)');
      expect(r.status()).toBe(409);
    });
  });
}
