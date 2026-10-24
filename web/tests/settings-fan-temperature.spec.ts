import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, php, readSettingsFile, setSettingInFile } from './privacy-helpers';
import { exists, putFile, readFile } from './settings-file';

// Fan On Temperature is stored in degrees C, whatever the UI's temperature
// units; a player set to Fahrenheit takes and shows it in F.

test.skip(!container, 'reads the settings file inside the run-web.sh container');

function stored(name: string): string | undefined {
  const m = readSettingsFile().match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
  return m?.[1];
}

test('a Fan On Temperature typed in F is stored in C, and one typed in C as it is', async ({ request }) => {
  // Regression: 056bba431.  The value went into the settings file as typed,
  // so 122 (F) became a fan that waits for 122 C.
  await keepingSettings(async () => {
    setSettingInFile('temperatureInF', '1');
    let r = await request.put('/api/settings/GPIOFanTemperature?skipApply=1', { data: '122' });
    expect(r.ok(), await r.text()).toBe(true);
    expect(Number(stored('GPIOFanTemperature'))).toBe(50);

    // The control: in C nothing converts.
    setSettingInFile('temperatureInF', '0');
    r = await request.put('/api/settings/GPIOFanTemperature?skipApply=1', { data: '60' });
    expect(r.ok()).toBe(true);
    expect(Number(stored('GPIOFanTemperature'))).toBe(60);
  });
});

test('the settings page shows Fan On Temperature in F when the UI is in F', async () => {
  // Regression: 056bba431.  The field showed the stored degrees C under a
  // " C" suffix whatever the units.  The setting is Raspberry Pi only and at
  // the Advanced UI level, so the player is made one for the test.
  inPlayer('sh', '-c', "echo 'Raspberry Pi' > /etc/fpp/platform");
  try {
    await keepingSettings(async () => {
      setSettingInFile('uiLevel', '1');
      setSettingInFile('GPIOFanTemperature', '50');
      setSettingInFile('temperatureInF', '1');
      let html = php('PrintSetting("GPIOFanTemperature");');
      expect(html).toMatch(/id=.GPIOFanTemperature./);
      expect(html.match(/value="([^"]*)"/)?.[1], html).toBe('122');
      expect(html).toContain(' F');

      // The control: in C it is shown as stored.
      setSettingInFile('temperatureInF', '0');
      html = php('PrintSetting("GPIOFanTemperature");');
      expect(html.match(/value="([^"]*)"/)?.[1], html).toBe('50');
    });
  } finally {
    inPlayer('rm', '-f', '/etc/fpp/platform');
  }
});

test('a Fan On Temperature typed in F reaches the fan overlay in millidegrees C', async ({ request }) => {
  // Regression: 056bba431.  The receiving end: saving the setting rewrites
  // the boot config.txt's gpio-fan overlay line, whose temp= the Raspberry Pi
  // gpio-fan overlay reads in millidegrees C (the overlay itself can't load in
  // a container, so the line is as far as this goes).  122 F is 50 C.
  const CONFIG = '/boot/config.txt';
  test.skip(exists(CONFIG), 'the player already has a boot config.txt');
  putFile(CONFIG, '# fpp-tests\n[all]\ndtoverlay=gpio-fan,gpiopin=14,temp=70000\n');
  try {
    await keepingSettings(async () => {
      setSettingInFile('GPIOFan', '1');
      setSettingInFile('temperatureInF', '1');
      const r = await request.put('/api/settings/GPIOFanTemperature', { data: '122' });
      expect(r.ok(), await r.text()).toBe(true);
      await expect.poll(() => readFile(CONFIG)).toContain('dtoverlay=gpio-fan,gpiopin=14,temp=50000');
    });
  } finally {
    inPlayer('rm', '-f', CONFIG);
  }
});
