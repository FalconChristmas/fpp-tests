import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, snapshotSettings } from './settings-file';

// Feature: e3cb4b0e0 ("backup multiple files under Channel Inputs").  The
// Channel Inputs area holds two files, the E1.31/DDP inputs and the DMX
// inputs; a backup carries both and a restore puts both back.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const UNIVERSES = `${MEDIA}/config/ci-universes.json`;
const DMX = `${MEDIA}/config/ci-dmx.json`;

test('restoring the Channel Inputs area puts back both input files', async ({ request }) => {
  const kept = [UNIVERSES, DMX].map((f) => (exists(f) ? readFile(f) : null));
  const restoreSettings = snapshotSettings();
  const universes = (d: string) => JSON.stringify({ channelInputs: [{ type: 'universes', enabled: 0, startChannel: 1, channelCount: 512, universes: [{ id: 1, description: d }] }] });
  const dmx = (d: string) => JSON.stringify({ channelInputs: [{ type: 'DMX', enabled: 0, startChannel: 1, channelCount: 512, description: d }] });
  try {
    putFile(UNIVERSES, universes('fpp-tests universes backed up'));
    putFile(DMX, dmx('fpp-tests dmx backed up'));
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'channelInputs' } });
    expect(dl.ok()).toBe(true);
    const backup = await dl.body();
    const text = backup.toString();
    expect(text).toContain('fpp-tests universes backed up');
    expect(text).toContain('fpp-tests dmx backed up');

    putFile(UNIVERSES, universes('changed'));
    putFile(DMX, dmx('changed'));
    const r = await request.post('/backup.php', {
      multipart: { btnRestoreConfig: '1', restorearea: 'channelInputs',
        conffile: { name: 'fpp-tests-channelInputs.json', mimeType: 'application/json', buffer: backup } },
    });
    expect(r.ok()).toBe(true);
    expect(readFile(UNIVERSES)).toContain('fpp-tests universes backed up');
    expect(readFile(DMX)).toContain('fpp-tests dmx backed up');
  } finally {
    [UNIVERSES, DMX].forEach((f, i) => (kept[i] === null ? inPlayer('rm', '-f', f) : putFile(f, kept[i]!)));
    restoreSettings();
    inPlayer('rm', '-f', '/fpp_restored');
  }
});
