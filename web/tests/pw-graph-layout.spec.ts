import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { nullSink, pw, startPipeWire, stopPipeWire } from './pw-live';
import { loadGeneratedConf, standInNode } from './pw-load';

// How pipewire-graph.php draws FPP's own PipeWire plumbing: which nodes it
// folds into which (loopback halves into their input group, an EQ'd input
// group's routing hub into its EQ), which column each lands in, and which
// ports and links are drawn.  The graph is a real PipeWire's: the input
// groups are saved and applied through the API, and the config Apply
// generates is loaded by a real PipeWire (pw-load.ts), with null nodes
// standing in for the output group's sink and the capture devices.  What
// the page drew is read from its SVG.

test.skip(!container, 'runs a PipeWire inside the run-web.sh container');

// Each Apply restarts fppd and waits for it to come back.
test.describe.configure({ timeout: 240_000 });

const SETTINGS = '/home/fpp/media/settings';

test.afterEach(() => {
  inPlayer('sh', '-c', `sed -i '/^PipeWireSinkName /d' ${SETTINGS}`);
  pw('pkill -x pw-cat; true');
  stopPipeWire();
  cleanupPipeWire();
});

type Port = { label: string; side: 'left' | 'right'; x: number; y: number };
type Node = { label: string; col: string; x: number; y: number; ports: Port[] };
type Link = { from: string; fromPort: string; to: string; toPort: string };
type Drawn = { columns: string[]; nodes: Node[]; links: Link[] };

// The nodes, ports and links on the page, by what they are labelled.
async function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const headers = [...document.querySelectorAll('.pw-col-header')].map((t) => ({ label: t.textContent ?? '', x: Number(t.getAttribute('x')) }));
    const nodes = [...document.querySelectorAll('g.pw-node')].map((g) => {
      const m = (g.getAttribute('transform') ?? '').match(/translate\(([-\d.e]+),\s*([-\d.e]+)\)/)!;
      const x = Number(m[1]);
      const y = Number(m[2]);
      const w = Number(g.querySelector('rect')?.getAttribute('width') ?? 0);
      const centre = x + w / 2;
      const col = headers.reduce((a, b) => (Math.abs(b.x - centre) < Math.abs(a.x - centre) ? b : a)).label;
      const ports = [...g.querySelectorAll('circle.pw-port-dot')].map((c) => {
        const cx = Number(c.getAttribute('cx'));
        const cy = Number(c.getAttribute('cy'));
        const label = c.nextElementSibling?.classList.contains('pw-port-label') ? c.nextElementSibling.textContent ?? '' : '';
        return { label, side: (cx === 0 ? 'left' : 'right') as 'left' | 'right', x: x + cx, y: y + cy };
      });
      return { label: g.querySelector('.pw-node-label')?.textContent ?? '', col, x, y, ports };
    });
    const at = (px: number, py: number) => {
      for (const n of nodes) for (const p of n.ports) if (Math.abs(p.x - px) < 0.5 && Math.abs(p.y - py) < 0.5) return [n.label, p.label];
      return ['?', '?'];
    };
    const links = [...document.querySelectorAll('path.pw-link')].map((l) => {
      const nums = (l.getAttribute('d') ?? '').match(/-?[\d.]+(e-?\d+)?/g)!.map(Number);
      const [from, fromPort] = at(nums[0], nums[1]);
      const [to, toPort] = at(nums[nums.length - 2], nums[nums.length - 1]);
      return { from, fromPort, to, toPort };
    });
    return { columns: headers.map((h) => h.label), nodes, links };
  });
}

// The page, once it has drawn every node in `labels`.
async function openGraph(page: Page, labels: string[]): Promise<Drawn> {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/pipewire-graph.php');
  let d: Drawn = { columns: [], nodes: [], links: [] };
  await expect.poll(async () => {
    d = await drawn(page);
    return labels.filter((l) => !d.nodes.some((n) => n.label === l));
  }, { timeout: 20_000, message: 'nodes not drawn' }).toEqual([]);
  // The links are drawn with the nodes; give WirePlumber's last ones a poll.
  await page.waitForTimeout(500);
  return drawn(page);
}

