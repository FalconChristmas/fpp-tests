import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Other outputs drawn by an output module: GPIO, GPIO-595 (a shift
// register on three pins), MQTT, the PCF8574 I2C expander and the 3D virtual
// display.  Save rebuilds co-other.json from the page, so a field a module
// draws wrongly, or reads back wrongly, is a field the next Save changes
// without anyone having touched it: the file is the receiving end.
// (other-outputs-legacy-types.spec.ts: the types co-other.php draws itself.)
//
// The outputs are saved disabled, so fppd reloads the file and drives nothing.
// The player's pins are fppd's stand-ins (TF-1, TF-2, ...).

test.skip(!container, "changes the player's output config and adds a device node");

const I2C = 'i2c-7';

type Output = Record<string, any> & { type: string };

async function stored(request: APIRequestContext): Promise<Record<string, Output>> {
  const outputs: Output[] = JSON.parse(await (await request.get('/api/channel/output/co-other')).text()).channelOutputs;
  return Object.fromEntries(outputs.map((o) => [o.type, o]));
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  inPlayer('touch', `/dev/${I2C}`);
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
  inPlayer('rm', '-f', `/dev/${I2C}`);
});

async function open(page: Page, request: APIRequestContext, outputs: Output[]) {
  const w = await request.post('/api/channel/output/co-other', { data: { channelOutputs: outputs } });
  expect(w.ok(), await w.text()).toBe(true);
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await expect(page.locator('table[id^="tblOther-"] > tbody > tr')).toHaveCount(outputs.length, { timeout: 15_000 });
}
const tab = (page: Page, category: string) => page.locator(`#tab-other-${category}-tab`);
const rows = (page: Page, category: string) => page.locator(`#tblOther-${category} > tbody > tr`);
const row = (page: Page, category: string, type: string) =>
  rows(page, category).filter({ has: page.locator(`input.type[value="${type}"]`) });

async function save(page: Page, category: string) {
  const posted = page.waitForResponse((r) => r.url().includes('/api/channel/output/co-other') && r.request().method() === 'POST');
  // The pinned table header keeps a hidden copy of the buttons.
  await page.locator(`#tab-other-${category} input[value="Save"]:not(.Zebra_Pin_Clone *)`).click();
  expect((await posted).ok()).toBe(true);
}
async function addRow(page: Page, category: string, type: string) {
  await page.locator(`#tab-other-${category} button:has-text("Add"):not(.Zebra_Pin_Clone *)`).click();
  await page.locator(`#outputType-${category}`).selectOption(type);
  return rows(page, category).last();
}

const GPIO = { type: 'GPIO', enabled: 0, startChannel: 10, channelCount: 1, pin: 'TF-3', invert: 1, pwm: 0, description: 'snow machine' };
const SHIFT = { type: 'GPIO-595', enabled: 0, startChannel: 20, channelCount: 16, clockPin: 'TF-1', dataPin: 'TF-2', latchPin: 'TF-3', description: 'relays' };
const MQTT = { type: 'MQTTOutput', enabled: 0, startChannel: 40, channelCount: 4, topic: 'house/porch/set', payload: '%R%,%G%,%B%,%W%', channelType: 'RGBW' };
const DISPLAY3D = { type: 'HTTPVirtualDisplay3D', enabled: 0, startChannel: 1, channelCount: 300, port: 32329, updateInterval: 40 };

test.describe('a GPIO output', () => {
  test('is shown on its pin and saved back as it was', async ({ page, request }) => {
    await open(page, request, [GPIO]);
    await tab(page, 'GPIO').click();
    const r = row(page, 'GPIO', 'GPIO');
    await expect(r.locator('select.gpio')).toHaveValue('TF-3');
    await expect(r.locator('input.inverted')).toBeChecked();
    await expect(r.locator('input.description')).toHaveValue('snow machine');
    // One pin, one channel.
    await expect(r.locator('input.count')).toHaveValue('1');
    await expect(r.locator('input.count')).toBeDisabled();
    // The stand-in pins cannot do PWM, so it is not offered.
    await expect(r.locator('span.pwm-span')).toBeHidden();
    await save(page, 'GPIO');
    expect((await stored(request))['GPIO']).toEqual(GPIO);
  });

  test('moved to another pin and un-inverted is saved so', async ({ page, request }) => {
    await open(page, request, [GPIO]);
    await tab(page, 'GPIO').click();
    const r = row(page, 'GPIO', 'GPIO');
    await r.locator('select.gpio').selectOption('TF-5');
    await r.locator('input.inverted').uncheck();
    await r.locator('input.start').fill('77');
    await r.locator('input.act').check();
    await save(page, 'GPIO');
    expect((await stored(request))['GPIO']).toEqual({ ...GPIO, pin: 'TF-5', invert: 0, startChannel: 77, enabled: 1 });
  });

  test('saved the old way, by GPIO number with softPWM, is shown on that pin and saved by name', async ({ page, request }) => {
    const { pin, pwm, ...rest } = GPIO;
    await open(page, request, [{ ...rest, gpio: 2, softPWM: 1 }]);
    await tab(page, 'GPIO').click();
    await expect(row(page, 'GPIO', 'GPIO').locator('select.gpio')).toHaveValue('TF-2');
    await save(page, 'GPIO');
    const now = (await stored(request))['GPIO'];
    expect(now).toMatchObject({ pin: 'TF-2', pwm: 1, invert: 1, description: 'snow machine' });
    // One way of naming the pin, not two that can disagree.
    expect(now).not.toHaveProperty('gpio');
    expect(now).not.toHaveProperty('softPWM');
  });

  test('added new takes one channel on the first pin, not inverted', async ({ page, request }) => {
    await open(page, request, [GPIO]);
    await tab(page, 'GPIO').click();
    const fresh = await addRow(page, 'GPIO', 'GPIO');
    await expect(fresh.locator('input.count')).toHaveValue('1');
    await expect(fresh.locator('input.count')).toBeDisabled();
    await expect(fresh.locator('select.gpio')).toHaveValue('TF-1');
    await expect(fresh.locator('input.inverted')).not.toBeChecked();
  });
});

