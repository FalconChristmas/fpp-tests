import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settingInFile, snapshotSettings } from './settings-file';

// A settings backup carries the time zone, and restoring it sets the zone
// again: the TimeZone setting and the system's own zone (/etc/timezone and
// /etc/localtime, which the clock, the scheduler and the logs go by).
//
// Regression: e0ae96aab ("Fix Timezone setting restoration", #2104).  The
// restore wrote TimeZone into the settings file and called SetTimezone()
// itself; it now PUTs /api/settings/TimeZone, which validates the zone and
// applies it the way the settings page does.  Coverage only: putting the
// in-process calls back on today's tree still restores the zone (both
// functions work in the page's process now), so this guards the restore end
// to end rather than going red on that revert.
//
// The backup is taken through the Backup page's form for the "System
// Settings" area alone, which itself was a 500 before e5ccf755a (see
// backup-complete.spec.ts).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const ZONE = 'America/Denver';
const OTHER = 'Europe/London';

function systemZone() {
  return {
    timezone: inPlayer('sh', '-c', 'cat /etc/timezone 2>/dev/null || true').trim(),
    localtime: inPlayer('sh', '-c', 'readlink -f /etc/localtime || true').trim(),
  };
}

async function setZone(request: APIRequestContext, zone: string) {
  const r = await request.put('/api/settings/TimeZone', { data: zone, headers: { 'Content-Type': 'text/plain' } });
  expect(r.ok(), await r.text()).toBe(true);
}

test('restoring System Settings sets the time zone the backup holds', async ({ request }) => {
  test.setTimeout(120_000);
  const restoreSettings = snapshotSettings();
  const was = settingInFile('TimeZone') || 'UTC';
  try {
    await setZone(request, ZONE);
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'settings' } });
    expect(dl.status()).toBe(200);
    const backup = JSON.parse(await dl.text());
    // The control: the backup holds the zone.
    expect(JSON.stringify(backup.settings.timezone)).toContain(ZONE);

    await setZone(request, OTHER);
    expect(systemZone().timezone).toBe(OTHER);

    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: 'settings/timezone',
        conffile: { name: 'fpp-tests-timezone.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) },
      },
    });
    expect(r.status()).toBe(200);

    expect(settingInFile('TimeZone'), 'the TimeZone setting was not restored').toBe(ZONE);
    expect((await (await request.get('/api/settings/TimeZone')).json()).value).toBe(ZONE);
    const sys = systemZone();
    expect(sys.timezone, "the system's zone was not set").toBe(ZONE);
    expect(sys.localtime).toBe(`/usr/share/zoneinfo/${ZONE}`);
  } finally {
    restoreSettings();
    await setZone(request, was);
    inPlayer('sh', '-c', 'rm -f /fpp_restored /fppos_upgraded');
  }
});
