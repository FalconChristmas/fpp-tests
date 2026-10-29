import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Which settings the usage statistics payload (GET /api/statistics/usage,
// ?force=1 to regenerate it) carries: those settings.json marks
// "gatherStats", read from the settings file.

test.skip(!container, 'writes the settings file inside the run-web.sh container');

test('the DHCP server, IP forwarding and UI display settings are collected', async ({ request }) => {
  // Feature: 4831578b5 ("Collect stats on a few additional settings").
  const wanted: Record<string, string> = {
    dhcpServer: '1', dhcpOffset: '100', dhcpPoolSize: '50', ipForwarding: '2',
    temperatureInF: '1', backgroundColor: 'DC143C', fileManagerThumbnailSize: '100',
    ScheduleDistance: '48', BBBLedPWR: 'heartbeat',
  };
  await keepingSettings(async () => {
    for (const [k, v] of Object.entries(wanted)) setSettingInFile(k, v);
    const r = await request.get('/api/statistics/usage?force=1');
    const text = await r.text();
    expect(r.ok(), text).toBe(true);
    const json = JSON.parse(text);
    // The control: ordinary gatherStats settings are collected.
    expect(json.settings.fppMode).toBe('player');
    for (const [k, v] of Object.entries(wanted)) expect(json.settings[k], `${k} not collected`).toBe(v);
  });
});