test.describe('a GPIO-595 output', () => {
  test('is shown on its clock, data and latch pins (the control)', async ({ page, request }) => {
    await open(page, request, [SHIFT]);
    await tab(page, 'GPIO').click();
    const r = row(page, 'GPIO', 'GPIO-595');
    await expect(r.locator('select.clock')).toHaveValue('TF-1');
    await expect(r.locator('select.data')).toHaveValue('TF-2');
    await expect(r.locator('select.latch')).toHaveValue('TF-3');
    await expect(r.locator('input.description')).toHaveValue('relays');
    await expect(r.locator('input.count')).toHaveValue('16');
  });

  test('keeps its pins through a save', async ({ page, request }) => {
    await open(page, request, [SHIFT]);
    await tab(page, 'GPIO').click();
    await expect(row(page, 'GPIO', 'GPIO-595').locator('select.latch')).toHaveValue('TF-3');
    await save(page, 'GPIO');
    const now = (await stored(request))['GPIO-595'];
    // The rest of the row does survive.
    expect(now).toMatchObject({ description: 'relays', startChannel: 20, channelCount: 16 });
    expect({ clockPin: now.clockPin, dataPin: now.dataPin, latchPin: now.latchPin }).toEqual({ clockPin: 'TF-1', dataPin: 'TF-2', latchPin: 'TF-3' });
  });
});

test.describe('an MQTT output', () => {
  test('is shown with its topic, payload and channel type and saved back as it was', async ({ page, request }) => {
    await open(page, request, [MQTT]);
    await tab(page, 'ControlSignal').click();
    const r = row(page, 'ControlSignal', 'MQTTOutput');
    await expect(r.locator('input.topic')).toHaveValue('house/porch/set');
    await expect(r.locator('input.payload')).toHaveValue('%R%,%G%,%B%,%W%');
    await expect(r.locator('select.channelType')).toHaveValue('RGBW');
    await expect(r.locator('input.count')).toHaveValue('4');
    await expect(r.locator('input.count')).toBeDisabled();
    await save(page, 'ControlSignal');
    expect((await stored(request))['MQTTOutput']).toEqual(MQTT);
  });

  for (const [channelType, count] of [['Single', 1], ['RGB', 3]] as const) {
    test(`changed to ${channelType} takes ${count} channel${count > 1 ? 's' : ''}, on the page and in the file`, async ({ page, request }) => {
      await open(page, request, [MQTT]);
      await tab(page, 'ControlSignal').click();
      const r = row(page, 'ControlSignal', 'MQTTOutput');
      await r.locator('select.channelType').selectOption(channelType);
      await expect(r.locator('input.count')).toHaveValue(String(count));
      await r.locator('input.topic').fill('house/tree/set');
      await save(page, 'ControlSignal');
      expect((await stored(request))['MQTTOutput']).toEqual({ ...MQTT, channelType, channelCount: count, topic: 'house/tree/set' });
    });
  }

  test('added new starts as RGB with a payload of the three colours', async ({ page, request }) => {
    await open(page, request, [MQTT]);
    await tab(page, 'ControlSignal').click();
    const fresh = await addRow(page, 'ControlSignal', 'MQTTOutput');
    await expect(fresh.locator('input.topic')).toHaveValue('');
    await expect(fresh.locator('input.payload')).toHaveValue('%R%,%G%,%B%');
    await expect(fresh.locator('select.channelType')).toHaveValue('RGB');
    await expect(fresh.locator('input.count')).toHaveValue('3');
    await expect(fresh.locator('input.count')).toBeDisabled();
  });

  test('with a JSON payload in double quotes is shown whole (the control)', async ({ page, request }) => {
    const payload = '{"r":%R%,"g":%G%,"b":%B%,"w":%W%}';
    await open(page, request, [{ ...MQTT, payload }]);
    await tab(page, 'ControlSignal').click();
    await expect(row(page, 'ControlSignal', 'MQTTOutput').locator('input.payload')).toHaveValue(payload);
    await save(page, 'ControlSignal');
    expect((await stored(request))['MQTTOutput'].payload).toBe(payload);
  });

  test('with an apostrophe in its topic or payload keeps both through a save', async ({ page, request }) => {
    const odd = { ...MQTT, topic: "dad's/tree/set", payload: "{'rgb':'%R%,%G%,%B%'}" };
    await open(page, request, [odd]);
    await tab(page, 'ControlSignal').click();
    await save(page, 'ControlSignal');
    const now = (await stored(request))['MQTTOutput'];
    expect({ topic: now.topic, payload: now.payload }).toEqual({ topic: odd.topic, payload: odd.payload });
  });
});

