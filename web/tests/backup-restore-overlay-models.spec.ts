import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, snapshotSettings } from './settings-file';

// Regression: 61e8c4ff3 ("restore Pixel Overlay Models and Virtual Display
// Map, previously silently dropped"). The Pixel Overlay Models area was
// backed up, but processRestoreData() had no branch for it, so restoring it
// reported nothing and left model-overlays.json as it was; the Virtual
// Display Map was not an area at all.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

async function backupAndRestore(request, area: string, file: string, original: string, changed: string) {
  const had = exists(file);
  const before = had ? readFile(file) : '';
  const restoreSettings = snapshotSettings();
  putFile(file, original);
  try {
    // A backup of the area, as the Backup page downloads it.
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: area } });
    expect(dl.ok()).toBe(true);
    const backup = await dl.body();
    expect(backup.toString(), `the backup does not carry the ${area} area`).toContain('fpp-tests');
    putFile(file, changed);

    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: area,
        conffile: { name: `fpp-tests-${area}.json`, mimeType: 'application/json', buffer: backup },
      },
    });
    expect(r.ok()).toBe(true);
    return readFile(file);
  } finally {
    if (had) putFile(file, before); else inPlayer('rm', '-f', file);
    restoreSettings();
    inPlayer('rm', '-f', '/fpp_restored');
  }
}

test('restoring the Pixel Overlay Models area puts the models back', async ({ request }) => {
  const model = (name: string) => JSON.stringify({ models: [{
    Name: name, Type: 'Channel', StartChannel: 1, ChannelCount: 30, ChannelCountPerNode: 3,
    Orientation: 'horizontal', StartCorner: 'TL', StringCount: 1, StrandsPerString: 1,
  }] });
  const after = await backupAndRestore(request, 'model-overlays', `${MEDIA}/config/model-overlays.json`,
    model('fpp-tests-backed-up'), model('fpp-tests-changed'));
  const names = JSON.parse(after).models.map((m) => m.Name);
  expect(names, 'the restore left the changed models').toEqual(['fpp-tests-backed-up']);
});

test('restoring the Virtual Display Map area puts the map back', async ({ request }) => {
  const after = await backupAndRestore(request, 'virtualdisplaymap', `${MEDIA}/config/virtualdisplaymap`,
    '# fpp-tests backed up\n10,20,0,0,1,RGB\n', '# changed\n');
  expect(after.trimEnd()).toBe('# fpp-tests backed up\n10,20,0,0,1,RGB');
});
