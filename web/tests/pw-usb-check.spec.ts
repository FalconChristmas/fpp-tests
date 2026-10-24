import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './pw-helpers';
import { settingInFile, setSettingInFile } from './settings-file';

// The USB bandwidth check for sound cards: GET /api/pipewire/audio/usb-check
// and the warning the audio groups page shows from it.  Full-speed USB sound
// cards behind one single-TT hub share a 12 Mbit/s budget and cannot all
// play at once.  The topology comes from /proc/asound and /sys, which a
// container cannot fake, so the hub logic (UsbFindTTOwner) is run on its
// own against a sysfs tree built for the test; the kernel-log half goes
// through the API with a stand-in dmesg.  dmesg takes no arguments here, as
// the real one does.

test.skip(!container, 'stands in dmesg and a sysfs tree inside the run-web.sh container');

const SYS = '/tmp/fpp-tests-usb';
const DMESG = '/usr/local/bin/dmesg';

test.afterEach(() => inPlayer('rm', '-rf', SYS, DMESG));

// A USB device in the fake sysfs: its speed, and for a hub its protocol
// (1 = one transaction translator for all its ports, 2 = one per port).
function device(path: string, speed: string, protocol = '00', product = path) {
  for (const [k, v] of Object.entries({ speed, bDeviceProtocol: protocol, product })) writeFile(`${SYS}/${path}/${k}`, v + '\n');
}

function ttOwner(path: string) {
  const out = inPlayer('sh', '-c', `cd /opt/fpp/www/api && php -r 'include "controllers/pipewire.php"; ` +
    `echo json_encode(UsbFindTTOwner($argv[1], $argv[2]));' ${path} ${SYS}`);
  return JSON.parse(out);
}

test('full-speed cards behind one single-TT hub share its translator; a multi-TT hub gives each port its own', () => {
  // Feature: e0977461d. A full-speed device's traffic goes through the
  // translator of the nearest high-speed hub above it; cards with the same
  // translator are the ones that cannot all stream.
  device('1-1', '480', '01', 'single-TT hub');
  device('1-1.2', '12');
  device('1-1.3', '12');
  device('2-1', '480', '02', 'multi-TT hub');
  device('2-1.2', '12');
  device('2-1.3', '12');
  device('3-1', '480', '01', 'single-TT hub');
  device('3-1.4', '12', '00', 'full-speed hub');
  device('3-1.4.1', '12');

  expect(ttOwner('1-1.2')).toMatchObject({ hubPath: '1-1', multiTT: false, ttKey: '1-1', hubProduct: 'single-TT hub' });
  expect(ttOwner('1-1.3').ttKey).toBe('1-1');
  expect(ttOwner('2-1.2')).toMatchObject({ hubPath: '2-1', multiTT: true, ttKey: '2-1:2' });
  expect(ttOwner('2-1.3').ttKey).toBe('2-1:3');
  // Through a full-speed hub to the high-speed one above it.
  expect(ttOwner('3-1.4.1')).toMatchObject({ hubPath: '3-1', port: '4', ttKey: '3-1' });
  // On a root port the controller itself speaks full speed: no translator.
  expect(ttOwner('1-2')).toBeNull();
});

test('USB bandwidth errors in the kernel log are reported, and the audio groups page warns of them', async ({ request, page }) => {
  // Feature: e0977461d. The kernel's "Not enough bandwidth" errors are what
  // the failure looks like even when the topology check misses it.
  const clean = await (await request.get('/api/pipewire/audio/usb-check')).json();
  expect(clean).toMatchObject({ status: 'ok', conflicts: [], kernelErrors: [] });

  writeFile(DMESG, '#!/bin/sh\n# fpp-tests stand-in\necho "[   12.345678] usb 1-1.2: Not enough bandwidth for new device state."\n' +
    'echo "[   12.345699] usb 1-1.2: usb_set_interface failed (-28)"\necho "[   13.000000] something else"\n');
  inPlayer('chmod', '755', DMESG);
  const r = await request.get('/api/pipewire/audio/usb-check');
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  expect(body.status).toBe('warning');
  expect(body.kernelErrors).toEqual([
    '[   12.345678] usb 1-1.2: Not enough bandwidth for new device state.',
    '[   12.345699] usb 1-1.2: usb_set_interface failed (-28)',
  ]);

  const saved = ['MediaBackend', 'AudioBackend'].map(settingInFile);
  try {
    for (const k of ['MediaBackend', 'AudioBackend']) setSettingInFile(k, 'pipewire');
    await page.goto('/pipewire-audio.php');
    await expect(page.locator('#usbBandwidthWarning')).toContainText('USB audio bandwidth errors found in the kernel log', { timeout: 15_000 });

    // Two cards sharing one translator name the cards and the fix.
    await page.route('**/api/pipewire/audio/usb-check', (rt) => rt.fulfill({ json: {
      status: 'warning', model: '', devices: [], kernelErrors: [],
      conflicts: [{ ttKey: '1-1', hubProduct: 'single-TT hub', cards: [
        { cardNum: 1, cardId: 'Device', product: 'USB Audio A', usbPath: '1-1.2' },
        { cardNum: 2, cardId: 'Device_1', product: 'USB Audio B', usbPath: '1-1.3' }] }] } }));
    await page.reload();
    const box = page.locator('#usbBandwidthWarning');
    await expect(box).toContainText('cannot all play audio at the same time', { timeout: 15_000 });
    await expect(box).toContainText('USB Audio A [Device]');
    await expect(box).toContainText('USB Audio B [Device_1]');
    await expect(box).toContainText('multi-TT');
  } finally {
    ['MediaBackend', 'AudioBackend'].forEach((k, i) => setSettingInFile(k, saved[i]));
  }
});
