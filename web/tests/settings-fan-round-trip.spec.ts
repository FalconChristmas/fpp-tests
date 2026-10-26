import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, php, readSettingsFile, setSettingInFile } from './privacy-helpers';
import { exists, putFile, readFile } from './settings-file';

// Regression: af2dcd6c6 ("store fan trip temperatures with a decimal so F
// round-trips", #2840).  Fan temperatures are stored in C; one entered in F
// was stored as a whole degree C, which can't name every whole degree F: 85 F
// went in as 29 C and came back as 84 F.  It is stored to a tenth now (29.4),
// and what reads it has to take the decimal.  (The fix's fppinit half, the
// boot-time thermal trip writes, needs a thermal zone and isn't checked.)

test.skip(!container, 'reads the settings file inside the run-web.sh container');

function stored(name: string): string | undefined {
  return readSettingsFile().match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
}

test('a Fan On Temperature of 85 F reads back as 85 F', async ({ request }) => {
  inPlayer('sh', '-c', "echo 'Raspberry Pi' > /etc/fpp/platform");
  try {
    await keepingSettings(async () => {
      setSettingInFile('uiLevel', '1');
      setSettingInFile('temperatureInF', '1');
      const r = await request.put('/api/settings/GPIOFanTemperature?skipApply=1', { data: '85' });
      expect(r.ok(), await r.text()).toBe(true);
      expect(Number(stored('GPIOFanTemperature'))).toBeCloseTo(29.4, 5);
      // The page end: the field the settings page prints.
      const html = php('PrintSetting("GPIOFanTemperature");');
      expect(html.match(/value="([^"]*)"/)?.[1], html).toBe('85');
    });
  } finally {
    inPlayer('rm', '-f', '/etc/fpp/platform');
  }
});

test('every whole degree F from 68 to 203 survives the round trip', async ({ request }) => {
  // The fix's own claim, over the settable range (20-95 C).
  inPlayer('sh', '-c', "echo 'Raspberry Pi' > /etc/fpp/platform");
  try {
    await keepingSettings(async () => {
      setSettingInFile('temperatureInF', '1');
      const drifted: string[] = [];
      for (let f = 68; f <= 203; f++) {
        await request.put('/api/settings/GPIOFanTemperature?skipApply=1', { data: String(f) });
        const back = Math.round(Number(stored('GPIOFanTemperature')) * 9 / 5 + 32);
        if (back !== f) drifted.push(`${f} -> ${back}`);
      }
      expect(drifted).toEqual([]);
    });
  } finally {
    inPlayer('rm', '-f', '/etc/fpp/platform');
  }
});

test('a tenth-of-a-degree fan temperature reaches the gpio-fan overlay in millidegrees', async ({ request }) => {
  // The receiving end: SetGPIOFanProperties() appended "000" to the setting,
  // which for 29.4 is not a number the overlay can take.  (The overlay
  // can't load in a container; the config.txt line is as far as this goes.)
  const CONFIG = '/boot/config.txt';
  test.skip(exists(CONFIG), 'the player already has a boot config.txt');
  putFile(CONFIG, '# fpp-tests\n[all]\ndtoverlay=gpio-fan,gpiopin=14,temp=70000\n');
  try {
    await keepingSettings(async () => {
      setSettingInFile('GPIOFan', '1');
      setSettingInFile('temperatureInF', '1');
      const r = await request.put('/api/settings/GPIOFanTemperature', { data: '85' });
      expect(r.ok(), await r.text()).toBe(true);
      await expect.poll(() => readFile(CONFIG)).toContain('dtoverlay=gpio-fan,gpiopin=14,temp=29400\n');
    });
  } finally {
    inPlayer('rm', '-f', CONFIG);
  }
});
