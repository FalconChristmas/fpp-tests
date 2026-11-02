import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Regression: eb4992632.  The I2C outputs (MCP23017, PCA9685, PCF8574) and
// the generic SPI one were offered by platform name -- a Raspberry Pi or a
// BeagleBone Black -- so a board of any other platform (a 64-bit Beagle, a
// plain Linux box) with an I2C bus or SPI device was offered none of them, and
// a Pi or BBB without the device was offered outputs that could not work.  The
// page now offers them when /dev has an i2c-N / spidevN.M (a file of that name
// is all it looks for).  The player here is plain Linux, so the platform file
// is the Raspberry Pi one for the second test.

test.skip(!container, 'adds device nodes and the platform file inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const NODES = ['/dev/i2c-7', '/dev/spidev7.0'];

test.afterEach(() => {
  inPlayer('rm', '-f', PLATFORM, ...NODES);
});

async function types(page: Page): Promise<string[]> {
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await page.waitForFunction(() => typeof (window as any).output_modules !== 'undefined' && (window as any).output_modules.length > 0);
  return page.evaluate(() => (window as any).output_modules.map((m: any) => m.typeName));
}

test('the I2C and SPI outputs are offered where the device exists, whatever the platform', async ({ page }) => {
  // The control: nothing in /dev, none offered.
  const none = await types(page);
  expect(none).toContain('GenericUDP');
  for (const t of ['MCP23017', 'PCA9685', 'PCF8574']) expect(none, `${t} with no I2C bus`).not.toContain(t);
  expect(none, 'an SPI output with no SPI device').not.toContain('GenericSPI');

  inPlayer('touch', ...NODES);
  const some = await types(page);
  for (const t of ['MCP23017', 'PCA9685', 'PCF8574']) expect(some, `${t} with an I2C bus`).toContain(t);
  expect(some, 'no SPI output with a spidev').toContain('GenericSPI');
});

test('a Raspberry Pi without an I2C bus or SPI device is not offered those outputs', async ({ page }) => {
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && echo 'Raspberry Pi' > ${PLATFORM}`);
  const t = await types(page);
  expect(t).toContain('GenericUDP');
  for (const x of ['MCP23017', 'PCA9685', 'PCF8574']) expect(t, `${x} offered without an I2C bus`).not.toContain(x);
  expect(t, 'Generic SPI offered without a spidev').not.toContain('GenericSPI');
});
