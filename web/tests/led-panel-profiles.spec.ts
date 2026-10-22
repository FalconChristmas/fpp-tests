import { test, expect } from './fixtures';

// The LED Panels page's handling of data it is handed from outside: vendor
// panel settings tiered by FPP version, and PWM register profiles pasted in
// or loaded from a capture catalog.  Both are parsed in the browser, by
// functions co-ledPanels.php defines on the Channel Outputs page whether or
// not the panels tab is shown on this platform.

test.beforeEach(async ({ page }) => {
  await page.goto('/channeloutputs.php');
  await page.waitForFunction(() => typeof (window as any).vendorSettingsKeysFor === 'function'
    && typeof (window as any).ParseSPWMPayload === 'function', null, { timeout: 15_000 });
});

test('vendor panel settings apply the version tiers this player has reached, in order', async ({ page }) => {
  // Feature: 1ac10c187 (the -v<major> tiers), fd8a4c7b0 (-v<major>.<minor>).
  // Vendor panel data is fetched live by every FPP
  // version, so settings an older one cannot represent go in "<subType>-v<N>"
  // tiers; "-v<major>.<minor>" tiers gate support added within a major.  A
  // player applies every tier at or below its own version, lowest first, and
  // skips the rest.
  const { keys, major, minor } = await page.evaluate(() => {
    const w = window as any;
    const major = w.FPP_MAJOR_VERSION as number;
    const minor = w.FPP_MINOR_VERSION as number;
    const settings: Record<string, object> = {};
    for (const k of [`P10-v${major + 1}`, `P10-v${major}.${minor + 1}`, `P10-v${major}.${minor}`,
                     `P10-v${major}`, `P10-v${major - 1}`, `P10-v${major}.x`, 'P10']) {
      settings[k] = {};
    }
    return { keys: w.vendorSettingsKeysFor('P10', settings) as string[], major, minor };
  });
  expect(keys).toEqual(['P10', `P10-v${major - 1}`, `P10-v${major}`, `P10-v${major}.${minor}`]);
});

test('a PWM register profile payload is parsed, and malformed ones refused', async ({ page }) => {
  // Feature: 9f0fca6df.  A profile is "slot|R|G|B", each colour a list of
  // 1-4 digit hex words, all three the same length; the page pads the words
  // to four digits.  A catalog is a header line naming the panel and type,
  // then tab-separated name, source, scans and payload.
  const r = await page.evaluate(() => {
    const w = window as any;
    const ok = w.ParseSPWMPayload('2|1,a2,0B3|ff,0,1|7,8,9');
    const bad = ['', '7|1|2|3', '0|1|2|3', '2|1,2|3|4', '2|1|2|zz', '2|1|2', '2|1;2|3;4|5;6', '2|12345|1|1'];
    const refused = bad.map((p) => w.ParseSPWMPayload(p));
    const cat = w.ParseSPWMCatalog('RGBMATRIX_SPWM_PROFILES\tP5\tFM6373\n'
      + 'one\tdriverA p5\tScan_16,Scan_32\t1|1|2|3\n'
      + 'fixed\tdriverB\tScan_16\t1;2;3\n'
      + 'two\tdriverC\tScan_8\t3|a,b|c,d|e,f\n');
    let badHeader = '';
    try { w.ParseSPWMCatalog('NOT A CATALOG\n1\t2\t3\t1|1|1|1\n'); } catch (e) { badHeader = String(e); }
    return { ok, refused, cat, badHeader };
  });
  expect(r.ok).toEqual({ slot: 2, r: ['0001', '00a2', '00b3'], g: ['00ff', '0000', '0001'], b: ['0007', '0008', '0009'] });
  expect(r.refused).toEqual(r.refused.map(() => null));
  expect(r.cat.panel).toBe('P5');
  expect(r.cat.type).toBe('FM6373');
  expect(r.cat.profiles.map((p: any) => [p.name, p.slot, p.scans])).toEqual([['one', 1, 'Scan_16,Scan_32'], ['two', 3, 'Scan_8']]);
  expect(r.badHeader).toContain('bad header');
});
