import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { settingInFile, setSettingInFile } from './settings-file';

// The header bar every page shows (player state, sensors, FPP mode) and the
// banners under it, as the status reaches the page: fppd pushes a snapshot
// over /fppdws about once a second, and the page polls api/system/status for
// the PHP half.  Where a test needs a status this player can't produce
// (sensors, a sequence and media playing), it edits the fields in fppd's own
// snapshots on their way to the page; everything else in them is real.

type Status = Record<string, any>;

// Pass fppd's pushes through, each status edited by `edit`.
async function editSnapshots(page: Page, edit: (status: Status) => void) {
  await page.routeWebSocket('**/fppdws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== 'string') return ws.send(message);
      let msg;
      try {
        msg = JSON.parse(message);
      } catch {
        return ws.send(message);
      }
      if (msg?.type === 'snapshot' && msg.data?.status) edit(msg.data.status);
      ws.send(JSON.stringify(msg));
    });
  });
}

// The same sensor fields fppd reports (Sensors::reportSensors()).
const sensor = (label: string, value: number, valueType: string, postfix = '') =>
  ({ label, value, formatted: value.toFixed(1) + postfix, valueType, postfix });

test.describe('header sensors', () => {
  test('fan speeds are left out of the rotating display but kept in its tooltip', async ({ page }) => {
    // Regression: 72c5e4cde.  The header (and the status page's sensor
    // table) showed temperatures only, so a cape's voltage never appeared;
    // fans, which have their own display, now are the only ones left out.
    await editSnapshots(page, (s) => {
      s.sensors = [sensor('CPU: ', 45.2, 'Temperature'), sensor('Supply: ', 5.1, 'Voltage', 'V'),
        sensor('Case Fan: ', 1200, 'FanSpeed', ' RPM')];
    });
    await page.goto('/index.php');
    const spans = page.locator('#header_sensors .sensorSpan');
    await expect(spans).toHaveCount(2, { timeout: 15_000 });
    await expect(spans.nth(0)).toContainText('CPU: 45.2');
    await expect(spans.nth(1)).toContainText('Supply: 5.1V');
    await expect(page.locator('#header_sensors')).not.toContainText('RPM');

    await page.locator('#header_sensors .sensorSpan:not(.hiddenSensor)').hover();
    const tip = page.locator('.tooltip.show');
    await expect(tip).toContainText('Case Fan:');
    await expect(tip).toContainText('1200.0 RPM');
  });

  test('an open sensor tooltip stays open across refreshes and follows the readings', async ({ page }) => {
    // Regression: c90c4b0af.  Every refresh rebuilt the sensor spans and
    // their tooltips, because the rebuild was keyed on the readings: an open
    // tooltip closed and reopened once a second.
    let reading = 40;
    await editSnapshots(page, (s) => {
      reading += 1;
      s.sensors = [sensor('CPU: ', reading, 'Temperature'), sensor('Supply: ', 5.1, 'Voltage', 'V')];
    });
    await page.goto('/index.php');
    await expect(page.locator('#header_sensors .sensorSpan')).toHaveCount(2, { timeout: 15_000 });
    const shown = page.locator('#header_sensors .sensorSpan:not(.hiddenSensor)');
    await shown.hover();
    const tip = page.locator('.tooltip.show');
    await expect(tip).toContainText('CPU:');
    const first = reading;
    // Watch the open tooltip: tag it, and note if it is ever taken out.
    await page.evaluate(() => {
      const el = document.querySelector('.tooltip.show') as any;
      el.__fppTests = 1;
      (window as any).__fppTestsTipRemoved = false;
      new MutationObserver(() => {
        if (!document.body.contains(el)) (window as any).__fppTestsTipRemoved = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    // The control: the readings keep coming.
    await expect.poll(() => reading, { timeout: 15_000 }).toBeGreaterThan(first + 3);
    expect(await page.evaluate(() => (window as any).__fppTestsTipRemoved)).toBe(false);
    expect(await page.evaluate(() => (document.querySelector('.tooltip.show') as any)?.__fppTests)).toBe(1);
    // And the open tooltip shows a newer reading than the one it opened on.
    await expect.poll(async () => parseFloat((await tip.innerText()).match(/CPU:\s*([\d.]+)/)?.[1] ?? '0')).toBeGreaterThan(first + 1);
  });
});

test('test mode shows Testing in the header, and Idle again after', async ({ page, request }) => {
  // Feature: 0917dc493.  The header had no state for test mode: it showed
  // nothing (fppd's status_name "testing" matched no case).
  await page.goto('/index.php');
  const player = page.locator('#header_player');
  await expect(player).toContainText('Idle', { timeout: 15_000 });
  try {
    const t = await request.post('/api/command', { data: { command: 'Test Start', args: ['1000', 'RGB Cycle', '1-510', 'R-G-B'] } });
    expect(t.ok()).toBe(true);
    // The control: fppd says it is testing.
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).status_name).toBe('testing');
    await expect(player).toContainText('Testing', { timeout: 15_000 });
    await player.locator('span').first().hover();
    await expect(page.locator('.tooltip.show')).toContainText('Display Testing Active');
  } finally {
    await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  }
  await expect(player).toContainText('Idle', { timeout: 15_000 });
});

test("the header's Playing tooltip names the media as well as the sequence", async ({ page }) => {
  // Regression: 1bee5596f.  The tooltip named the sequence only, so a
  // sequence with its audio read the same as a silent one.
  await editSnapshots(page, (s) => {
    Object.assign(s, {
      status: 1, status_name: 'playing', current_sequence: 'fpp-tests-show.fseq', current_song: 'fpp-tests-show.mp3',
      current_playlist: { ...(s.current_playlist ?? {}), playlist: 'fpp-tests-playlist', type: 'both', index: '1', count: '1' },
    });
  });
  await page.goto('/index.php');
  const badge = page.locator('#header_player > span');
  await expect(badge).toContainText('Playing', { timeout: 15_000 });
  await badge.hover();
  const tip = page.locator('.tooltip.show');
  await expect(tip).toContainText('fpp-tests-show.fseq');
  await expect(tip).toContainText('fpp-tests-show.mp3');
});

test.describe('the restart banner', () => {
  // Each test starts from no restart or reboot pending and the UI warnings
  // on, whatever an earlier test left: a pending reboot hides the restart
  // banner (the reboot one replaces it), and disableUIWarnings hides both.
  let warningsOff: string | undefined;
  test.beforeEach(async ({ request }) => {
    warningsOff = settingInFile('disableUIWarnings');
    for (const [name, value] of [['restartFlag', '0'], ['rebootFlag', '0'], ['disableUIWarnings', '0']]) {
      expect((await request.put(`/api/settings/${name}`, { data: value })).ok(), name).toBe(true);
    }
  });
  test.afterEach(async ({ request }) => {
    await request.put('/api/settings/restartFlag', { data: '0' });
    await request.put('/api/settings/rebootFlag', { data: '0' });
    if (warningsOff !== undefined && warningsOff !== '0') await request.put('/api/settings/disableUIWarnings', { data: warningsOff });
  });

  test('once raised it stays up while status pushes arrive', async ({ page, request }) => {
    // Regression: d54e61ad1.  RefreshHeaderBar copied restartFlag out of the
    // merged status cache on every push (about once a second), and that copy
    // came from the PHP poll, every 30 s with the socket: the banner showed,
    // and the next push hid it again until the poll caught up.
    const frames: number[] = [];
    page.on('websocket', (ws) => ws.on('framereceived', () => frames.push(Date.now())));
    await page.goto('/index.php');
    // The page is on the socket before the setting changes.
    await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(1);
    const banner = page.locator('#restartFlag');
    await expect(banner).toBeHidden();
    // The page starts from the state the test set.
    expect(await page.evaluate(() => {
      const s = (window as any).settings;
      return [String(s.restartFlag), String(s.rebootFlag), String(s.disableUIWarnings ?? '0')];
    })).toEqual(['0', '0', '0']);
    await expect(page.locator('#rebootFlag')).toBeHidden();

    // Save a setting that needs an fppd restart, as its input does (the
    // value it already has: ScheduleDistance, whose restart level is 2).
    const distance = (await (await request.get('/api/settings/ScheduleDistance')).json()).value ?? '28';
    await page.evaluate((v) => (window as any).SetSetting('ScheduleDistance', v, 2, 0), String(distance));
    await expect(banner).toBeVisible();
    const pushes = frames.length;
    const hidden: number[] = [];
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      if (!(await banner.isVisible())) hidden.push(i);
    }
    // The control: pushes kept arriving while it was watched.
    expect(frames.length - pushes).toBeGreaterThan(5);
    expect(hidden, 'samples (of 40, 250 ms apart) with the banner hidden').toEqual([]);
    // And the flag reached the settings file, where the next page reads it.
    await expect.poll(async () => (await (await request.get('/api/settings/restartFlag')).json()).value).toBe('2');
  });

  test('a select correcting a saved value that is no longer offered raises no banner', async ({ page, request }) => {
    // Regression: 414a6464d.  A select whose saved value isn't among its
    // options picks the default on load and saves it, and that save passed
    // the setting's restart flag: opening the page raised "Restart Required"
    // for a value the running fppd never had.  ScheduleDistance (Playback
    // tab, Advanced UI level) needs a restart.
    const before = String((await (await request.get('/api/settings/ScheduleDistance')).json()).value ?? '28');
    const level = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
    await request.put('/api/settings/uiLevel', { data: '1' });
    setSettingInFile('ScheduleDistance', '3');
    try {
      await page.goto('/settings.php?tab=Playback');
      await expect(page.locator('select#ScheduleDistance')).toBeAttached({ timeout: 15_000 });
      // The control: the page did correct it, to the default.
      await expect.poll(() => settingInFile('ScheduleDistance'), { timeout: 15_000 }).toBe('28');
      await page.waitForTimeout(1500);
      await expect(page.locator('#restartFlag')).toBeHidden();
      await expect(page.locator('#rebootFlag')).toBeHidden();
      expect(settingInFile('restartFlag') ?? '0').toBe('0');
    } finally {
      await request.put('/api/settings/ScheduleDistance', { data: before });
      await request.put('/api/settings/uiLevel', { data: level });
    }
  });
});

test('on an orange header the update icon takes the text colour', async ({ page, request }) => {
  // Regression: 2890e5f6d.  The update-available icon is orange, and on a
  // DarkOrange (FF8C00) or Orange (FFA500) header it disappeared.  The fix
  // is a colour, so a colour is what is checked.
  const before = String((await (await request.get('/api/settings/backgroundColor')).json()).value ?? '');
  try {
    for (const [colour, want] of [['FF8C00', 'rgb(152, 152, 152)'], ['FFA500', 'rgb(152, 152, 152)']]) {
      expect((await request.put('/api/settings/backgroundColor', { data: colour })).ok()).toBe(true);
      await page.goto('/index.php');
      await expect(page.locator('.header')).toHaveCSS('background-color', colour === 'FF8C00' ? 'rgb(255, 140, 0)' : 'rgb(255, 165, 0)');
      await expect(page.locator('#navbarUpdateAvail a')).toHaveCSS('color', want);
    }
    // The control: on another header colour the icon keeps its own.
    expect((await request.put('/api/settings/backgroundColor', { data: '336699' })).ok()).toBe(true);
    await page.goto('/index.php');
    await expect(page.locator('#navbarUpdateAvail a')).not.toHaveCSS('color', 'rgb(152, 152, 152)');
  } finally {
    await request.put('/api/settings/backgroundColor', { data: before });
  }
});
