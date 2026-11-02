import { test, expect } from './fixtures';
import { container } from './container';

// The PipeWire graph page (pipewire-graph.php) draws the nodes of inactive
// ("virtual") streams faded.  The graph it reads (/api/pipewire/graph) is
// answered here, so no PipeWire is needed.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const node = (id: number, name: string, mediaClass: string, virtual: boolean) => ({
  id, name, description: name, mediaClass, properties: virtual ? { 'fpp.stream.virtual': true } : {},
});

test('an inactive media source is drawn pale but opaque, other inactive nodes faded', async ({ page }) => {
  // Regression: 8f78401bb.  Every inactive node was drawn at 45% opacity, so
  // the translucent media sources let the column background boxes show
  // through them.  Media sources (the first column) now stay opaque and are
  // pale with grey text instead.
  await page.route((u) => u.pathname === '/api/pipewire/graph', (route) => route.fulfill({
    json: {
      nodes: [
        node(1, 'fppd_video_stream_1', 'Stream/Output/Video', true),
        node(2, 'fppd_video_stream_2', 'Stream/Output/Video', false),
        node(3, 'fpp_group_1', 'Audio/Sink', true),
        node(4, 'fpp_group_2', 'Audio/Sink', false),
      ],
      ports: [],
      links: [],
    },
  }));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/pipewire-graph.php');
  await expect(page.locator('g.pw-node')).toHaveCount(4, { timeout: 20_000 });
  const drawn = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('g.pw-node')].map((g) => {
    const rect = g.querySelector('rect')!;
    const label = g.querySelector('.pw-node-label')!;
    return [label.textContent, {
      opacity: getComputedStyle(g).opacity,
      fill: getComputedStyle(rect).fill,
      text: getComputedStyle(label).fill,
    }];
  })));
  const rgb = (c: string) => c.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
  const sources = Object.keys(drawn).filter((n) => n.includes('video_stream'));
  expect(sources.length, JSON.stringify(drawn)).toBe(2);
  const [inactiveSource, activeSource] = ['fppd_video_stream_1', 'fppd_video_stream_2'].map((n) => {
    const key = Object.keys(drawn).find((k) => k.includes(n.replace('fppd_', '')) || k === n);
    return drawn[key!];
  });
  expect(inactiveSource, JSON.stringify(drawn)).toBeTruthy();

  // The inactive media source stays opaque, and paler than its active twin.
  expect(inactiveSource.opacity).toBe('1');
  const pale = rgb(inactiveSource.fill);
  const normal = rgb(activeSource.fill);
  expect(pale.reduce((a, b) => a + b), `${inactiveSource.fill} vs ${activeSource.fill}`).toBeGreaterThan(normal.reduce((a, b) => a + b));
  expect(rgb(inactiveSource.text), 'grey text on the pale node').toEqual([85, 85, 85]);
  expect(rgb(activeSource.text), 'the active node keeps the page text colour').not.toEqual([85, 85, 85]);

  // The control: an inactive node anywhere else is still faded.
  const faded = Object.values(drawn).filter((d) => d.opacity !== '1');
  expect(faded.map((d) => d.opacity)).toEqual(['0.45']);
});
