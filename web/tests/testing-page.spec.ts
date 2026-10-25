import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

import { container, inPlayer } from './container';

// The Display Testing page (testing.php): the Channel Testing tab's RGB test
// patterns and the Channel Fader (DMX) tab.  Each starts a test in fppd with
// a Test Start command; fppd's /api/testmode, the test it is running, is the
// receiving end, and for the fader so is what fppd then puts on the wire: a
// DDP output carries channels 1-150 to a receiver in the player, which keeps
// the last frame it was sent.

const MODEL = 'fpp-tests-matrix';
const FRAME = '/tmp/fpp-tests-ddp-frame.json';
const PIDFILE = '/tmp/fpp-tests-ddp.pid';
// Keeps the channel data of the last DDP frame (the one with PUSH set) in FRAME.
const RECEIVER = `
import json, os, socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 4048))
buf = bytearray(150)
while True:
    p = s.recv(65536)
    if len(p) < 10:
        continue
    head = 14 if p[0] & 0x10 else 10
    off, n = struct.unpack(">IH", p[4:10])
    d = p[head:head + n][:max(0, 150 - off)]
    buf[off:off + len(d)] = d
    if p[0] & 0x01:
        with open("${FRAME}.tmp", "w") as f:
            json.dump(list(buf), f)
        os.rename("${FRAME}.tmp", "${FRAME}")
`;

// fppd's test mode; null until a test has run.
const testmode = async (request: APIRequestContext) => (await (await request.get('/api/testmode')).json()) ?? {};

// Channels 1..n of the last frame fppd sent.
async function channels(n: number): Promise<number[]> {
  const out = inPlayer('sh', '-c', `cat ${FRAME} 2>/dev/null || echo '[]'`);
  return (JSON.parse(out) as number[]).slice(0, n);
}

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
});

async function openTesting(page: Page) {
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
}

test('a colour picked for the custom cycle pattern is added to the pattern fppd runs', async ({ page, request }) => {
  // Feature: c931125c5.  The Custom Pattern of the RGB test patterns gets a
  // colour picker: Add Color appends the picked colour's hex triplet to the
  // pattern and restarts the test with it; Clear empties it.
  await openTesting(page);
  await page.locator('#testModeStartChannel').fill('1');
  await page.locator('#testModeEndChannel').fill('150');
  await page.locator('#RGBCycle-RGBCustom').check();
  await page.locator('#testModeEnabled').check();
  const add = page.locator('[onclick="AppendColorPickerToCustom();"]');
  await page.locator('[onclick="ClearCustomPattern();"]').click();
  await page.locator('#customPatternColorPicker').fill('#12ab34');
  await add.click();
  await expect(page.locator('#testModeRGBCycleCustomPattern')).toHaveValue('12AB34');
  await page.locator('#customPatternColorPicker').fill('#00ff00');
  await add.click();
  await expect(page.locator('#testModeRGBCycleCustomPattern')).toHaveValue('12AB3400FF00');
  await expect.poll(async () => {
    const t = await testmode(request);
    return t.enabled ? `${t.subMode} ${t.colorPattern}` : 'off';
  }, { timeout: 10_000 }).toBe('RGBCycle-RGBCustom 12AB3400FF00');
});

