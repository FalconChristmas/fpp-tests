import { test, expect } from './fixtures';
import { container } from './container';
import { sh } from './plugin-repo';

// A config file saved through the API (POST /api/configfile/<name>) is picked
// up by the fppd behind it, every time it is saved.

test.skip(!container, 'saves and restores config files inside the run-web.sh container');

const PRESETS = '/home/fpp/media/config/commandPresets.json';
const inode = () => sh(`stat -c %i ${PRESETS} 2>/dev/null || true`).trim();

test('fppd reloads a config file each time the API saves it', async ({ request }) => {
  // Regression: 21e9df1e5, the end to end of its two halves.
  // UploadConfigFile() now writes a temp file and renames it into place
  // (WriteFileAtomic()), so fppd never reads a half-written file; and
  // FileMonitor now watches for IN_MOVED_TO, without which a file renamed
  // into place is never reloaded.  Here the API saves commandPresets.json
  // twice and fppd runs the new preset after each save.
  sh(`if [ -e ${PRESETS} ]; then cp -p ${PRESETS} ${PRESETS}.fpp-tests; fi`);
  const volume = (await (await request.get('/api/fppd/volume')).json()).volume;
  try {
    for (const value of [17, 23]) {
      const presets = { commands: [{ name: 'fpp-tests-reload', command: 'Volume Set', args: [String(value)], presetSlot: 0 }] };
      const before = inode();
      const save = await request.post('/api/configfile/commandPresets.json', { data: JSON.stringify(presets) });
      expect(save.ok(), await save.text()).toBe(true);
      // The PHP half: the file was replaced (a new inode), not rewritten.
      expect(inode(), 'the saved file').not.toBe(before);
      await expect.poll(async () => {
        await request.post('/api/command', { data: { command: 'Trigger Command Preset', args: ['fpp-tests-reload'] } });
        return (await (await request.get('/api/fppd/volume')).json()).volume;
      }, { message: `the preset saved with volume ${value}`, timeout: 15_000 }).toBe(value);
    }
  } finally {
    sh(`if [ -e ${PRESETS}.fpp-tests ]; then mv ${PRESETS}.fpp-tests ${PRESETS}; else rm -f ${PRESETS}; fi`);
    await request.post('/api/command', { data: { command: 'Volume Set', args: [String(volume)] } });
  }
});
