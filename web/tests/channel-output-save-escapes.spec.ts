import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// Regression: 9271b8294 ("stop stripslashes() corrupting channel output
// saves"). The channel output and output processor saves ran stripslashes()
// over the posted JSON, whose backslashes are JSON escapes: a quote or a
// backslash typed into a description left a file fppd could not load (every
// output in it went dark, and the page then showed none). A body that is not a
// JSON object is now refused with a 400 instead of replacing the file.

const DESCRIPTION = '12" Mini Trees and String #0\\hello';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function roundTrip(request: APIRequestContext, route: string, file: string, body: object, read: (got: any) => string) {
  const had = exists(file);
  const before = had ? readFile(file) : '';
  try {
    const r = await request.post(route, { data: body });
    expect(r.ok(), await r.text()).toBe(true);
    const got = await request.get(route);
    const text = await got.text();
    expect(() => JSON.parse(text), `${route} saved a file that is not JSON: ${text.slice(0, 300)}`).not.toThrow();
    expect(read(JSON.parse(text))).toBe(DESCRIPTION);

    // Not a JSON object: refused, and the file is left as it was.
    for (const bad of ['[1, 2]', '{"outputs": ', 'not json']) {
      const refused = await request.post(route, { headers: { 'Content-Type': 'application/json' }, data: Buffer.from(bad) });
      expect(refused.status(), bad).toBe(400);
      expect(await (await request.get(route)).text(), `${bad} replaced the file`).toBe(text);
    }
  } finally {
    if (had) putFile(file, before); else inPlayer('rm', '-f', file);
  }
}

test('an output processor description with a quote and a backslash is saved intact', async ({ request }) => {
  await roundTrip(request, '/api/channel/output/processors', `${MEDIA}/config/outputprocessors.json`, {
    outputProcessors: [{ type: 'Remap', active: 0, description: DESCRIPTION, source: 1, destination: 2, count: 1, loops: 1, reverse: 0 }],
  }, (got) => got.outputProcessors[0].description);
});

test('a channel output description with a quote and a backslash is saved intact', async ({ request }) => {
  await roundTrip(request, '/api/channel/output/co-other', `${MEDIA}/config/co-other.json`, {
    channelOutputs: [{ type: 'GenericUDP', enabled: 0, startChannel: 1, channelCount: 3, description: DESCRIPTION,
      address: '192.0.2.1', port: 9999, tokens: '' }],
  }, (got) => got.channelOutputs[0].description);
});