function node(d: Drawn, label: string): Node {
  const n = d.nodes.find((x) => x.label === label);
  expect(n, `no node "${label}" in ${JSON.stringify(d.nodes.map((x) => x.label))}`).toBeTruthy();
  return n!;
}

function seedOutputGroup() {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, { groups: [{ id: 1, name: 'Out', channels: 2, enabled: true, members: [] }] });
}

async function applyInputGroups(request: APIRequestContext, inputGroups: unknown[]) {
  const save = await request.post('/api/pipewire/audio/input-groups', { data: { inputGroups } });
  expect(save.ok(), await save.text()).toBe(true);
  const apply = await request.post('/api/pipewire/audio/input-groups/apply', { timeout: 120_000 });
  expect(apply.ok(), await apply.text()).toBe(true);
  await settleAfterApply(request);
}

const MIC = 'alsa_input.usb-fpp_tests_mic-00.analog-stereo';

// Two input groups taking the same media stream (so it goes through a tee),
// the first with an EQ (so its output goes through a routing hub) and a
// capture device too (so it has a loopback of its own); both routed to the
// output group.
async function teeAndEqGraph(page: Page, request: APIRequestContext): Promise<Drawn> {
  seedOutputGroup();
  await applyInputGroups(request, [
    { id: 1, name: 'Bus A', enabled: true, channels: 2, outputs: [1],
      effects: { eq: { enabled: true, bands: [{ type: 'bq_peaking', freq: 1000, gain: 3, q: 1 }] } },
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }, { type: 'capture', name: 'Mic', cardId: 'Mic', nodeName: MIC }] },
    { id: 2, name: 'Bus B', enabled: true, channels: 2, outputs: [1], members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] },
  ]);
  loadGeneratedConf([standInNode('fpp_group_out'), standInNode(MIC, { mediaClass: 'Audio/Source' })],
    ['fpp_input_bus_a', 'fpp_input_bus_b', 'fpp_tee_fppd_stream_1', 'fpp_route_ig_1', 'output.fpp_loopback_ig1_mic']);
  return openGraph(page, ['Bus A', 'Bus B', 'EQ: Bus A', 'FPP Media Stream 1 Tee', 'fpp_group_out']);
}

const ports = (n: Node, side: 'left' | 'right') => n.ports.filter((p) => p.side === side).map((p) => p.label);
const linkList = (d: Drawn) => d.links.map((l) => `${l.from}.${l.fromPort} > ${l.to}.${l.toPort}`);

test("an output card's box is titled with its ALSA card name", async ({ page }) => {
  // Feature: 5f889769d.  An alsa_* sink was titled with its node
  // description, which for a USB card is a long generic string; the card's
  // own name (api.alsa.card.name) is the one the user knows it by.
  startPipeWire({ objects: [nullSink('alsa_output.usb-fpp_tests_card-00.analog-stereo',
    { 'node.description': 'fpp-tests generic description', 'api.alsa.card.name': 'FPP Tests Card' })] });
  const d = await openGraph(page, ['FPP Tests Card']);
  expect(node(d, 'FPP Tests Card').col).toBe('HW Outputs');
  expect(d.nodes.map((n) => n.label)).not.toContain('fpp-tests generic description');
});

test("an input group's loopbacks are folded into it, leaving only its own ports", async ({ page, request }) => {
  // Regression: 1d3b4924d.  Folding a loopback's two halves into the input
  // group moved their ports onto the group's box as well: it grew a second
  // set of inputs and outputs, the capture half's labelled UNK (a loopback's
  // capture stream has no channel positions).  Now the halves' links are
  // moved onto the group's own ports instead.  (45c8159c2, which first folded
  // the halves in, is covered by pw-graph.spec.ts.)
  const d = await teeAndEqGraph(page, request);
  const bus = node(d, 'Bus A');
  expect(ports(bus, 'left')).toEqual(['FL', 'FR']);
  expect(ports(bus, 'right')).toEqual(['FL', 'FR']);
  expect(d.nodes.flatMap((n) => n.ports.map((p) => `${n.label}.${p.label}`)).filter((p) => /UNK/.test(p))).toEqual([]);
  // What fed the loopbacks now feeds the group's own inputs.
  const into = d.links.filter((l) => l.to === 'Bus A').map((l) => `${l.from}.${l.fromPort} > ${l.toPort}`);
  expect(into).toEqual(expect.arrayContaining(['FPP Media Stream 1 Tee.FL > FL', 'FPP Media Stream 1 Tee.FR > FR']));
  expect(into.some((l) => l.startsWith('alsa_input.usb-fpp_tests_mi'))).toBe(true);
  expect(d.nodes.filter((n) => /→ Bus/.test(n.label)).map((n) => n.label)).toEqual([]);
});

