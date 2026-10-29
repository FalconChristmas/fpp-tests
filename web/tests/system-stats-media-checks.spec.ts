import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { answerUpdateCheck } from './standin-http';
import { cleanupPipeWire, standInAt, commandLog } from './pw-helpers';

// System Stats' health check streams one result per check from
// scripts/healthCheckSSE.  Two of them look at the media stack: PipeWire
// (are FPP's three PipeWire services active, per systemctl) and GStreamer
// (does gst-inspect-1.0 find the elements fppd plays through).  The player
// has no systemd, so systemctl is a stand-in answering is-active for each
// service; gst-inspect-1.0 and its plugins are the image's real ones.

test.skip(!container, 'puts a systemctl stand-in in the run-web.sh container');

test.afterEach(() => cleanupPipeWire());

// systemctl is-active <unit> answers `states[unit]` (exit 0 only for active).
function standInSystemctl(states: Record<string, string>) {
  const cases = Object.entries(states).map(([u, s]) => `  ${u}) echo ${s}; [ ${s} = active ]; exit $? ;;`).join('\n');
  standInAt('/usr/bin/systemctl', `[ "$1" = is-active ] || exit 0\ncase "$2" in\n${cases}\n  *) echo inactive; exit 3 ;;\nesac\n`);
}

async function runHealthCheck(page: Page) {
  let streamed = '';
  await page.route('**/healthCheckSSE.php*', async (route) => {
    const response = await route.fetch();
    streamed = await response.text();
    return route.fulfill({ response, body: streamed });
  });
  await answerUpdateCheck(page);
  await page.goto('/system-stats.php');
  await expect(page.locator('#hcPassCount')).toHaveText(/^\d+$/, { timeout: 90_000 });
  return () => streamed.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

const SERVICES = ['fpp-pipewire.service', 'fpp-wireplumber.service', 'fpp-pipewire-pulse.service'];

test('the health check reports the PipeWire services and the GStreamer elements', async ({ page }) => {
  // Feature: dc15140b8.  Neither the audio services nor the media
  // elements were among the checks.
  test.setTimeout(150_000);
  standInSystemctl(Object.fromEntries(SERVICES.map((s) => [s, 'active'])));
  const results = await runHealthCheck(page);
  const pw = results().find((r) => r.id === 'pipewire');
  const gst = results().find((r) => r.id === 'gstreamer');
  expect(pw, JSON.stringify(results())).toMatchObject({ status: 'pass', message: 'All services active' });
  expect(gst, JSON.stringify(results())).toMatchObject({ status: 'pass', message: 'All required elements available' });
  // It asked systemctl about each service.
  for (const s of SERVICES) expect(commandLog('systemctl')).toContain(`is-active ${s}`);
  // The page shows both.
  await expect(page.locator('[data-check="pipewire"]')).toBeVisible();
  await expect(page.locator('#hc-pipewire .fpp-status--pass')).toHaveCount(1);
  await expect(page.locator('#hc-pipewire')).toContainText('All services active');
  await expect(page.locator('[data-check="gstreamer"]')).toBeVisible();
  await expect(page.locator('#hc-gstreamer')).toContainText('All required elements available');
});

test('a PipeWire service that is down is a warning naming it, and all three down a failure', async ({ page }) => {
  // Feature: dc15140b8.
  test.setTimeout(150_000);
  standInSystemctl({ 'fpp-pipewire.service': 'active', 'fpp-wireplumber.service': 'failed', 'fpp-pipewire-pulse.service': 'active' });
  let results = await runHealthCheck(page);
  expect(results().find((r) => r.id === 'pipewire'), JSON.stringify(results())).toEqual({
    id: 'pipewire', label: 'PipeWire Audio', icon: 'fa-volume-high', status: 'warn',
    message: '1 service(s) not active', details: ['fpp-wireplumber.service: failed'],
  });
  // The page lists the service under the check.
  await page.locator('[data-check="pipewire"]').click();
  await expect(page.locator('#details-pipewire')).toBeVisible();
  await expect(page.locator('#details-pipewire')).toHaveText('fpp-wireplumber.service: failed');

  // None active (as on this player without its stand-in): a failure.
  standInSystemctl({});
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  results = await runHealthCheck(page);
  expect(results().find((r) => r.id === 'pipewire'), JSON.stringify(results())).toMatchObject({
    status: 'fail', message: 'PipeWire not running',
    details: SERVICES.map((s) => `${s}: inactive`),
  });
  await expect(page.locator('#hc-pipewire .fpp-status--fail')).toHaveCount(1);
});
