import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Regression: 0c6be934e ("Fix restoring Panel Layout and Single Panel Size
// settings", fixes #1576). The LED Panel layout lives in channeloutputs.json
// but the Panel Layout (LEDPanelsLayout) and Single Panel Size (LEDPanelsSize)
// settings sit in the settings file; a restore of the Channel Outputs area
// brought the JSON back and left the two settings as they were, so the
// panel page drew a different matrix than the one restored.
//
// Also covers 0c6be934e's fallback: a backup with no ledPanelsLayout takes
// the layout from the largest panel row/col.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const OUT = `${MEDIA}/config/channeloutputs.json`;

async function restoreWith(request, first: Record<string, unknown>) {
  const had = exists(OUT);
  const before = had ? readFile(OUT) : '';
  const restoreSettings = snapshotSettings();
  try {
    putFile(OUT, JSON.stringify({ channelOutputs: [first] }));
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'channelOutputs' } });
    expect(dl.ok()).toBe(true);
    const backup = await dl.body();
    expect(backup.toString()).toContain('fpp-tests-panels');
    // The player now has other panel settings than the backup.
    setSettingInFile('LEDPanelsSize', '32x16x8');
    setSettingInFile('LEDPanelsLayout', '1x1');
    putFile(OUT, JSON.stringify({ channelOutputs: [{ type: 'x', subType: 'changed' }] }));
    const r = await request.post('/backup.php', {
      multipart: { btnRestoreConfig: '1', restorearea: 'channelOutputs',
        conffile: { name: 'fpp-tests-channelOutputs.json', mimeType: 'application/json', buffer: backup } },
    });
    expect(r.ok()).toBe(true);
    return { size: settingInFile('LEDPanelsSize'), layout: settingInFile('LEDPanelsLayout'), out: readFile(OUT) };
  } finally {
    if (had) putFile(OUT, before); else inPlayer('rm', '-f', OUT);
    restoreSettings();
    inPlayer('rm', '-f', '/fpp_restored');
  }
}

const panel = (extra: Record<string, unknown>) => ({
  type: 'LEDPanelMatrix', subType: 'fpp-tests-panels', enabled: 1, panelWidth: 64, panelHeight: 32, panelScan: 16, ...extra,
});

test('restoring the Channel Outputs area writes the single panel size and layout settings', async ({ request }) => {
  const r = await restoreWith(request, panel({ ledPanelsLayout: '3x2', panels: [{ row: 0, col: 0 }] }));
  expect(r.out).toContain('fpp-tests-panels');
  expect(r.size, 'LEDPanelsSize not taken from the restored panel size').toBe('64x32x16');
  expect(r.layout, 'LEDPanelsLayout not taken from the restored layout').toBe('3x2');
});

test('a backup with no stored layout gets its layout from the panel grid', async ({ request }) => {
  const r = await restoreWith(request, panel({ panels: [{ row: 0, col: 0 }, { row: 1, col: 3 }, { row: 0, col: 1 }] }));
  expect(r.layout, 'LEDPanelsLayout not worked out from the panel rows/cols').toBe('4x2');
});