test("an input group's EQ routing hub is drawn as part of its EQ", async ({ page, request }) => {
  // Feature: 6ea715556.  With an EQ, an input group's output goes through a
  // routing hub (fpp_route_ig_<id>, a combine-stream with an output stream
  // per output group) after the EQ; the hub and its streams were drawn as
  // boxes of their own instead of the EQ leading straight to the output group.
  const d = await teeAndEqGraph(page, request);
  expect(d.nodes.filter((n) => /Routing/.test(n.label)).map((n) => n.label)).toEqual([]);
  const eq = node(d, 'EQ: Bus A');
  expect(eq.col).toBe('Effects');
  expect(ports(eq, 'right')).toEqual(['FL', 'FR']);
  expect(linkList(d)).toEqual(expect.arrayContaining([
    'Bus A.FL > EQ: Bus A.FL', 'Bus A.FR > EQ: Bus A.FR', 'EQ: Bus A.FL > fpp_group_out.FL', 'EQ: Bus A.FR > fpp_group_out.FR']));
});

test("a media stream's tee has a column of its own, between the sources and the input groups", async ({ page, request }) => {
  // Feature: d7f6a5928.  The tee (a null sink fanning one fppd stream out to
  // several input groups) was drawn in the Input Groups column, as if it were
  // one of them.
  const d = await teeAndEqGraph(page, request);
  expect(d.columns.indexOf('Input Tees')).toBe(d.columns.indexOf('Media Sources') + 1);
  expect(d.columns.indexOf('Input Groups')).toBe(d.columns.indexOf('Input Tees') + 1);
  expect(node(d, 'FPP Media Stream 1 Tee').col).toBe('Input Tees');
  expect(node(d, 'Bus B').col).toBe('Input Groups');
});

test('the links from a tee to the input groups it feeds are drawn', async ({ page, request }) => {
  // Regression: 8eb51d90c.  A tee feeds its loopbacks from its monitor
  // ports, and every monitor port was dropped as plumbing, so the tee's links
  // to its input groups had no start and were never drawn.
  const d = await teeAndEqGraph(page, request);
  expect(ports(node(d, 'FPP Media Stream 1 Tee'), 'right')).toEqual(['FL', 'FR']);
  expect(linkList(d)).toEqual(expect.arrayContaining([
    'FPP Media Stream 1 Tee.FL > Bus A.FL', 'FPP Media Stream 1 Tee.FR > Bus A.FR',
    'FPP Media Stream 1 Tee.FL > Bus B.FL', 'FPP Media Stream 1 Tee.FR > Bus B.FR']));
});

test('media streams are listed above capture devices in the sources column', async ({ page, request }) => {
  // Feature: 9b513af1a.  The sources column was in name order (then moved
  // about to cut crossings), so a capture device named "alsa_input..." sat
  // in among, or above, fppd's media streams.
  const d = await teeAndEqGraph(page, request);
  const sources = d.nodes.filter((n) => n.col === 'Media Sources').sort((a, b) => a.y - b.y).map((n) => n.label);
  const mic = sources.findIndex((l) => l.startsWith('alsa_input.usb-fpp_tests_mi'));
  // The control: the capture device and fppd's five streams are all there.
  expect(mic, JSON.stringify(sources)).toBeGreaterThan(-1);
  expect(sources.filter((l) => /^FPP Media Stream \d$/.test(l))).toHaveLength(5);
  expect(sources.slice(mic + 1).filter((l) => /^FPP Media Stream/.test(l)), JSON.stringify(sources)).toEqual([]);
});
