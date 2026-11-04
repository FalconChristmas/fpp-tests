import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// What the Pixel Strings tab saves for a number field left blank.  The tab
// is shown as on a Raspberry Pi with a two-port DPIPixels hat, as in
// pixel-strings-dpi.spec.ts: the hat put where cape detection unpacks it
// and the player claiming to be a Pi for the length of the test.  fppd reads
// the strings config only at start, so the running one is not affected.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsDPI.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-pixelStrings.json`;

const CAPE = {
  name: 'FppTestsDPI', longName: 'fpp-tests 2-port DPI hat', driver: 'DPIPixels', numSerial: 0,
  outputs: [{ pin: 'P1-7' }, { pin: 'P1-11' }],
  groups: [{ start: 1, count: 2 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsDPI', name: 'fpp-tests DPI', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};
const vstring = (startChannel: number) => ({
  description: 'fpp-tests', startChannel, pixelCount: 50, groupCount: 2, reverse: 0, colorOrder: 'RGB',
  nullNodes: 3, endNulls: 4, zigZag: 5, brightness: 100, gamma: '1.0',
});
const CONFIG_JSON = { channelOutputs: [{
  type: 'DPIPixels', subType: 'FppTestsDPI', pinoutVersion: '1.x', enabled: 1, startChannel: 1, channelCount: -1,
  outputCount: 2, outputs: [
    { portNumber: 0, protocol: 'ws2811', virtualStrings: [vstring(0)] },
    { portNumber: 1, protocol: 'ws2811', virtualStrings: [vstring(150)] }],
}] };

function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG]) saved[p] = read(p);
  write(PLATFORM, 'Raspberry Pi');
  write(CAPE_FILE, JSON.stringify(CAPE));
  write(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  write(CONFIG, JSON.stringify(CONFIG_JSON));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

test('a number field left blank on a pixel string is saved as its default, not null', async ({ page }) => {
  // Regression: 0dd69a45d ("If field is left blank, convert to a proper
  // default instead of \"null\"").  parseInt('') is NaN, which JSON writes
  // as null: a cleared Group Count, Null Nodes or Zig Zag went into the
  // config as null, which fppd does not read as a number.
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  const row = page.locator('#PixelString tr[id$="_Output_0_0_0"]');
  await expect(row.locator('.vsZigZag')).toHaveValue('5');
  for (const field of ['.vsGroupCount', '.vsStartNulls', '.vsEndNulls', '.vsZigZag']) {
    await row.locator(field).fill('');
  }
  const save = page.locator('#savePixelStringsButton');
  await expect(save).toBeEnabled();
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('co-pixelStrings'));
  await save.click();
  expect((await posted).ok()).toBe(true);
  const ports = JSON.parse(read(CONFIG)!).channelOutputs[0].outputs;
  expect(ports[0].virtualStrings[0]).toMatchObject({ pixelCount: 50, groupCount: 0, nullNodes: 0, endNulls: 0, zigZag: 0 });
  // The control: the other port, untouched, keeps its values.
  expect(ports[1].virtualStrings[0]).toMatchObject({ pixelCount: 50, groupCount: 2, nullNodes: 3, endNulls: 4, zigZag: 5 });
});
