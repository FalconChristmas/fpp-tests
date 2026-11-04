import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { MEDIA, keepingFile, writeFile } from './privacy-helpers';

// What the usage statistics say about a player's panel and pixel outputs,
// read from the channel output configs.  The payload is regenerated with
// ?force=1 (a cached copy can be two hours old).

test.skip(!container, 'writes the output configs in the run-web.sh container');

async function usage(request: APIRequestContext) {
  const r = await request.get('/api/statistics/usage?force=1');
  const text = await r.text();
  expect(r.ok(), text).toBe(true);
  return JSON.parse(text);
}

test('the panel section counts the panels configured', async ({ request }) => {
  // Regression: 7431ea017 ("Include Panel Count in stats").  The size of one
  // panel was reported but not how many there were.
  const file = `${MEDIA}/config/channeloutputs.json`;
  await keepingFile(file, async () => {
    const panels = [0, 1, 2, 3].map((col) => ({
      outputNumber: 0, panelNumber: col, colOrder: 'RGB', orientation: 'N', row: 0, col,
    }));
    writeFile(file, JSON.stringify({ channelOutputs: [{
      type: 'LEDPanelMatrix', subType: 'RGBMatrix', enabled: 1, panelWidth: 32, panelHeight: 16, panelScan: 8, channelCount: 6144, panels,
    }] }));
    const { output_panel: panel } = await usage(request);
    expect(panel.panelCount).toBe(4);
    expect(panel.panelWidth).toBe(32);
  });
});

test('the pixel section lists the protocols in use, with their port counts', async ({ request }) => {
  // Regression: 217b40ca1 ("Fix Undefined variable: protocols").  The variable
  // was collected under one spelling and reported under another: a PHP notice,
  // and no protocols in the stats.
  const file = `${MEDIA}/config/co-pixelStrings.json`;
  await keepingFile(file, async () => {
    const port = (portNumber: number, protocol: string) => ({
      portNumber, protocol, virtualStrings: [{ description: '', startChannel: 0, pixelCount: 50 }],
    });
    writeFile(file, JSON.stringify({ channelOutputs: [{
      type: 'RPIWS281X', subType: 'fpp-tests', enabled: 1, outputCount: 3,
      outputs: [port(0, 'ws2811'), port(1, 'ws2811'), port(2, 'apa102')],
    }] }));
    const { output_pixel_pi: pixels } = await usage(request);
    expect(pixels.protocols).toEqual({ ws2811: 2, apa102: 1 });
    expect(pixels.pixelCount).toBe(150);
  });
});
