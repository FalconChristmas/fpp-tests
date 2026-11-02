import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, snapshotSettings } from './settings-file';

// The Virtual EEPROM backup area: cape-eeprom.bin is binary, so the backup
// carries it base64 (not split into lines, not run through the sensitive-data
// filter) and a restore writes the bytes back.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const EEPROM = `${MEDIA}/config/cape-eeprom.bin`;

test('the Virtual EEPROM area backs up and restores the cape EEPROM bytes', async ({ request }) => {
  // Regression: fa23e08f1.  cape-eeprom.bin was not a backup area at all, so
  // a backup and restore left a player without its virtual cape.  Bytes that
  // are not text (NUL, 0xff, a CR/LF pair) must survive the round trip.
  const had = exists(EEPROM);
  const kept = had ? inPlayer('base64', EEPROM) : '';
  const restoreSettings = snapshotSettings();
  const original = Buffer.from([0x46, 0x50, 0x30, 0x32, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x41]);
  try {
    putFile(EEPROM, original);
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'virtualEEPROM' } });
    expect(dl.ok()).toBe(true);
    const backup = await dl.body();
    expect(JSON.parse(backup.toString()).virtualEEPROM?.['cape-eeprom.bin']?.[0], 'the backup does not carry the EEPROM')
      .toBe(original.toString('base64'));

    putFile(EEPROM, Buffer.from('changed'));
    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: 'virtualEEPROM',
        conffile: { name: 'fpp-tests-eeprom.json', mimeType: 'application/json', buffer: backup },
      },
    });
    expect(r.ok()).toBe(true);
    const restored = Buffer.from(inPlayer('base64', EEPROM).replace(/\s/g, ''), 'base64');
    expect(restored.toString('hex')).toBe(original.toString('hex'));
  } finally {
    if (had) putFile(EEPROM, Buffer.from(kept.replace(/\s/g, ''), 'base64')); else inPlayer('rm', '-f', EEPROM);
    restoreSettings();
    inPlayer('rm', '-f', '/fpp_restored');
  }
});
