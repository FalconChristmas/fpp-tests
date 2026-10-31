import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settingInFile } from './settings-file';

// MultiSync's Copy Files job syncs the media directories the "Copy ..."
// settings pick to a remote.  The remote here is an address no one answers on
// (and the test player has no rsync), so the job fails; what it set out to
// copy is in its log.

const REMOTE = '192.0.2.50';
const COPY = ['MultiSyncCopySequences', 'MultiSyncCopyEffects', 'MultiSyncCopyVideos', 'MultiSyncCopyImages',
  'MultiSyncCopyEvents', 'MultiSyncCopyScripts', 'MultiSyncCopyMusic'];

async function put(request: APIRequestContext, name: string, value: string) {
  const r = await request.put(`/api/settings/${name}`, { data: value });
  expect(r.ok(), await r.text()).toBe(true);
}

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('Copy Images copies the images directory to the remote', async ({ request }) => {
  // Feature: e7dc19f9f.  The Copy Files settings had no Images choice, so a
  // show's images (overlay and image-effect files) never reached a remote.
  // Regression: dc56c44b6.  rsync had no connect timeout, so a remote that
  // drops packets (this one) held the job for the TCP connect timeout per
  // directory, past this test's 30 s.
  const before = Object.fromEntries(COPY.map((k) => [k, settingInFile(k)]));
  try {
    for (const k of COPY) {
      await put(request, k, k === 'MultiSyncCopyImages' ? '1' : '0');
    }
    const r = await request.post('/streamRemoteJobs.php', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ jobs: [{ id: 'c', type: 'copyFiles', ip: REMOTE }] }),
      timeout: 120_000,
    });
    const log = await r.text();
    expect(log).toContain(`Syncing images dir to ${REMOTE}`);
    for (const dir of ['sequences', 'effects', 'videos', 'events', 'scripts', 'music']) {
      expect(log, `${dir} was copied too`).not.toContain(`Syncing ${dir} dir`);
    }
  } finally {
    for (const k of COPY) {
      await put(request, k, before[k] ?? (k === 'MultiSyncCopySequences' ? '1' : '0'));
    }
  }
});
