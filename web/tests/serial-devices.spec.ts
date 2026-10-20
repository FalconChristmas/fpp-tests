import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// USB serial adapters are numbered in the order they are found, so ttyUSB0 can
// be a different adapter after a reboot.  fpp 28e96a92c ("feat(api): report
// each serial device's reboot-stable name") added GET
// /api/channel/output/serialDevices, which gives each serial device a name
// that stays with it: its by-id link, else its by-path link.
//
// The device and its by-path link are stand-ins made by the test.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a serial device is listed with its reboot-stable name', async ({ request }) => {
  inPlayer('sh', '-c', 'touch /dev/ttyUSB7 && mkdir -p /dev/serial/by-path && ln -sfn ../../ttyUSB7 /dev/serial/by-path/fpp-tests-port0');
  try {
    const r = await request.get('/api/channel/output/serialDevices');
    expect(r.status()).toBe(200);
    const devices = (await r.json()).devices as any[];
    const dev = devices.find((d) => d.device === 'ttyUSB7');
    expect(dev, JSON.stringify(devices)).toBeTruthy();
    expect(dev.stable).toBe('serial/by-path/fpp-tests-port0');
  } finally {
    inPlayer('rm', '-f', '/dev/ttyUSB7', '/dev/serial/by-path/fpp-tests-port0');
  }
});
