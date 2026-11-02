import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// The virtual EEPROMs the Pixel Strings tab offers on a Raspberry Pi, by
// model.  config.php reads the model from the device tree, so as in
// led-panels-platform-ui.spec.ts it is made to read it from a file for the
// length of each test.

test.skip(!container, 'changes the platform and the served config.php inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CONFIG = '/opt/fpp/www/config.php';
const PIMODEL = '/tmp/fpp-tests-pimodel';
const EEPROM = `${MEDIA}/config/cape-eeprom.bin`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;

const drawnWith = async (request: APIRequestContext, text: string) =>
  (await (await request.get('/channeloutputs.php')).text()).includes(text);

async function becomePi(request: APIRequestContext, model: string) {
  inPlayer('sh', '-c', `printf '%s' 'Raspberry Pi' > ${PLATFORM} && printf '%s\\0' '${model}' > ${PIMODEL} &&
    sed -i 's#"/sys/firmware/devicetree/base/model"#"${PIMODEL}"#' ${CONFIG}`);
  await expect.poll(() => drawnWith(request, `"SubPlatform":"${model}"`), { timeout: 15_000 }).toBe(true);
}

let savedPlatform = '';
let savedFiles: Record<string, string> = {};
test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  savedFiles = {};
  for (const p of [EEPROM, CAPE_INFO]) {
    savedFiles[p] = inPlayer('sh', '-c', `if [ -e ${p} ]; then base64 ${p}; fi`);
  }
  inPlayer('rm', '-f', EEPROM, CAPE_INFO);
});
test.afterEach(async ({ request }) => {
  if (inPlayer('sh', '-c', `grep -c 'fpp-tests-' ${CONFIG} || true`).trim() !== '0') {
    inPlayer('sh', '-c', `sed -i 's#"${PIMODEL}"#"/sys/firmware/devicetree/base/model"#' ${CONFIG}; rm -f ${PIMODEL}`);
    await expect.poll(() => drawnWith(request, 'fpp-tests-'), { timeout: 15_000 }).toBe(false);
  }
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  for (const [p, b64] of Object.entries(savedFiles)) {
    if (b64) inPlayer('sh', '-c', 'echo "$2" | base64 -d > "$1" && chmod 644 "$1"', 'sh', p, b64);
  }
});

async function eepromOptions(page: import('@playwright/test').Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await page.locator('input[value="Install Virtual EEPROM"]').click();
  await expect(page.locator('#virtualEEPROM')).toBeVisible();
  return page.locator('#virtualEEPROM option').allTextContents();
}

test('a Pi 5 is offered the PiHat virtual EEPROMs but not the spixels and rPi- ones', async ({ page, request }) => {
  // Regression: 13089f193.  The PiHat's virtual EEPROM may be installed on a
  // Pi 5; the spixels and rPi-28D/MFC ones drive hardware the Pi 5's GPIO
  // cannot, and an RPIWS281X variant could be chosen though no driver
  // exists for it.
  await becomePi(request, 'Raspberry Pi 5 Model B Rev 1.0');
  const options = await eepromOptions(page);
  expect(options).toContain('PiHat');
  expect(options.filter((o) => /spixels|^rPi-/.test(o))).toEqual([]);
});

test('a Pi 4 is offered the whole list, the control for the Pi 5 spec above', async ({ page, request }) => {
  await becomePi(request, 'Raspberry Pi 4 Model B Rev 1.4');
  const options = await eepromOptions(page);
  expect(options).toContain('PiHat');
  expect(options.some((o) => /^rPi-/.test(o))).toBe(true);
  expect(options.some((o) => /spixels/.test(o))).toBe(true);
});
