import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The LOR Enhanced output on the DMX / Serial tab of Channel Outputs.  Its
// serial port is a pty in the player, linked as /dev/ttyUSB9 so the page
// offers it; a reader on the other side decodes the LOR Enhanced packets fppd
// writes (scenarios/serial.py, as the serial scenarios do) and keeps, for each
// LOR unit, how many of its channels some packet has written.

test.skip(!container, 'runs a pty reader inside the run-web.sh container');

const DEVICE = '/dev/ttyUSB9';
const STATE = '/tmp/fpp-tests-lor-state.json';
const PIDFILE = '/tmp/fpp-tests-lor.pid';
const READER = `
import json, os, sys, time
sys.path.insert(0, "/tests/scenarios")
from serial import PtyReader, lor_enhanced_state
r = PtyReader()
if os.path.lexists("${DEVICE}"):
    os.unlink("${DEVICE}")
os.symlink("/dev/" + r.device, "${DEVICE}")
while True:
    time.sleep(0.2)
    state = lor_enhanced_state(r.messages())
    with open("${STATE}.tmp", "w") as f:
        json.dump({str(u): len(ch) for u, ch in state.items()}, f)
    os.rename("${STATE}.tmp", "${STATE}")
`;

async function stored(request: APIRequestContext) {
  return (await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[];
}

function unitChannels(): Record<string, number> {
  return JSON.parse(inPlayer('sh', '-c', `cat ${STATE} 2>/dev/null || echo '{}'`));
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  await request.post('/api/channel/output/co-other', { data: { channelOutputs: [] } });
  inPlayer('sh', '-c', 'printf "%s" "$1" > /tmp/fpp-tests-lor.py', 'sh', READER);
  inPlayer('sh', '-c', `rm -f ${STATE}; setsid nohup python3 /tmp/fpp-tests-lor.py > /tmp/fpp-tests-lor.log 2>&1 & echo $! > ${PIDFILE}`);
  await expect.poll(() => inPlayer('sh', '-c', `test -L ${DEVICE} && echo y || echo n`).trim()).toBe('y');
});

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
  inPlayer('sh', '-c', `kill $(cat ${PIDFILE}) 2>/dev/null; rm -f ${PIDFILE} ${STATE} ${DEVICE} /tmp/fpp-tests-lor.py /tmp/fpp-tests-lor.log`);
});

async function addLOREnhanced(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('[data-bs-toggle="dropdown"]').filter({ hasText: 'Add Output Group' }).click();
  await page.locator('#addOutputCategoryMenu a.dropdown-item', { hasText: 'DMX / Serial' }).click();
  await page.locator('#tab-other-DMXSerial-tab').click();
  await page.locator('#tab-other-DMXSerial button', { hasText: 'Add' }).click();
  await page.locator('#outputType-DMXSerial').selectOption('LOREnhanced');
  return page.locator('#tblOther-DMXSerial > tbody > tr').first();
}

test('the channel count follows the units, and fppd drives every unit of the saved output', async ({ page, request }) => {
  // Regression: f1ab42043.  The count was typed apart from the units, so
  // editing, adding or removing a unit left it wrong -- too small and fppd
  // drops the units past it -- and a new output started with no units and
  // every channel FPP has.  Now it is derived (through the last pixel of the
  // unit that reaches furthest) and not editable, and a new output starts
  // with one full unit.
  const row = await addLOREnhanced(page);
  const count = row.locator('td input.count');
  const units = row.locator('span.unitConfig');
  await expect(units).toHaveCount(1);
  await expect(units.first().locator('input.unitId')).toHaveValue('1');
  await expect(units.first().locator('input.numOfPixels')).toHaveValue('170');
  await expect(count).toHaveValue('510');
  await expect(count).toBeDisabled();

  // A second unit goes after the first, and the count with it.
  await row.locator('input[value="Add Unit"]').click();
  await expect(units).toHaveCount(2);
  await expect(units.nth(1).locator('input.fppStartAddr')).toHaveValue('511');
  await expect(count).toHaveValue('1020');
  // Fewer pixels on it.
  await units.nth(1).locator('input.numOfPixels').fill('50');
  await expect(count).toHaveValue('660');
  // A third, then taken away again.
  await row.locator('input[value="Add Unit"]').click();
  await expect(count).toHaveValue('1170');
  await units.nth(2).locator('input[value="Remove"]').click();
  await expect(count).toHaveValue('660');
  // Moving the second unit's start moves the end.
  await units.nth(1).locator('input.fppStartAddr').fill('601');
  await expect(count).toHaveValue('750');

  await row.locator('input.act').check();
  await row.locator('select.device').selectOption('ttyUSB9');
  await page.locator('#tab-other-DMXSerial input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => (await stored(request)).length, { timeout: 15_000 }).toBe(1);
  const out = (await stored(request))[0];
  expect(out).toMatchObject({ type: 'LOREnhanced', enabled: 1, startChannel: 1, channelCount: 750, device: 'ttyUSB9' });
  expect(out.units.map((u: any) => [u.unitId, u.numOfPixels, u.fppStartAddr])).toEqual([[1, 170, 1], [2, 50, 601]]);

  // fppd reloads the file and drives both units, the second all the way to
  // its last pixel.
  const t = await request.post('/api/command', { data: { command: 'Test Start', args: ['100', 'RGB Cycle', '1-750', 'R-G-B'] } });
  expect(t.ok()).toBe(true);
  await expect.poll(unitChannels, { timeout: 20_000 }).toEqual({ '1': 510, '2': 150 });

  // The page reads the count back from the units.
  await page.reload();
  await page.locator('#tab-other-DMXSerial-tab').click();
  await expect(page.locator('#tblOther-DMXSerial > tbody > tr').first().locator('td input.count')).toHaveValue('750');
});

test('the speed hints say they are for 40fps', async ({ page }) => {
  // Feature: e4760728b.  The pixel counts next to each speed assume every
  // pixel changes every frame at 40fps; the labels say so.
  const row = await addLOREnhanced(page);
  const labels = await row.locator('select.speed option').allInnerTexts();
  expect(labels).toEqual([
    '19.2k, 15 pixels all changing (40fps)',
    '57.6k, 45 pixels all changing (40fps)',
    '115.2k, 90 pixels all changing (40fps)',
    '500k, 400 pixels all changing (40fps)',
    '1 Mbps, 800 pixels all changing (40fps)',
  ]);
  await expect(row.locator('select.speed')).toHaveValue('1000000');
});
