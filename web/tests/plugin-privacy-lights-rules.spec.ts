import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The colours of a plugin's privacy lights (js/fpp-privacy-lights.js,
// FPPPluginPrivacy.evaluate): FPP computes them from the pluginInfo.json
// `privacy` block, by the table published for plugin authors in
// fpp-plugin-Template (PLUGIN_GUIDELINES.md §14.15).  Red rules first, then
// amber, green when nothing matched; a key not written is "not disclosed",
// and no block at all is red throughout.  Also: the author's text in the
// rendered strip and details is escaped.  Run on plugins.php, which loads it.

type Levels = Record<string, string>;
async function open(page: Page) {
  await page.goto('/plugins.php');
  await page.waitForFunction(() => !!(window as any).FPPPluginPrivacy);
}
const levels = (page: Page, privacy: unknown) => page.evaluate((p) => {
  const r = (window as any).FPPPluginPrivacy.evaluate(p);
  // 'n': this key was not written (grey); with no block at all every light is red.
  return Object.fromEntries(r.lights.map((l: any) => [l.id, l.declared || !r.declared ? l.level : 'n'])) as Record<string, string>;
}, privacy);
const label = (page: Page, privacy: unknown, id: string) => page.evaluate(([p, i]) =>
  (window as any).FPPPluginPrivacy.evaluate(p).lights.find((l: any) => l.id === i).label, [privacy, id] as const);

const NONE = { sends: [], collects: [], sensors: [], remoteAccess: 'none', systemChanges: [], closedCode: false };
const send = (s: object) => ({ ...NONE, sends: [{ what: 'show status', why: 'to display it', ...s }] });

test('the six lights follow the published table', async ({ page }) => {
  await open(page);
  const green: Levels = { send: 'g', collect: 'g', camera: 'g', remote: 'g', system: 'g', code: 'g' };
  expect(await levels(page, NONE)).toEqual(green);
  // No block: every light red.  A block missing a key: that light not disclosed.
  expect(await levels(page, undefined)).toEqual({ send: 'r', collect: 'r', camera: 'r', remote: 'r', system: 'r', code: 'r' });
  const { sends, ...noSends } = NONE;
  expect(await levels(page, noSends)).toEqual({ ...green, send: 'n' });

  // Sends.
  expect((await levels(page, send({ to: 'https://api.example.com' }))).send).toBe('a');
  expect((await levels(page, send({ to: 'https://api.example.com', alwaysOn: true }))).send).toBe('r');
  expect((await levels(page, send({ to: 'http://8.8.8.8/report' }))).send).toBe('r');
  expect((await levels(page, send({ to: 'https://[2a00:1450::68]', alwaysOn: true }))).send).toBe('r');
  expect((await levels(page, send({ to: 'projector.local', alwaysOn: true }))).send).toBe('a');
  expect(await label(page, send({ to: 'http://192.168.1.20', alwaysOn: true }), 'send')).toBe('Sends on its own to a device on your network');
  expect(await label(page, send({ to: '[::ffff:10.0.0.4]', alwaysOn: true }), 'send')).toBe('Sends on its own to a device on your network');
  expect(await label(page, send({ to: 'cdn.example.net', what: "your browser's address", alwaysOn: true }), 'send'))
    .toBe('Your browser loads files from cdn.example.net');
  expect((await levels(page, send({ to: 'your MQTT broker', what: 'the player serial number' }))).send).toBe('r');
  expect((await levels(page, send({ to: 'your MQTT broker', what: 'the serial port name' }))).send).toBe('a');
  // A file name is not a host.
  expect(await label(page, send({ to: 'remotes.json', alwaysOn: true }), 'send')).toBe('Sends on its own');

  // Collects, camera, remote access, system changes, source.
  const col = (c: object) => ({ ...NONE, collects: [{ what: 'names', ...c }] });
  expect((await levels(page, col({ about: 'visitors' }))).collect).toBe('r');
  expect((await levels(page, col({ about: 'visitors', keptDays: 7 }))).collect).toBe('a');
  expect((await levels(page, col({ about: 'operator' }))).collect).toBe('a');
  const cam = (s: object) => ({ ...NONE, sensors: [s] });
  expect((await levels(page, cam({ type: 'camera', stored: true }))).camera).toBe('r');
  expect((await levels(page, cam({ type: 'face-tracking' }))).camera).toBe('r');
  expect((await levels(page, cam({ type: 'Microphone' }))).camera).toBe('a');
  expect(await label(page, cam({ type: 'gpio-input', stored: 'yes' }), 'camera')).toBe('Sensor readings kept');
  for (const [v, lvl] of [['lan', 'a'], ['internet-authenticated', 'a'], ['internet-open', 'r'], ['exposes-fpp', 'r'], ['tunnel', 'r'], ['something-new', 'a']]) {
    expect((await levels(page, { ...NONE, remoteAccess: v })).remote, v).toBe(lvl);
  }
  const sys = (kind: string) => ({ ...NONE, systemChanges: [{ kind, what: 'x' }] });
  for (const [k, lvl] of [['service', 'a'], ['package-source', 'r'], ['tunnel', 'r'], ['reads-core-credentials', 'r'], ['privilege', 'r']]) {
    expect((await levels(page, sys(k))).system, k).toBe(lvl);
  }
  expect(await levels(page, sys('download'))).toMatchObject({ system: 'a', code: 'a' });
  expect((await levels(page, { ...NONE, closedCode: 'true' })).code).toBe('r');
});