test.describe('a PCF8574 expander', () => {
  const port = (n: number, extra: object = {}) => ({ invert: 0, pinMode: 0, threshold: 128, hysteresisUpper: 192, hysteresisLower: 64, description: `relay ${n}`, ...extra });
  const expander = (ports: object[]) => ({
    type: 'PCF8574', enabled: 0, startChannel: 100, channelCount: 8, device: I2C, deviceID: 0x23, pinOrderingInvert: 1, relayNumbering: 1, ports,
  });
  const PORTS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => port(n));

  test('is shown with its bus, address and every port, and saved back as it was', async ({ page, request }) => {
    const ports = [...PORTS];
    ports[2] = port(2, { invert: 1, pinMode: 1, threshold: 200 });
    ports[5] = port(5, { pinMode: 2, hysteresisUpper: 220 });
    await open(page, request, [expander(ports)]);
    await tab(page, 'GPIO').click();
    const r = row(page, 'GPIO', 'PCF8574');
    await expect(r.locator('select.device')).toHaveValue(I2C);
    await expect(r.locator('select.addr')).toHaveValue(String(0x23));
    await expect(r.locator('input.pinOrderingInvert')).toBeChecked();
    await expect(r.locator('input.relayNumbering')).toBeChecked();
    // Relay numbering counts the ports from 1.
    await expect(r).toContainText('Port 1:');
    await expect(r).toContainText('Port 8:');
    await expect(r).not.toContainText('Port 0:');
    await expect(r.locator('input.pinInvert2')).toBeChecked();
    await expect(r.locator('select.pinMode2')).toHaveValue('1');
    await expect(r.locator('input.threshold2')).toHaveValue('200');
    await expect(r.locator('select.pinMode5')).toHaveValue('2');
    await expect(r.locator('input.hysteresisUpper5')).toHaveValue('220');
    await save(page, 'GPIO');
    expect((await stored(request))['PCF8574']).toEqual(expander(ports));
  });

  test('raises a hysteresis "on" level that is below its "off" level to just above it', async ({ page, request }) => {
    await open(page, request, [expander(PORTS)]);
    await tab(page, 'GPIO').click();
    const r = row(page, 'GPIO', 'PCF8574');
    await r.locator('input.hysteresisUpper4').fill('50');
    await save(page, 'GPIO');
    const now = (await stored(request))['PCF8574'];
    expect(now.ports[4]).toMatchObject({ hysteresisLower: 64, hysteresisUpper: 65 });
    expect(now.ports[3]).toEqual(PORTS[3]);
  });

  test('keeps a hysteresis "off" level other than the default through a save', async ({ page, request }) => {
    const ports = [...PORTS];
    ports[1] = port(1, { pinMode: 2, hysteresisUpper: 200, hysteresisLower: 20 });
    await open(page, request, [expander(ports)]);
    await tab(page, 'GPIO').click();
    await expect(row(page, 'GPIO', 'PCF8574').locator('input.hysteresisUpper1')).toHaveValue('200');
    await save(page, 'GPIO');
    const now = (await stored(request))['PCF8574'];
    expect(now.ports[1].hysteresisUpper).toBe(200);
    expect(now.ports[1].hysteresisLower).toBe(20);
  });
});

test('a 3D virtual display shows its update interval, sizes itself, and is saved on its fixed port', async ({ page, request }) => {
  const { port, ...asSaved } = DISPLAY3D;
  await open(page, request, [asSaved]);
  await tab(page, 'VirtualDisplay').click();
  const r = row(page, 'VirtualDisplay', 'HTTPVirtualDisplay3D');
  await expect(r.locator('input.updateInterval')).toHaveValue('40');
  // The channel count comes from the display's map, so it is not offered.
  await expect(r.locator('input.count')).toBeHidden();
  await expect(r).toContainText('Auto');
  await expect(r.locator('input.start')).toBeDisabled();
  await r.locator('input.updateInterval').fill('');
  await save(page, 'VirtualDisplay');
  // No interval typed is the default one, and the port is always the same.
  expect((await stored(request))['HTTPVirtualDisplay3D']).toEqual({ ...DISPLAY3D, updateInterval: 25 });
});
