import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A MultiSync row's log (the textarea a remote action streams into) while
// the table refreshes: every status poll re-renders the rows, and the log
// rows are taken out and put back around it.  The systems list and status
// answers are the test's, as in multisync.spec.ts.

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const REMOTES = ['192.168.0.21', '192.168.0.22'];

function status(ip: string) {
  return {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: { Platform: 'Raspberry Pi', Branch: 'master', LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', IPs: [ip], Utilization: { CPU: 1, Memory: 2 } },
  };
}

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('192.168.0.13', 'FPPTESTLOCAL', 'M1-fpptests-local', 1),
    ...REMOTES.map((ip, i) => system(ip, `fpptests-remote${i + 1}`, `M1-fpptests-remote${i + 1}`)),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: Object.fromEntries(REMOTES.map((ip) => [ip, status(ip)])) }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
}

const nextPoll = (page: Page) => page.waitForResponse((r) => r.url().includes('/api/system/status'));

test("a streaming log stays at its newest line, and a log scrolled back stays put, across refreshes", async ({ page }) => {
  // Regression: 4878fd13a.  The log rows were detached around each
  // re-render, and a detached textarea loses its scroll position: every poll
  // (each ~2 s with auto refresh, as during a fleet upgrade) sent each open
  // log back to its first line.
  await openMultisync(page);
  const ids = await page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' }).evaluateAll((rs) => rs.map((r) => r.id));
  expect(ids).toHaveLength(2);
  const lines = Array.from({ length: 200 }, (_, i) => `fpp-tests log line ${i + 1}\n`).join('');
  await page.evaluate(([ids, text]) => {
    for (const id of ids as string[]) {
      (window as any).showLogsRow(id);
      (window as any).appendRowLog(id, text);
    }
  }, [ids, lines]);
  const logs = ids.map((id) => page.locator(`#${id}_logText`));
  // The first follows the stream (appendRowLog left it at the bottom); the
  // user scrolled the second back to somewhere in the middle.
  const middle = await logs[1].evaluate((t: HTMLTextAreaElement) => {
    t.scrollTop = Math.floor((t.scrollHeight - t.clientHeight) / 2);
    return t.scrollTop;
  });
  expect(middle).toBeGreaterThan(100);

  const poll = nextPoll(page);
  await page.locator('#MultiSyncRefreshStatus').check();
  await poll;
  // The next two polls: each re-renders the rows.
  await nextPoll(page);
  await nextPoll(page);
  await page.waitForTimeout(300);

  const bottomGap = await logs[0].evaluate((t: HTMLTextAreaElement) => t.scrollHeight - t.scrollTop - t.clientHeight);
  expect(bottomGap).toBeLessThanOrEqual(2);
  expect(await logs[1].evaluate((t: HTMLTextAreaElement) => t.scrollTop)).toBe(middle);
});
