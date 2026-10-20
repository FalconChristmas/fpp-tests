import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, Sink, keepingFile, keepingSettings, setSettingInFile } from './privacy-helpers';

// When POST /api/statistics/usage (what fppd calls on start and then daily)
// actually uploads.  statsPublishUrl points the upload at a stand-in in the
// player, which records each one.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const STATE = `${MEDIA}/config/stats_publish_state.json`;

async function publish(request: APIRequestContext) {
  // The payload is cached for two hours; clearing it is what lets a change
  // be seen, as a later cache expiry would.
  expect((await request.delete('/api/statistics/usage')).ok()).toBe(true);
  const r = await request.post('/api/statistics/usage');
  const text = await r.text();
  expect(r.ok(), text).toBe(true);
  return JSON.parse(text);
}

test('statistics are uploaded when the configuration changed or a week has passed, not on every ask', async ({ request }) => {
  // Regression: c82217bf4.  Every ask uploaded, so the stored statistics were
  //   mostly a timestamped record of each restart.
  // Feature: dbeaed7e3.  An unchanged device still checks in once the weekly
  //   interval has passed, and the skip says when that will be.
  const sink = Sink.start(18118);
  try {
    await keepingSettings(() => keepingFile(STATE, async () => {
      // Left as the setup wizard made it (US: Enabled).  Changing it here
      // would start fppd's own opt-in upload, two minutes later, to the real
      // server once this test has put the settings back.
      expect(inPlayer('cat', `${MEDIA}/settings`)).toContain('statsPublish = "Enabled"');
      setSettingInFile('statsPublishUrl', sink.url);
      inPlayer('rm', '-f', STATE);

      expect(await publish(request)).toEqual({ status: 'OK' });
      expect(sink.requests(), 'the first ask did not upload').toHaveLength(1);
      const state = JSON.parse(inPlayer('cat', STATE));
      expect(state.hash).toMatch(/^[0-9a-f]{64}$/);

      const skipped = await publish(request);
      expect(skipped.status, 'an unchanged configuration was uploaded again').toBe('skipped');
      expect(skipped.reason).toMatch(/next periodic publish in \d+s/);
      expect(sink.requests()).toHaveLength(1);

      // A collected setting changes: the configuration moved.
      setSettingInFile('WLEDAudioSyncMode', 'fpp-tests-changed');
      expect((await publish(request)).status, 'a changed configuration was not uploaded').toBe('OK');
      expect(sink.requests()).toHaveLength(2);
      expect((await publish(request)).status).toBe('skipped');

      // Nothing changed, but the last upload was eight days ago.
      const now = JSON.parse(inPlayer('cat', STATE));
      inPlayer('sh', '-c', `printf '%s' '${JSON.stringify({ ...now, lastPublish: now.lastPublish - 8 * 86400 })}' > ${STATE}`);
      expect((await publish(request)).status, 'no weekly check-in').toBe('OK');
      expect(sink.requests()).toHaveLength(3);
      expect((await publish(request)).status, 'the weekly timer did not re-arm').toBe('skipped');
      expect(sink.requests().every((l) => l.startsWith('POST /upload '))).toBe(true);
    }));
  } finally {
    sink.stop();
  }
});
