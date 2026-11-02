import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab on a cape with smart (differential) receivers (see
// pixel-strings-more.spec.ts, whose harness this repeats): how a saved string
// config is drawn back, as the receiver type and the number of receivers.

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

// Saved as differentialType 2 or 3, a Smart v1 receiver chain of that many
// receivers (4 and up are v2's, 10 and up the Falcon's).
for (const count of [2, 3]) {
  test(`an old config of ${count} smart v1 receivers is drawn as Smart v1 with ${count} receivers`, async ({ page }) => {
    // Regression: 1a0d845d1.  The receiver count was taken after the type had
    // been rewritten to 1, so a chain of 2 or 3 old-style receivers showed as
    // one.
    writeFile(CONFIG, JSON.stringify(stringsConfig(count)));
    await openStrings(page);
    await expect(page.locator('#DifferentialType0'), 'the receiver type').toHaveValue('1');
    await expect(page.locator('#DifferentialCount0'), 'the number of receivers').toHaveValue(String(count));
    // And the table has the rows of each receiver in the chain.
    await expect(page.locator('#PixelString tr[id^="ROW_RULER_DIFFERENTIAL_0_"]')).toHaveCount(count - 1);
  });
}
