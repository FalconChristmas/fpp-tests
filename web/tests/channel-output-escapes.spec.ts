import { test, expect } from './fixtures';

// The channel output and output processor saves ran stripslashes() over the
// posted body, but the body is JSON, so its backslashes are JSON escapes.  A
// quote or a backslash typed into a description left a file fppd could not
// load: every output in it went dark, and the page showed none.  Fixed in fpp
// 9271b8294 ("fix(api): stop stripslashes() corrupting channel output saves"),
// which writes the body as sent and refuses anything but a JSON object.

const DESCRIPTIONS = ['12" Mini Trees', 'String #0\\hello', 'back\\"slash'];

function processors(description: string) {
  return {
    status: 'OK',
    outputProcessors: [{ type: 'Remap', active: 0, description, source: 1, destination: 2, count: 1, loops: 1, reverse: 0 }],
  };
}

test.describe('output processor saves', () => {
  let before: string;
  test.beforeEach(async ({ request }) => {
    before = await (await request.get('/api/channel/output/processors')).text();
  });
  test.afterEach(async ({ request }) => {
    await request.post('/api/channel/output/processors', { data: Buffer.from(before) });
  });

  for (const description of DESCRIPTIONS) {
    test(`keep a description of ${JSON.stringify(description)}`, async ({ request }) => {
      const r = await request.post('/api/channel/output/processors', { data: processors(description) });
      expect(r.ok(), await r.text()).toBe(true);
      const text = await (await request.get('/api/channel/output/processors')).text();
      let saved: any;
      expect(() => { saved = JSON.parse(text); }, `the saved file is not JSON: ${text}`).not.toThrow();
      expect(saved.outputProcessors[0].description).toBe(description);
    });
  }

  test('refuse a body that is not a JSON object, and keep the file', async ({ request }) => {
    const r0 = await request.post('/api/channel/output/processors', { data: processors('fpp-tests kept') });
    expect(r0.ok()).toBe(true);
    for (const body of ['not json', '[1,2]']) {
      const r = await request.post('/api/channel/output/processors', {
        data: Buffer.from(body), headers: { 'Content-Type': 'application/json' },
      });
      expect(r.status(), body).toBe(400);
    }
    const saved = await (await request.get('/api/channel/output/processors')).json();
    expect(saved.outputProcessors[0].description).toBe('fpp-tests kept');
  });
});

test('a channel output file keeps a description with a quote and a backslash', async ({ request }) => {
  const before = await request.get('/api/channel/output/co-other');
  const description = 'Garage 12" \\ arch';
  try {
    const r = await request.post('/api/channel/output/co-other', {
      data: { channelOutputs: [{ type: 'GenericUDP', enabled: 0, description, startChannel: 1, channelCount: 3 }] },
    });
    expect(r.ok(), await r.text()).toBe(true);
    const text = await (await request.get('/api/channel/output/co-other')).text();
    let saved: any;
    expect(() => { saved = JSON.parse(text); }, `the saved file is not JSON: ${text}`).not.toThrow();
    expect(saved.channelOutputs[0].description).toBe(description);
  } finally {
    const text = await before.text();
    if (before.ok() && text.trim().startsWith('{') && !text.includes('"status":"ERROR')) {
      await request.post('/api/channel/output/co-other', { data: Buffer.from(text) });
    } else {
      await request.post('/api/channel/output/co-other', { data: { channelOutputs: [] } });
    }
  }
});
