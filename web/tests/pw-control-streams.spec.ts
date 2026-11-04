import { test, expect } from './fixtures';

// GET /api/pipewire/control/streams: the five media stream slots.  With nothing
// playing and no PipeWire graph, each is idle with no media.

test('idle, it lists the five slots with their node names', async ({ request }) => {
  const body = await (await request.get('/api/pipewire/control/streams')).json();
  expect(body.status).toBe('OK');
  expect(body.streams).toEqual([1, 2, 3, 4, 5].map((slot) => ({
    slot, nodeName: `fppd_stream_${slot}`, status: 'idle', mediaFilename: '',
  })));
});
