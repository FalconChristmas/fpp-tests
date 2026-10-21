import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The RTSP Outputs page: what its status badge says when fppd cannot serve
// RTSP, and what Save & Apply reports.
// Regression: fc1de9964. Every failure read "fppd not reachable" -- including
// a running fppd built without gst-rtsp-server, which sent people to check
// whether fppd was up -- and Save & Apply re-rendered an identical page, so a
// save that worked looked like a dead button, and one whose reload fppd
// refused looked the same as one that failed.

// The page shows its controls only on the Advanced PipeWire backend.  The
// setting is written to the file directly: setting it through the API would
// switch the backend for real, which the container has no PipeWire for.
const SETTINGS = '/home/fpp/media/settings';
let savedBackend = '';

test.beforeAll(() => {
  if (!container) return;
  savedBackend = inPlayer('sh', '-c', `grep '^MediaBackend' ${SETTINGS} || true`).trim();
  inPlayer('sh', '-c', `sed -i '/^MediaBackend/d' ${SETTINGS} && echo 'MediaBackend = "pipewire"' >> ${SETTINGS}`);
});

test.afterAll(() => {
  if (!container) return;
  inPlayer('sh', '-c', `sed -i '/^MediaBackend/d' ${SETTINGS}` +
    (savedBackend ? ` && echo '${savedBackend}' >> ${SETTINGS}` : ''));
});

async function open(page: Page, status: object, apply = 200, save = 200) {
  await page.route('**/api/pipewire/rtspoutputs/status', (r) => r.fulfill({ json: status }));
  await page.route('**/api/pipewire/rtspoutputs', (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({ status: save, json: save === 200 ? { status: 'OK' } : { status: 'ERROR', message: 'disk full' } })
      : r.fulfill({ json: { enabled: true, port: 8554, latencyMs: 40 } }));
  await page.route('**/api/pipewire/rtspoutputs/apply', (r) =>
    r.fulfill({ status: apply, json: apply === 200 ? { status: 'OK' } : { status: 'ERROR' } }));
  await page.goto('/pipewire-rtsp-outputs.php');
}

test('an fppd with no RTSP endpoint is not reported as unreachable', async ({ page }) => {
  test.skip(!container, 'sets the backend inside the run-web.sh container');
  await open(page, { active: false, mounts: [], unavailable: true, reason: 'unsupported' });
  await expect(page.locator('#serverStatus')).toContainText('RTSP not available in fppd');
  await page.unrouteAll();
  await open(page, { active: false, mounts: [], unavailable: true, reason: 'unreachable' });
  await expect(page.locator('#serverStatus')).toContainText('fppd not running');
  await page.unrouteAll();
  await open(page, { active: true, port: 8556, mounts: [] });
  await expect(page.locator('#serverStatus')).toContainText('Server running on port 8556');
});

test('Save & Apply says what happened', async ({ page }) => {
  test.skip(!container, 'sets the backend inside the run-web.sh container');
  await open(page, { active: true, port: 8554, mounts: [] });
  await page.locator('#saveBtn').click();
  await expect(page.locator('#saveResult')).toContainText('Saved and applied.');

  await page.unrouteAll();
  await open(page, { active: true, port: 8554, mounts: [] }, 500);
  await page.locator('#saveBtn').click();
  await expect(page.locator('#saveResult .alert-warning')).toContainText('Saved, but fppd did not accept the reload');
  await expect(page.locator('#saveBtn')).toBeEnabled();

  await page.unrouteAll();
  await open(page, { active: true, port: 8554, mounts: [] }, 200, 500);
  await page.locator('#saveBtn').click();
  await expect(page.locator('#saveResult .alert-danger')).toContainText('Failed to save: disk full');
});

test("the status API tells fppd's answer apart from no answer", async ({ request }) => {
  test.skip(!container, 'asks fppd directly from inside the run-web.sh container');
  const code = inPlayer('sh', '-c',
    "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:32322/rtspoutput/status || true").trim();
  const st = await (await request.get('/api/pipewire/rtspoutputs/status')).json();
  if (code === '200') {
    // fppd has RTSP: its own status is passed through.
    expect(st.unavailable, JSON.stringify(st)).toBeFalsy();
    expect(Array.isArray(st.mounts)).toBe(true);
  } else {
    expect(st.unavailable, JSON.stringify(st)).toBe(true);
    expect(st.reason, `fppd answered ${code}`).toBe('unsupported');
  }
});
