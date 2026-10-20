import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// The settings API stored the raw request body, so a line break in a value
// added whole new lines (new settings) to the settings file, and settings
// that reach root shell commands -- HostName, TimeZone, the email addresses --
// were stored in whatever shape they were sent.  A backup restore wrote them
// the same way.  Fixed in fpp 812dce14e ("fix(security): validate settings
// that reach root shell commands"): WriteSettingToFile() refuses them, the
// API answers 400, and a restore skips a value that was refused.
//
// The writes carry ?skipApply=1, so a tree without the check stores the value
// and nothing more: the apply step would rename the test player's host.

async function getValue(request: APIRequestContext, name: string): Promise<string | undefined> {
  return (await (await request.get(`/api/settings/${name}`)).json()).value;
}

async function put(request: APIRequestContext, name: string, value: string) {
  return request.put(`/api/settings/${name}?skipApply=1`, { data: value });
}

test('a line break in a value cannot add a setting', async ({ request }) => {
  try {
    // The control: a setting no page declares is stored and read back.
    expect((await put(request, 'fppTestsSetting', 'ok')).status()).toBe(200);
    expect(await getValue(request, 'fppTestsSetting')).toBe('ok');

    const r = await put(request, 'fppTestsSetting', 'a\nfppTestsInjected = 1');
    expect(r.status(), await r.text()).toBe(400);
    expect(await getValue(request, 'fppTestsInjected'), 'the line break added a setting').toBeUndefined();
    expect(await getValue(request, 'fppTestsSetting')).toBe('ok');
  } finally {
    await put(request, 'fppTestsSetting', '');
    await put(request, 'fppTestsInjected', '');
  }
});

test('settings used in root commands refuse values of the wrong shape', async ({ request }) => {
  const bad: Record<string, string> = {
    HostName: 'x;id',
    TimeZone: 'Bad/Zone$(id)',
    emailtoemail: '-oX@y',
  };
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(bad)) {
    saved[name] = await getValue(request, name);
  }
  try {
    for (const [name, value] of Object.entries(bad)) {
      const r = await put(request, name, value);
      expect(r.status(), `${name} = ${value}: ${await r.text()}`).toBe(400);
      expect(await getValue(request, name), name).toBe(saved[name]);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if ((await getValue(request, name)) !== value) {
        await put(request, name, value ?? '');
      }
    }
  }
});

test.describe('restore', () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

  test('a backup restore does not store a refused value', async ({ request }) => {
    const before = await getValue(request, 'HostName');
    // A fresh player has no backups directory until its first backup.
    inPlayer('mkdir', '-p', '/home/fpp/media/config/backups');
    const backup = {
      fpp_backup_version: '7',
      settings: { system_settings: [{ HostName: 'a;b' }] },
    };
    try {
      const up = await request.post('/api/file/JsonBackups/fpp-tests-settings.json', { data: JSON.stringify(backup) });
      expect(up.ok(), await up.text()).toBe(true);
      const r = await request.post('/api/backups/configuration/restore/JsonBackups/fpp-tests-settings.json', {
        data: 'settings/system_settings',
      });
      expect(r.ok(), await r.text()).toBe(true);
      expect(await getValue(request, 'HostName')).toBe(before);
    } finally {
      if ((await getValue(request, 'HostName')) !== before) {
        await put(request, 'HostName', before ?? '');
      }
      await request.delete('/api/file/JsonBackups/fpp-tests-settings.json');
    }
  });
});
