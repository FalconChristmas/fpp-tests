import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { dropSettings, keepingSettings, setSettingInFile } from './privacy-helpers';

// Smaller facts about the usage statistics payload (GET /api/statistics/usage,
// ?force=1 to regenerate it): where the settings come from, the link state of
// each interface, and the memory block.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function payload(request: APIRequestContext) {
  const r = await request.get('/api/statistics/usage?force=1');
  const text = await r.text();
  expect(r.ok(), text).toBe(true);
  return JSON.parse(text);
}

test('only the settings the user changed are reported, not the defaults behind them', async ({ request }) => {
  // Regression: dabc5dd4b.  stats_getSettings() read the $settings array,
  // which holds every setting with its default, so a setting nobody had
  // touched was reported as if it had been changed; the settings file is
  // reread so only what it holds is sent.
  await keepingSettings(async () => {
    dropSettings('LogLevel_General', 'MQTTPort');
    setSettingInFile('LogLevel_Sync', 'debug');
    const json = await payload(request);
    // The control: a setting in the file is collected, with the file's value.
    expect(json.settings.LogLevel_Sync).toBe('debug');
    // Both are gatherStats settings with a default, and neither is in the file.
    for (const k of ['LogLevel_General', 'MQTTPort']) {
      expect(json.settings[k], `${k} (a default, never set) was reported`).toBeUndefined();
    }
  });
});

test('each interface is reported with the link state the kernel gives it', async ({ request }) => {
  // Feature: dd918e3a8.  The network block lists the interfaces with their
  // operstate (and, through the allowlist, their config).
  const json = await payload(request);
  const names = Object.keys(json.network.interfaces);
  expect(names, 'no interface reported').toContain('eth0');
  for (const n of names) {
    const kernel = inPlayer('cat', `/sys/class/net/${n}/operstate`).trim().toUpperCase();
    expect(json.network.interfaces[n].operstate, n).toBe(kernel);
  }
});

test('the memory block carries what /proc/meminfo says', async ({ request }) => {
  // Feature: 14363cfb6 (stats_memory() learned memory_pressure for macOS; the
  // /proc/meminfo branch it kept is what a Linux player runs).
  const json = await payload(request);
  const info = inPlayer('cat', '/proc/meminfo');
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(info)![1]);
  expect(json.memory.meminfoAvailable).toBe(true);
  expect(Number(json.memory.MemTotal), 'MemTotal').toBe(kb('MemTotal'));
  for (const k of ['MemFree', 'MemAvailable', 'Active', 'Inactive', 'Cached']) {
    expect(json.memory[k], `${k} missing`).toBeDefined();
    // Live values move between the two reads; they stay within the machine.
    expect(Number(json.memory[k]), k).toBeLessThanOrEqual(kb('MemTotal'));
  }
});
