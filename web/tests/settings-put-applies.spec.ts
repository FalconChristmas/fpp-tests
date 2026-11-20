import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { SETTINGS, putFile, readFile } from './settings-file';
import { dropSettings, keepingSettings, setSettingInFile } from './privacy-helpers';

// PUT /api/settings/<name> does more than store the value for a few settings:
// it applies them.  Routing between interfaces goes into /etc/sysctl.conf,
// turning the hotspot on gives it a name and a key if it has none, and
// ?skipApply=1 stores without applying.

test.skip(!container, 'changes system files in the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SYSCTL = '/etc/sysctl.conf';
const put = async (request: APIRequestContext, name: string, value: string, query = '') => {
  const r = await request.put(`/api/settings/${name}${query}`, { data: value, headers: { 'Content-Type': 'text/plain' } });
  expect(r.status(), `${name}=${value}: ${await r.text()}`).toBe(200);
};
const line = (key: string) => readFile(SETTINGS).split('\n').find((l) => l.startsWith(`${key} = `));

test.describe('EnableRouting', () => {
  let before: string | undefined;
  test.beforeEach(() => {
    before = inPlayer('sh', '-c', `test -e ${SYSCTL} && cat ${SYSCTL} || printf '\\000'`);
    putFile(SYSCTL, '# fpp-tests\nvm.min_free_kbytes=16384\nnet.ipv4.ip_forward = 0\n#net.ipv4.ip_forward=1\nvm.swappiness=10\n');
  });
  test.afterEach(() => {
    if (before === '\0') inPlayer('rm', '-f', SYSCTL);
    else putFile(SYSCTL, before!);
  });
  const sysctl = () => readFile(SYSCTL).split('\n').filter(Boolean);

  test('is written to sysctl.conf as the one ip_forward line, with the rest of the file kept', async ({ request }) => {
    await keepingSettings(async () => {
      await put(request, 'EnableRouting', '1');
      expect(sysctl()).toEqual(['# fpp-tests', 'vm.min_free_kbytes=16384', 'vm.swappiness=10', 'net.ipv4.ip_forward = 1']);
      expect(line('EnableRouting')).toBe('EnableRouting = "1"');
      await put(request, 'EnableRouting', '0');
      expect(sysctl()).toEqual(['# fpp-tests', 'vm.min_free_kbytes=16384', 'vm.swappiness=10', 'net.ipv4.ip_forward = 0']);
      // Set twice, it is still one line.
      await put(request, 'EnableRouting', '0');
      expect(sysctl().filter((l) => l.includes('ip_forward'))).toEqual(['net.ipv4.ip_forward = 0']);
    });
  });

  test('stored with skipApply, leaves sysctl.conf alone', async ({ request }) => {
    await keepingSettings(async () => {
      const file = readFile(SYSCTL);
      await put(request, 'EnableRouting', '1', '?skipApply=1');
      expect(line('EnableRouting')).toBe('EnableRouting = "1"');
      expect(readFile(SYSCTL)).toBe(file);
    });
  });

  test('takes nothing into sysctl.conf but a 0 or a 1', async ({ request }) => {
    await keepingSettings(async () => {
      for (const value of ['1\nkernel.core_pattern=|/bin/sh', "1' /etc/hostname; touch /tmp/fpp-tests-routing-injected; '", 'yes']) {
        await request.put('/api/settings/EnableRouting', { data: value, headers: { 'Content-Type': 'text/plain' } });
        const forward = sysctl().filter((l) => !l.startsWith('#') && !l.startsWith('vm.'));
        expect(forward.length, `${JSON.stringify(value)}: ${JSON.stringify(sysctl())}`).toBeLessThanOrEqual(1);
        for (const l of forward) expect(l).toMatch(/^net\.ipv4\.ip_forward = [01]$/);
      }
      expect(inPlayer('sh', '-c', 'test -e /tmp/fpp-tests-routing-injected && echo y || echo n').trim()).toBe('n');
    });
  });
});

test.describe('EnableTethering', () => {
  test('gives a hotspot with no name or key the defaults', async ({ request }) => {
    await keepingSettings(async () => {
      setSettingInFile('TetherSSID', '');
      setSettingInFile('TetherPSK', '');
      await put(request, 'EnableTethering', '1', '?skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "FPP"');
      expect(line('TetherPSK')).toBe('TetherPSK = "Christmas"');
      expect(line('EnableTethering')).toBe('EnableTethering = "1"');
    });
  });

  test("keeps the name and key a hotspot already has", async ({ request }) => {
    await keepingSettings(async () => {
      setSettingInFile('TetherSSID', 'fpp-tests-show');
      setSettingInFile('TetherPSK', 'fpp-tests-key-123');
      await put(request, 'EnableTethering', '1', '?skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "fpp-tests-show"');
      expect(line('TetherPSK')).toBe('TetherPSK = "fpp-tests-key-123"');
      // Only one of the two missing: only that one is filled in.
      setSettingInFile('TetherPSK', '');
      await put(request, 'EnableTethering', '1', '?skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "fpp-tests-show"');
      expect(line('TetherPSK')).toBe('TetherPSK = "Christmas"');
    });
  });
});

test.describe('Use hostname as tether SSID', () => {
  test('a host name saved with the option on becomes the tether SSID', async ({ request }) => {
    // Feature: fpp#3199. The sync is in the API, so it also covers writes
    // from the setup wizard and direct PUTs, not just the Network page.
    // skipApply keeps this away from /etc/hostname in the test player; the
    // SSID write happens before that step is skipped.
    await keepingSettings(async () => {
      setSettingInFile('TetherUseHostname', '1');
      await put(request, 'HostName', 'fpp-tests-kitchen', '?skipApply=1&skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "fpp-tests-kitchen"');
    });
  });

  test('an existing custom SSID keeps the option off without a stored choice', async ({ request }) => {
    // Feature: fpp#3199. An install that never saw this setting but already
    // has its own SSID must not start overwriting it on hostname changes.
    await keepingSettings(async () => {
      setSettingInFile('HostName', 'fpp-tests-host');
      setSettingInFile('TetherSSID', 'fpp-tests-show');
      dropSettings('TetherUseHostname');
      await put(request, 'HostName', 'fpp-tests-other', '?skipApply=1&skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "fpp-tests-show"');
    });
  });

  test('enabling the option copies the stored host name, without .local', async ({ request }) => {
    await keepingSettings(async () => {
      setSettingInFile('HostName', 'fpp-tests.local');
      setSettingInFile('TetherSSID', 'FPP');
      await put(request, 'TetherUseHostname', '1', '?skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "fpp-tests"');
    });
  });

  test('the option off leaves the SSID alone, and on with no host name keeps the fallback', async ({ request }) => {
    await keepingSettings(async () => {
      setSettingInFile('TetherUseHostname', '0');
      setSettingInFile('TetherSSID', 'fpp-tests-show');
      await put(request, 'HostName', 'fpp-tests-other', '?skipApply=1&skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "fpp-tests-show"');

      // A fresh install has no HostName in the settings file. Never write
      // an empty SSID: fppinit needs its FPP fallback on first boot.
      dropSettings('HostName');
      setSettingInFile('TetherSSID', 'FPP');
      await put(request, 'TetherUseHostname', '1', '?skipBackup=1');
      expect(line('TetherSSID')).toBe('TetherSSID = "FPP"');
    });
  });
});

test('a name that could not be a setting is refused before anything is stored', async ({ request }) => {
  const file = readFile(SETTINGS);
  // What would break the settings file's key = "value" lines, or start a section or a comment in it.
  for (const name of ['a=b', 'a;b', 'a[b]', 'a%23b', 'a"b', "a'b", 'x%0Ay']) {
    const r = await request.put(`/api/settings/${name}`, { data: '1', headers: { 'Content-Type': 'text/plain' } });
    expect(r.status(), name).toBe(400);
    expect(await r.json()).toEqual({ status: 'ERROR', message: 'Invalid setting name.' });
  }
  expect(readFile(SETTINGS)).toBe(file);
});
