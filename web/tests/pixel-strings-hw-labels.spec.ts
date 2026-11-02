import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab of a cape with smart (differential) receivers whose
// ports are labelled from 5 (the cape's group says where its labels start),
// and Clone String across the divider between two receivers' rows (see
// pixel-strings-port-labels.spec.ts, whose harness this repeats).

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsSmartHw.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsSmartHw', longName: 'fpp-tests smart receiver cape', numSerial: 0,
  supportsSmartReceivers: true,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4, type: 'differential', portStart: 5 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsSmartHw', name: 'fpp-tests smart', version: '1.0', serialNumber: 'SN0001',
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
      type: 'BBB48String', subType: 'FppTestsSmartHw', pinoutVersion: '1.x', enabled: 1,
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
  writeFile(CONFIG, JSON.stringify(stringsConfig(1)));
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

// The label cell at the start of each port's first string row.
const labels = (page: Page) => page.locator('#PixelString tr[id^="BBB48String_Output_0_"][id$="_0"] td.vsPortLabel').allInnerTexts();


test('smart receiver letters go after the cape\'s own port labels when the type changes', async ({ page }) => {
  // Regression: fb1906757.  Changing a port to smart receivers redrew the
  // group's labels from the port's place in the table (1A, 2A...) instead of
  // the label the cape gives it, so a cape whose labels start at 5 lost them.
  writeFile(CONFIG, JSON.stringify(stringsConfig(0)));
  await openStrings(page);
  expect(await labels(page), 'the control: as drawn from the saved config').toEqual(['5)', '6)', '7)', '8)']);
  await page.locator('#DifferentialType0').selectOption('2');
  await expect.poll(() => labels(page)).toEqual(['5A)', '6A)', '7A)', '8A)']);
});

test('Clone String steps over the divider between two receivers\' rows', async ({ page }) => {
  // Regression: e9c087670.  Cloning checked every row below the selected one
  // for room before it knew the row was a string; the divider row between
  // two receivers' strings has none of a string's fields, and the check threw.
  writeFile(CONFIG, JSON.stringify(stringsConfig(2)));
  const errors: string[] = [];
  const alerts: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openStrings(page);
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => {
    if (d.type() === 'alert') alerts.push(d.message());
    d.accept(d.type() === 'prompt' ? '1' : undefined);
  });
  // The control: the two receivers are drawn, with a divider between them.
  await expect(page.locator('#PixelString tr[id^="ROW_RULER_DIFFERENTIAL_0_"]')).toHaveCount(1);
  const last = page.locator('#PixelString tr[id="BBB48String_Output_0_3_0"]');
  const next = page.locator('#PixelString tr[id="BBB48String_Output_1_0_0"]');
  await expect(next.locator('input.vsPixelCount')).toHaveValue('0');
  await last.locator('td.vsPortLabel').dispatchEvent('mousedown');
  await page.locator('#cloneStringButton').click();
  await expect(next.locator('input.vsPixelCount'), `the clone was made past the divider (alerts: ${alerts.join(' | ')})`).toHaveValue('10');
  expect(errors).toEqual([]);
});