test("the author's text is shown as text in the strip and the details", async ({ page }) => {
  await open(page);
  const x = '<img src=x onerror="window.fppTestsRan=1">';
  const html = await page.evaluate((m) => {
    const P = (window as any).FPPPluginPrivacy;
    const r = P.evaluate({
      summary: `Summary ${m}`, other: `Other ${m}`, remoteAccess: 'none', closedCode: false, sensors: [],
      sends: [{ to: `host ${m}.example.com`, what: `what ${m}`, why: `why ${m}`, alwaysOn: true }],
      collects: [{ what: `c ${m}`, about: 'visitors', where: `where ${m}` }],
      systemChanges: [{ kind: 'service', what: `sys ${m}` }],
    });
    const div = document.createElement('div');
    div.id = 'fppTestsPrivacy';
    div.innerHTML = P.headlineHtml(r) + P.summaryHtml(r) + P.detailsHtml(r, { prefix: 'fpptests', raw: true });
    document.body.appendChild(div);
    return div.innerHTML;
  }, x);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).fppTestsRan)).toBeUndefined();
  const box = page.locator('#fppTestsPrivacy');
  await expect(box.locator('img')).toHaveCount(0);
  // Shown as typed (a leading capital may be added).
  const text = (await box.textContent())!.toLowerCase();
  for (const t of ['summary', 'other', 'what', 'why', 'where', 'sys', 'host']) expect(text).toContain(`${t} ${x}`.toLowerCase());
  expect(html).not.toContain('<img');
});

test('an always-on send to a host under a .sh or .py domain is to the internet', async ({ page }) => {
  // .sh and .py are country domains (astral.sh serves uv's installer, bun.sh
  // Bun's) as well as file extensions; HOST_RE leaves them out as file names.
  test.fail(true, 'HOST_RE excludes .sh and .py as file extensions, so these read as a phrase: amber, not red (FUTURE.md)');
  await open(page);
  expect((await levels(page, send({ to: 'https://example.com', alwaysOn: true }))).send).toBe('r');
  expect(await label(page, send({ to: 'https://astral.sh/telemetry', alwaysOn: true }), 'send')).toBe('Sends to the internet on its own');
  expect(await label(page, send({ to: 'http://stats.example.py', alwaysOn: false }), 'send')).toBe('Sends unencrypted to the internet');
});
