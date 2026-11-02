import { test, expect } from './fixtures';
import { container } from './container';

// The PipeWire graph page (pipewire-graph.php) draws two labelled regions
// behind the nodes.  The graph it reads (/api/pipewire/graph) is answered
// here, so no PipeWire is needed.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const node = (id: number, name: string, mediaClass: string) => ({ id, name, description: name, mediaClass });

test('the graph is drawn over a Video Routing box and an Audio Routing box that span every node', async ({ page }) => {
  // Regression: 53f9c0206.  The graph had no region boxes, so nothing showed
  // which columns are the video path and which the audio path.
  await page.route((u) => u.pathname === '/api/pipewire/graph', (route) => route.fulfill({
    json: {
      nodes: [
        node(1, 'fpp_video_group_1', 'Video/Sink'),
        node(2, 'fppd_video_stream_1', 'Stream/Output/Video'),
        node(3, 'fpp_input_1', 'Audio/Sink'),
        node(4, 'fpp_group_1', 'Audio/Sink'),
        node(5, 'fpp_group_2', 'Audio/Sink'),
        node(6, 'fpp_group_3', 'Audio/Sink'),
      ],
      ports: [],
      links: [],
    },
  }));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/pipewire-graph.php');
  await expect(page.locator('g.pw-node')).toHaveCount(6, { timeout: 20_000 });
  const layer = page.locator('g.pw-background-layer');
  await expect(layer.locator('text')).toHaveText(['VIDEO ROUTING', 'AUDIO ROUTING']);
  const geo = await page.evaluate(() => {
    const num = (e: Element, a: string) => Number(e.getAttribute(a));
    const rects = [...document.querySelectorAll('g.pw-background-layer rect')].map((r) => ({
      x: num(r, 'x'), y: num(r, 'y'), w: num(r, 'width'), h: num(r, 'height') }));
    const nodes = [...document.querySelectorAll('g.pw-node')].map((g) => {
      const m = (g.getAttribute('transform') ?? '').match(/translate\(([-\d.e]+),\s*([-\d.e]+)\)/)!;
      const r = g.querySelector('rect')!;
      return { x: Number(m[1]), y: Number(m[2]), w: num(r, 'width'), h: num(r, 'height') };
    });
    return { rects, nodes };
  });
  expect(geo.rects).toHaveLength(2);
  const top = Math.min(...geo.nodes.map((n) => n.y));
  const bottom = Math.max(...geo.nodes.map((n) => n.y + n.h));
  for (const r of geo.rects) {
    expect(r.y, 'box top above every node').toBeLessThan(top);
    expect(r.y + r.h, 'box bottom below every node').toBeGreaterThan(bottom);
  }
  // Side by side, video on the left, meeting where the audio box starts.
  const [video, audio] = geo.rects;
  expect(video.x + video.w).toBeCloseTo(audio.x, 0);
  expect(video.x).toBeLessThan(audio.x);
});
