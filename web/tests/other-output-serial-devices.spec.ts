import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: d83140938 ("Improve serial port detection for other outputs").
// The serial ports offered to the serial Other outputs (Renard, DMX, LOR...)
// are the /dev names the page matches, and ttyS<n> was matched but not
// ttySC<n>, the names an SC16IS752 UART expander's ports get (a Waveshare
// 2-channel RS485 HAT, say), so its ports could not be chosen.  A file of
// that name in /dev is all the page looks for.

test.skip(!container, 'adds device nodes inside the run-web.sh container');

const NODES = ['/dev/ttySC7', '/dev/ttyS77'];

test.afterEach(() => {
  inPlayer('rm', '-f', ...NODES);
});

test('an SC16IS752 expander port (ttySC<n>) is offered as a serial device', async ({ page }) => {
  inPlayer('touch', ...NODES);
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await page.waitForFunction(() => typeof (window as any).SerialDevices !== 'undefined');
  const devs = await page.evaluate(() => Object.keys((window as any).SerialDevices));
  expect(devs, 'the control: a plain ttyS port').toContain('ttyS77');
  expect(devs).toContain('ttySC7');
});