test.describe('the Channel Fader', () => {
  test.skip(!container, 'runs a DDP receiver inside the run-web.sh container');
  let savedOutputs: string | null = null;
  let savedBridges = '0';

  test.beforeEach(async ({ request }) => {
    const r = await request.get('/api/channel/output/universeOutputs');
    savedOutputs = r.ok() ? await r.text() : null;
    savedBridges = (await (await request.get('/api/settings/DisableFakeNetworkBridges')).json()).value ?? '0';
    // fppd's own DDP listener would hold the port, and it skips an output to
    // 127.0.0.1 while it listens there.
    await request.put('/api/settings/DisableFakeNetworkBridges', { data: '1' });
    inPlayer('sh', '-c', 'rm -f "$2"; printf "%s" "$1" > /tmp/fpp-tests-ddp.py', 'sh', RECEIVER, FRAME);
    inPlayer('sh', '-c', `setsid nohup python3 /tmp/fpp-tests-ddp.py > /dev/null 2>&1 & echo $! > ${PIDFILE}`);
    const w = await request.post('/api/channel/output/universeOutputs', { data: { channelOutputs: [{
      type: 'universes', enabled: 1, startChannel: 1, channelCount: 150, universes: [{
        active: 1, description: 'fpp-tests', id: 64001, startChannel: 1, channelCount: 150, type: 5,
        address: '127.0.0.1', priority: 0, monitor: 0, deDuplicate: 0 }] }] } });
    expect(w.ok(), await w.text()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    inPlayer('sh', '-c', `kill $(cat ${PIDFILE}) 2>/dev/null; rm -f ${PIDFILE} ${FRAME} /tmp/fpp-tests-ddp.py`);
    await request.post('/api/channel/output/universeOutputs', {
      data: Buffer.from(savedOutputs && !savedOutputs.includes('File not found') ? savedOutputs : '{"channelOutputs": []}'),
    });
    if (!savedOutputs || savedOutputs.includes('File not found')) {
      inPlayer('rm', '-f', '/home/fpp/media/config/co-universes.json');
    }
    await request.put('/api/settings/DisableFakeNetworkBridges', { data: savedBridges });
  });

  async function openFader(page: Page, start: number, count: number) {
    await openTesting(page);
    await page.locator('#tab-dmx-tab').click();
    await page.locator('#dmxStartChannel').fill(String(start));
    await page.locator('#dmxStartChannel').dispatchEvent('change');
    await page.locator('#dmxChannelCount').fill(String(count));
    await page.locator('#dmxChannelCount').dispatchEvent('change');
    await expect(page.locator('.dmxSlider')).toHaveCount(count);
  }

  const slider = (page: Page, idx: number) => page.locator(`.dmxSlider[data-idx="${idx}"]`);

  test('sets the channels fppd puts out, Set All sets every one, and leaving the page stops it', async ({ page, request }) => {
    // Feature: 0aeee002e.  A slider per channel; moving one runs a Test Start
    // over the fader's channels with the slider values as the pattern.
    await openFader(page, 1, 6);
    await page.locator('#dmxTestEnabled').check();
    await slider(page, 2).fill('200');
    await slider(page, 2).dispatchEvent('change');
    await expect.poll(async () => {
      const t = await testmode(request);
      return t.enabled ? `${t.channelSet} ${t.colorPattern}` : 'off';
    }, { timeout: 10_000 }).toBe('1-6 0000C8000000');
    await expect.poll(() => channels(6), { timeout: 10_000 }).toEqual([0, 0, 200, 0, 0, 0]);

    await page.locator('#tab-dmx [onclick="DMXSetAll(255);"]').click();
    await expect(slider(page, 0)).toHaveValue('255');
    await expect.poll(() => channels(6), { timeout: 10_000 }).toEqual([255, 255, 255, 255, 255, 255]);

    await page.goto('/index.php');
    await expect.poll(async () => !!(await testmode(request)).enabled, { timeout: 10_000 }).toBe(false);
  });

  test('its sine wave moves the channels until it is stopped', async ({ page, request }) => {
    // Feature: 9545b1608.  Start Sine turns test mode on and drives the
    // fader's channels along a sine wave, about 20 updates a second; Stop Sine
    // leaves them where they are.
    await openFader(page, 1, 3);
    await page.locator('#dmxSineSpeed').fill('2');
    await page.locator('#dmxSineStartBtn').click();
    await expect(page.locator('#dmxTestEnabled')).toBeChecked();
    const seen = new Set<string>();
    await expect.poll(async () => {
      seen.add((await channels(3)).join(','));
      return seen.size;
    }, { timeout: 10_000, intervals: [100] }).toBeGreaterThan(4);

    await page.locator('#dmxSineStopBtn').click();
    await expect(page.locator('#dmxSineStopBtn')).toBeDisabled();
    // Once the last update has landed, the channels hold still.
    await page.waitForTimeout(500);
    const held = await channels(3);
    await page.waitForTimeout(1000);
    expect(await channels(3), 'the channels after Stop Sine').toEqual(held);
    expect((await testmode(request)).enabled, 'test mode stays on, at the last values').toBeTruthy();
  });

  test('picks a fixture model and marks the channels of each fixture', async ({ page, request }) => {
    // Feature: b7470997d.  The fader's Model list offers the fixture-sized
    // models (512 channels or fewer) and sets the fader to the one picked; the
    // channels of a model are marked with its name and their channel within it.
    await openFader(page, 145, 10);
    const boxes = page.locator('.dmxChannelBox');
    await expect(boxes).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(boxes.nth(i), `channel ${145 + i}`)
        .toHaveClass(i < 6 ? /\bdmxChannelBoxFixture\b/ : /^(?!.*dmxChannelBoxFixture)/);
    }
    await expect(boxes.nth(0).locator('.dmxFixtureName')).toHaveText(MODEL);
    await expect(boxes.nth(5).locator('.dmxRelChannel')).toHaveText('Ch 150 / 150');

    const model = page.locator('#dmxModelName');
    await expect(model.locator('option', { hasText: `${MODEL} (Ch 1, 150ch)` })).toHaveCount(1);
    await model.selectOption({ label: `${MODEL} (Ch 1, 150ch)` });
    await expect(page.locator('#dmxStartChannel')).toHaveValue('1');
    await expect(page.locator('#dmxChannelCount')).toHaveValue('150');
    await expect(page.locator('.dmxSlider')).toHaveCount(150);
    // And the test runs over the model's channels.
    await page.locator('#dmxTestEnabled').check();
    await expect.poll(async () => (await testmode(request)).channelSet, { timeout: 10_000 }).toBe('1-150');
  });
});
