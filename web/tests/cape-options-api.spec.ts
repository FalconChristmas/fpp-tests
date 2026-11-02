import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Feature: d63d01cc2 ("Experiment with allowing setting of any cape/hat
// during Initial setup if not detected").  GET /api/cape/options lists the
// capes the Installed Cape select offers (InstalledCape's optionsURL): one
// per capes/<platform>/<name>-eeprom.bin, after "--None--".  The player
// here is not a Pi or a PocketBeagle, so it lists capes/bbb.

test.skip(!container, 'reads the capes directory inside the run-web.sh container');

test('the cape options are --None-- and then each cape EEPROM image the platform has', async ({ request }) => {
  const r = await request.get('/api/cape/options');
  expect(r.status()).toBe(200);
  const options = await r.json();
  const images = inPlayer('sh', '-c', 'ls /opt/fpp/capes/bbb').split('\n')
    .filter((f) => f.length > 11 && f.endsWith('-eeprom.bin')).map((f) => f.slice(0, -11));
  // The control: there are capes to list.
  expect(images.length).toBeGreaterThan(0);
  expect(options[0]).toBe('--None--');
  expect(options.slice(1).sort()).toEqual(images.sort());
});
