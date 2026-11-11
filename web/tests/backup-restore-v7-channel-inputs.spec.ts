import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, snapshotSettings } from './settings-file';

// A backup made before FPP 8 (fpp_backup_version 7.x): Channel Inputs was one
// file then, the E1.31/DDP inputs, carried as that file's own JSON
// ({"channelInputs": {"channelInputs": [...]}}).  Since 8.0 the area holds two
// files (backup-restore-channel-inputs.spec.ts), so processRestoreData()
// moves an old backup's inputs under universe_inputs: restored, they are the
// player's E1.31 inputs again, and the DMX inputs, which the old backup knows
// nothing of, are left as they are.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const UNIVERSES = `${MEDIA}/config/ci-universes.json`;
const DMX = `${MEDIA}/config/ci-dmx.json`;

const inputs = (description: string) => [{
  type: 'universes', enabled: 1, startChannel: 1, channelCount: 1024,
  universes: [{ active: 1, description, id: 7, startChannel: 1, size: 512, type: 0, address: '', priority: 0 },
    { active: 1, description: `${description} 2`, id: 8, startChannel: 513, size: 512, type: 0, address: '', priority: 0 }],
}];

let kept: (string | null)[] = [];
let restoreSettings: () => void = () => {};
test.beforeEach(() => {
  kept = [UNIVERSES, DMX].map((f) => (exists(f) ? readFile(f) : null));
  restoreSettings = snapshotSettings();
});
test.afterEach(() => {
  [UNIVERSES, DMX].forEach((f, i) => (kept[i] === null ? inPlayer('rm', '-f', f) : putFile(f, kept[i]!)));
  restoreSettings();
  inPlayer('rm', '-f', '/fpp_restored');
});

async function restore(request: any, backup: unknown, area: string) {
  const r = await request.post('/backup.php', {
    multipart: { btnRestoreConfig: '1', restorearea: area,
      conffile: { name: 'fpp-tests-v7-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) } },
  });
  expect(r.ok()).toBe(true);
}

const v7 = (description: string) => ({
  channelInputs: { channelInputs: inputs(description) },
  backup_comment: 'fpp-tests 7.4 backup', fpp_backup_version: '7.4', backup_taken: 1700000000, protected: false, platform: 'Raspberry Pi',
});

for (const area of ['channelInputs', 'all']) {
  test(`an FPP 7 backup's E1.31 inputs are restored as the E1.31 inputs (restoring ${area === 'all' ? 'everything' : 'Channel Inputs'})`, async ({ request }) => {
    putFile(UNIVERSES, JSON.stringify({ channelInputs: inputs('changed since') }));
    const dmx = JSON.stringify({ channelInputs: [{ type: 'DMX', enabled: 0, startChannel: 1, channelCount: 512, description: 'fpp-tests dmx kept' }] });
    putFile(DMX, dmx);
    await restore(request, v7('fpp-tests v7 yard'), area);

    // The file as FPP 8+ reads it: {"channelInputs": [...]}, not nested again.
    const got = JSON.parse(readFile(UNIVERSES));
    expect(Object.keys(got)).toEqual(['channelInputs']);
    expect(got.channelInputs).toEqual(inputs('fpp-tests v7 yard'));
    expect(JSON.parse(readFile(DMX))).toEqual(JSON.parse(dmx));
  });
}

test('an FPP 8 backup of the same inputs is not moved again', async ({ request }) => {
  putFile(UNIVERSES, JSON.stringify({ channelInputs: inputs('changed since') }));
  await restore(request, {
    channelInputs: { universe_inputs: [{ channelInputs: inputs('fpp-tests v8 yard') }], dmx_inputs: [null] },
    fpp_backup_version: '8.0', backup_taken: 1700000000, protected: false, platform: 'Raspberry Pi',
  }, 'channelInputs');
  expect(JSON.parse(readFile(UNIVERSES))).toEqual({ channelInputs: inputs('fpp-tests v8 yard') });
});
