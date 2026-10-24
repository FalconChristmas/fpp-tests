import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { nodeNames, nullSink, pw, startPipeWire, stopPipeWire } from './pw-live';

// Restarting the PipeWire audio services from the API and from System
// Health.  The player has no systemd, so systemctl is replaced for the test
// by a stand-in whose three PipeWire units are the test's own PipeWire
// daemons (pw-live.ts): a restart really stops and starts that daemon, and
// is-active reports whether it is running.  Every other unit goes to the
// real systemctl.  The calls it records are `systemctl restart <unit>` and
// `systemctl is-active <unit>`, which is how the real one takes them.

test.skip(!container, 'replaces systemctl inside the run-web.sh container');

const STATE = '/tmp/fpp-tests-systemctl';
const DAEMON = { 'fpp-pipewire.service': 'pipewire', 'fpp-wireplumber.service': 'wireplumber', 'fpp-pipewire-pulse.service': 'pipewire-pulse' };
const STUB = `#!/bin/sh
# fpp-tests stand-in: the PipeWire units are the test's own daemons.
echo "$*" >> ${STATE}/calls
case "$2" in
  ${Object.entries(DAEMON).map(([u, p]) => `${u}) p=${p} ;;`).join('\n  ')}
  *) exec ${STATE}/systemctl.real "$@" ;;
esac
export PIPEWIRE_RUNTIME_DIR=/run/pipewire-fpp XDG_RUNTIME_DIR=/run/pipewire-fpp XDG_CONFIG_HOME=/tmp/fpp-tests-pw XDG_STATE_HOME=/tmp/fpp-tests-pw/state
case "$1" in
  is-active) if pgrep -x "$p" > /dev/null; then echo active; else echo inactive; exit 3; fi ;;
  restart) pkill -x "$p"; while pgrep -x "$p" > /dev/null; do sleep 0.1; done
           setsid nohup "$p" >> /tmp/fpp-tests-pw/$p.log 2>&1 < /dev/null & ;;
  stop) pkill -x "$p" ;;
  *) exit 1 ;;
esac
`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${STATE} && mkdir -p ${STATE} && cp -a /usr/bin/systemctl ${STATE}/systemctl.real`);
  writeFile('/usr/bin/systemctl', STUB);
  inPlayer('chmod', '755', '/usr/bin/systemctl');
  startPipeWire({ objects: [nullSink('fpp_tests_out')] });
});

test.afterEach(async ({ request }) => {
  inPlayer('sh', '-c', `cp -a ${STATE}/systemctl.real /usr/bin/systemctl && rm -rf ${STATE}`);
  stopPipeWire();
  cleanupPipeWire();
  await settleAfterApply(request);
});

const pids = () => Object.values(DAEMON).map((p) => inPlayer('sh', '-c', `pgrep -x ${p} || true`).trim());
const calls = () => readFile(`${STATE}/calls`).split('\n').filter((l) => l.startsWith('restart'));

async function uptime(request: APIRequestContext): Promise<number> {
  try {
    const r = await request.get('/api/fppd/status');
    return r.ok() ? ((await r.json()).uptimeTotalSeconds ?? -1) : -1;
  } catch {
    return -1;
  }
}

test('restarting the audio services restarts the three PipeWire daemons in order, then fppd', async ({ request }) => {
  // Feature: ac3737b2d. POST /api/pipewire/audio/services/restart bounces
  // pipewire, then wireplumber, then pipewire-pulse (which needs pipewire's
  // socket), and then restarts fppd so its pipelines reconnect.
  inPlayer('sleep', '2');
  const before = pids();
  const up = await uptime(request);
  expect(up, 'fppd is not answering').toBeGreaterThan(0);

  const r = await request.post('/api/pipewire/audio/services/restart', { timeout: 60_000 });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.json()).toMatchObject({ status: 'OK',
    services: { 'fpp-pipewire': true, 'fpp-wireplumber': true, 'fpp-pipewire-pulse': true } });
  expect(calls()).toEqual(['restart fpp-pipewire.service', 'restart fpp-wireplumber.service', 'restart fpp-pipewire-pulse.service']);

  // New daemons, with the graph back and pactl answering.
  const after = pids();
  after.forEach((pid, i) => {
    expect(pid, `${Object.values(DAEMON)[i]} is not running`).not.toBe('');
    expect(pid, `${Object.values(DAEMON)[i]} was not restarted`).not.toBe(before[i]);
  });
  await expect.poll(nodeNames, { timeout: 10_000 }).toContain('fpp_tests_out');
  expect(pw('pactl list short sinks')).toContain('fpp_tests_out');
  // fppd came back up as a new process image: its uptime started again.
  await expect.poll(() => uptime(request), { timeout: 30_000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => { const u = await uptime(request); return u >= 0 && u < up; }, { timeout: 30_000 }).toBe(true);
});

test('System Health offers to restart the audio services while PipeWire is down, and doing it clears the warning', async ({ page }) => {
  // Feature: ac3737b2d. A degraded PipeWire check on System Health shows a
  // "Restart Audio Services" action that calls the restart API, then checks
  // again.
  inPlayer('pkill', '-x', 'wireplumber');
  await page.goto('/system-stats.php');
  const check = page.locator('li', { hasText: 'PipeWire Audio' });
  await expect(check).toContainText('service(s) not active', { timeout: 30_000 });
  const restart = page.locator('#btnRestartAudio');
  await expect(restart).toBeVisible({ timeout: 30_000 });

  page.once('dialog', (d) => d.accept());
  const answer = page.waitForResponse((r) => r.url().includes('/api/pipewire/audio/services/restart'), { timeout: 60_000 });
  await restart.click();
  expect((await (await answer).json()).status).toBe('OK');
  expect(pids().every((p) => p !== ''), 'a PipeWire daemon is still down').toBe(true);
  await expect(check).toContainText('All services active', { timeout: 60_000 });
  await expect(restart).toBeHidden();
});
