import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Smart v2 receivers on the Pixel Strings tab (harness as in
// pixel-strings-smart-receivers.spec.ts): the type and count the page saves
// as differentialType, and how that is drawn back.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsSmart.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsSmart', longName: 'fpp-tests smart receiver cape', numSerial: 0,
  supportsSmartReceivers: true,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4, type: 'differential' }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsSmart', name: 'fpp-tests smart', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function stringsConfig(differentialType: number) {
  const port = (portNumber: number, dt: number) => ({
    portNumber, protocol: 'ws2811', differentialType: dt,
    virtualStrings: [{
      description: `s${portNumber}`, startChannel: 1 + portNumber * 30, pixelCount: 10, groupCount: 0, reverse: 0,
      colorOrder: 'RGB', nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
    }],
  });
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsSmart', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: 4,
      outputs: [port(0, differentialType), port(1, 0), port(2, 0), port(3, 0)],
    }],
  };
}

function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}

function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

function putBack(path: string, content: string | null) {
  if (content === null) {
    inPlayer('rm', '-f', path);
  } else {
    writeFile(path, content);
  }
}

let saved: Record<string, string | null> = {};

test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG]) {
    saved[p] = readFile(p);
  }
  writeFile(PLATFORM, 'BeagleBone Black');
  writeFile(CAPE_FILE, JSON.stringify(CAPE));
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
});

test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    putBack(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

const save = (page: Page) => page.locator('#stringTab input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)');
const savedConfig = async (request: APIRequestContext) => (await request.get('/api/channel/output/co-bbbStrings')).json();

// Smart v2 is saved as differentialType 4 for one receiver, 5 for two, 6 for
// three (3 + the count), and drawn back as type 2 with that many receivers.
for (const count of [1, 2, 3]) {
  test(`${count} smart v2 receiver${count > 1 ? 's' : ''} on a port are saved as differentialType ${3 + count} and drawn back`, async ({ page, request }) => {
    // Regression: b5a632c81.  Initial support for v2 receivers: the page's
    // Smart v2 type and receiver count become the one differentialType number
    // fppd reads (v2 starting at 4), and that number is read back into the
    // same type and count.
    writeFile(CONFIG, JSON.stringify(stringsConfig(0)));
    await openStrings(page);
    await page.locator('#DifferentialType0').selectOption('2');
    await page.locator('#DifferentialCount0').selectOption(String(count));
    await save(page).click();
    await expect.poll(async () => (await savedConfig(request)).channelOutputs[0].outputs[0].differentialType,
      { timeout: 15_000 }).toBe(3 + count);

    await openStrings(page);
    await expect(page.locator('#DifferentialType0'), 'the receiver type').toHaveValue('2');
    await expect(page.locator('#DifferentialCount0'), 'the number of receivers').toHaveValue(String(count));
    await expect(page.locator('#PixelString tr[id^="ROW_RULER_DIFFERENTIAL_0_"]')).toHaveCount(count - 1);
  });
}
