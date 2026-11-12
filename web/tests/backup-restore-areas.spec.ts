import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, snapshotSettings } from './settings-file';

// Restoring the areas of a settings backup that each put one file of the
// show's back (processRestoreData() in backup.php): Output Processors (the
// remaps, brightness and the like fppd applies to every frame), GPIO Input
// Triggers, a plugin's own config files, and the old Channel Memory Maps.
// Each is backed up from the Backup page, the file changed, and the backup
// restored over it: the file is what was backed up.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const CONFIG = `${MEDIA}/config`;

// Puts each file as given, backs up the area, puts each as changed, and
// restores; returns the files as the restore left them.  Every file is put
// back as it was before the test.
async function backupAndRestore(request: APIRequestContext, area: string,
  files: Record<string, { original: string | null; changed: string | null }>) {
  const before: Record<string, string | null> = {};
  for (const f of Object.keys(files)) before[f] = exists(f) ? readFile(f) : null;
  const put = (f: string, c: string | null) => (c === null ? inPlayer('rm', '-f', f) : putFile(f, c));
  const restoreSettings = snapshotSettings();
  try {
    for (const [f, { original }] of Object.entries(files)) put(f, original);
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: area } });
    expect(dl.ok()).toBe(true);
    const backup = await dl.body();
    expect(backup.toString(), `the backup does not carry the ${area} area`).toContain('fpp-tests');
    for (const [f, { changed }] of Object.entries(files)) put(f, changed);

    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: area,
        conffile: { name: `fpp-tests-${area}.json`, mimeType: 'application/json', buffer: backup },
      },
    });
    expect(r.ok()).toBe(true);
    const after: Record<string, string | null> = {};
    for (const f of Object.keys(files)) after[f] = exists(f) ? readFile(f) : null;
    return after;
  } finally {
    for (const [f, c] of Object.entries(before)) put(f, c);
    restoreSettings();
    inPlayer('rm', '-f', '/fpp_restored');
  }
}

test('restoring Output Processors puts the processors back', async ({ request }) => {
  const file = `${CONFIG}/outputprocessors.json`;
  const processors = (desc: string, brightness: number) => JSON.stringify({ outputProcessors: [
    { type: 'Remap', active: 1, description: desc, source: 1, destination: 301, count: 30, loops: 1, reverse: 0 },
    { type: 'Brightness', active: 1, description: `${desc} dim`, start: 1, count: 300, brightness, gamma: 2.2 },
  ] }, null, 4);
  const after = await backupAndRestore(request, 'outputProcessors', {
    [file]: { original: processors('fpp-tests remap', 60), changed: processors('changed', 100) },
  });
  expect(JSON.parse(after[file]!)).toEqual(JSON.parse(processors('fpp-tests remap', 60)));
});

test('restoring GPIO Input Triggers puts the inputs back', async ({ request }) => {
  const file = `${CONFIG}/gpio.json`;
  const gpio = (pin: string) => JSON.stringify([{
    pin, mode: 'gpio_pu', enabled: true, desc: 'fpp-tests button', debounceTime: 100, debounceEdge: 'both',
    rising: { command: 'Start Playlist', args: ['fpp-tests', 'false', 'false'] },
    falling: { command: '', args: [] },
  }], null, 4);
  const after = await backupAndRestore(request, 'gpio-input', {
    [file]: { original: gpio('P9-12'), changed: gpio('P9-15') },
  });
  expect(JSON.parse(after[file]!)).toEqual(JSON.parse(gpio('P9-12')));
});

test("restoring Plugins puts each of a plugin's config files back as it was", async ({ request }) => {
  const ini = `${CONFIG}/plugin.fpp-tests`;
  const json = `${CONFIG}/plugin.fpp-tests.json`;
  const after = await backupAndRestore(request, 'plugins', {
    [ini]: { original: 'host = "fpp-tests.local"\nport = "8080"\n', changed: 'host = "changed"\n' },
    [json]: { original: '{\n    "fppTests": [1, 2, 3]\n}\n', changed: '{}\n' },
  });
  expect(after[ini]).toBe('host = "fpp-tests.local"\nport = "8080"\n');
  expect(after[json]).toBe('{\n    "fppTests": [1, 2, 3]\n}\n');
});

// The Channel Memory Maps branch writes the map's lines back and leaves
// model-overlays.json, the Pixel Overlay Models, as it was.
test('restoring the old Channel Memory Maps puts the map back and leaves the overlay models alone', async ({ request }) => {
  const maps = `${MEDIA}/channelmemorymaps`;
  const models = `${CONFIG}/model-overlays.json`;
  const model = JSON.stringify({ models: [{
    Name: 'fpp-tests-model', Type: 'Channel', StartChannel: 1, ChannelCount: 30, ChannelCountPerNode: 3,
    Orientation: 'horizontal', StartCorner: 'TL', StringCount: 1, StrandsPerString: 1,
  }] }, null, 4);
  const after = await backupAndRestore(request, 'channelmemorymaps', {
    [maps]: { original: 'fpp-tests-map,1,30,horizontal,TL,1,1\n', changed: 'changed,1,3,horizontal,TL,1,1\n' },
    [models]: { original: model, changed: model },
  });
  expect(after[maps]).toBe('fpp-tests-map,1,30,horizontal,TL,1,1\n');
  expect(JSON.parse(after[models]!), 'the overlay models').toEqual(JSON.parse(model));
});
