import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// What config.php prints into each page's JavaScript `settings` array.
//
// 6f26c45c4 ("start of process to lock down settings exposed as JS settings
// array") stopped printing every setting into every page: a setting declared
// in www/settings.json is printed only on the pages its "exposedAsJSToPages"
// names ("all" for every page), and one declared without it on none.  A
// setting not declared at all is still printed everywhere, as before, until
// it is declared.  Later commits declared more settings, either to hide them
// or to keep printing them where a page reads them.
//
// The receiving end is the page's own script: window.settings as the browser
// has it, and, where a page acts on a setting, what the page then does.

test.skip(!container, 'writes the settings file inside the run-web.sh container');

async function jsSettings(page: Page, path: string): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await page.waitForLoadState('load');
  const s = await page.evaluate(() => ({ ...((window as any).settings ?? {}) }));
  expect(errors, `${path} threw`).toEqual([]);
  expect(s.fppMode, `${path} has no settings array at all`).toBe('player');
  return s;
}

const PAGES = ['/index.php', '/settings.php', '/scheduler.php', '/multisync.php', '/filemanager.php'];

// Password settings as settings.json declares them (type "password").
const CREDENTIALS = ['MQTTPassword', 'gitHubPAT', 'osPassword', 'osPasswordVerify', 'emailpass', 'passwordVerify', 'TetherPSK'];

test('a declared password setting is printed into no ordinary page', async ({ page }) => {
  // Regression: 6f26c45c4.  Every setting, the OS login password and the
  // GitHub token included, went into every page's script.
  await keepingSettings(async () => {
    for (const k of CREDENTIALS) setSettingInFile(k, `fpp-tests-secret-${k}`);
    for (const path of PAGES) {
      const s = await jsSettings(page, path);
      for (const k of CREDENTIALS) expect(s[k], `${k} printed on ${path}`).toBeUndefined();
      expect(JSON.stringify(s)).not.toContain('fpp-tests-secret-');
    }
  });
});

test('a setting exposed to one page is printed there and not on the others', async ({ page }) => {
  // Regression: 6f26c45c4.  ScheduleSeconds names only the scheduler, whose
  // time fields it decides; the status page used to get it too.
  await keepingSettings(async () => {
    setSettingInFile('ScheduleSeconds', '1');
    expect((await jsSettings(page, '/scheduler.php')).ScheduleSeconds).toBe('1');
    expect((await jsSettings(page, '/index.php')).ScheduleSeconds, 'printed on the status page').toBeUndefined();
  });
});

test('the usage statistics upload URL is not printed', async ({ page }) => {
  // Regression: 70b3565c5.  statsPublishUrl was not declared, so every page
  // carried it.
  await keepingSettings(async () => {
    setSettingInFile('statsPublishUrl', 'https://fpp-tests.invalid/stats');
    for (const path of ['/index.php', '/settings.php']) {
      expect((await jsSettings(page, path)).statsPublishUrl, `printed on ${path}`).toBeUndefined();
    }
  });
});

test("the player's file and directory locations are not printed", async ({ page }) => {
  // Regression: 9ba17bfb5.  config.php's paths (media, config, plugin and
  // fpp directories, the channel output files ...) went to every page.
  const s = await jsSettings(page, '/index.php');
  for (const k of ['mediaDirectory', 'configDirectory', 'pluginDirectory', 'fppDir', 'fppBinDir', 'wwwDir',
    'sequenceDirectory', 'logDirectory', 'channelOutputsJSON', 'statsFile']) {
    expect(s[k], `${k} printed`).toBeUndefined();
  }
});

test("the audio card type is not printed, and the status page still gets the volume", async ({ page }) => {
  // Regression: f40b4ad03.  AudioCardType and AudioCard0Type, which fppd
  // records for itself, went to every page.  volume is declared for the status
  // page, whose volume control reads it.
  await keepingSettings(async () => {
    setSettingInFile('AudioCardType', 'fpp-tests-card');
    setSettingInFile('AudioCard0Type', 'fpp-tests-card0');
    setSettingInFile('volume', '61');
    const s = await jsSettings(page, '/index.php');
    expect(s.AudioCardType).toBeUndefined();
    expect(s.AudioCard0Type).toBeUndefined();
    expect(s.volume).toBe('61');
  });
});

test('what every page reads about the player is still printed on every page', async ({ page }) => {
  // c77e0c17c and f211108eb declared these with "all" (Platform, Variant,
  // Logo, hideExternalURLs, locale ...).  Undeclared they were printed
  // everywhere anyway, so this holds on their parents too; it is here so that
  // declaring the rest, as 6f26c45c4 intends, can't drop what the header,
  // menus and fpp.js read on every page.
  for (const path of PAGES) {
    const s = await jsSettings(page, path);
    for (const k of ['Platform', 'Variant', 'SubPlatform', 'OSImagePrefix', 'IsDesktop', 'BeaglePlatform',
      'Logo', 'LogoLink', 'hideExternalURLs', 'locale', 'initialSetup-02', 'uiLevel', 'TimeFormat', 'Locale']) {
      expect(s, `${k} missing on ${path}`).toHaveProperty([k]);
    }
  }
});

function system(address: string, hostname: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: `M1-${hostname}`,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test("the MultiSync page gets its subnet filters and hides those systems", async ({ page }) => {
  // Regression: 6213df2c2.  Once declared, MultiSyncHide10/172/192 were
  // printed on no page, so "Hide 10.x.x.x/8 Subnets" hid nothing.  The
  // systems list is the test's.
  await keepingSettings(async () => {
    setSettingInFile('MultiSyncHide10', '1');
    setSettingInFile('MultiSyncHide172', '1');
    await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
      system('192.0.2.1', 'fpptests-local', 1),
      system('10.1.2.3', 'fpptests-ten'),
      system('172.20.1.2', 'fpptests-oneseventwo'),
      system('192.0.2.9', 'fpptests-shown'),
    ] } }));
    await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
    await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
    const s = await jsSettings(page, '/multisync.php');
    expect(s.MultiSyncHide10).toBe('1');
    const rows = page.locator('#fppSystems tr.systemRow');
    await expect(rows.filter({ hasText: 'fpptests-shown' })).toHaveCount(1, { timeout: 15_000 });
    await expect(rows.filter({ hasText: 'fpptests-ten' }), 'the 10.x system is listed').toHaveCount(0);
    await expect(rows.filter({ hasText: 'fpptests-oneseventwo' }), 'the 172.16/12 system is listed').toHaveCount(0);
  });
});

test("a stored value with '=' in it reaches PHP and the page whole", async ({ page }) => {
  // Regression: b7b3b42c1.  config.php split each settings line on every
  // '=', so a value was cut at its first one: "ab=cd==" came back as "ab",
  // in $settings (which the settings pages print into their fields) and in
  // the page's script.
  await keepingSettings(async () => {
    setSettingInFile('MQTTPassword', 'fpp=tests==');
    setSettingInFile('fppTestsEquals', 'a=b=c');
    expect((await jsSettings(page, '/index.php')).fppTestsEquals).toBe('a=b=c');
    // The MQTT tab prints the stored password into its field from $settings.
    await page.goto('/settings-mqtt.php');
    await expect(page.locator('#MQTTPassword')).toHaveValue('fpp=tests==');
  });
});

// ---- What the lockdown missed until 2fac94d9d and c8f0e8300.

test('an undeclared credential is printed into no page', async ({ page }) => {
  // Regression: 2fac94d9d.  emailgpass and secret are credentials (GET
  // /api/settings leaves them out since 4cdd77ac8, and backups redact them),
  // but they are not declared in settings.json, and config.php printed every
  // undeclared setting into every page's script ("Needs proper definition in
  // JSON"), so both reached every page.  IsSecretSetting() now keeps them out.
  await keepingSettings(async () => {
    setSettingInFile('emailgpass', 'fpp-tests-secret-gpass');
    setSettingInFile('secret', 'fpp-tests-secret-secret');
    const s = await jsSettings(page, '/index.php');
    expect(s.emailgpass).toBeUndefined();
    expect(s.secret).toBeUndefined();
  });
});

test("the Backup page's settings array carries no password", async ({ page }) => {
  // Regression: 2fac94d9d.  backup.php printed its own settings array, a
  // loop over all of $settings that 6f26c45c4's lockdown never reached:
  // every password setting, the OS login password of the sudo-capable fpp
  // user among them -- which no settings page prints -- was in the Backup
  // page's script.  It now prints the same array as every page.
  await keepingSettings(async () => {
    for (const k of CREDENTIALS) setSettingInFile(k, `fpp-tests-secret-${k}`);
    const s = await jsSettings(page, '/backup.php');
    for (const k of CREDENTIALS) expect(s[k], `${k} printed on the Backup page`).toBeUndefined();
  });
});

test('the status page gets playlistAutoScroll', async ({ page }) => {
  // Regression: c8f0e8300.  playlistAutoScroll's exposedAsJSToPages was
  // ["index, all"] -- one page named "index, all" -- so it was printed
  // nowhere, and
  // UpdateCurrentEntryPlaying() (fpp.js), which scrolls the status page's
  // playlist to the playing entry when settings['playlistAutoScroll'] > 0,
  // never scrolled.  Since 2dd12eda2.
  await keepingSettings(async () => {
    setSettingInFile('playlistAutoScroll', '1');
    expect((await jsSettings(page, '/index.php')).playlistAutoScroll).toBe('1');
  });
});

// Every page drawn with the menu (common/menuHead.inc), and the Settings
// page's tabs, which it loads on its own.
function allPages(): string[] {
  return inPlayer('sh', '-c', 'cd /opt/fpp/www && grep -l menuHead.inc *.php; ls settings-*.php')
    .split('\n').filter((l) => l.endsWith('.php')).map((l) => `/${l}`);
}

// A distinctive value in every password setting settings.json declares, and
// in the two undeclared credentials.
function plantSecrets(): Record<string, string> {
  const keys = JSON.parse(inPlayer('php', '-r',
    '$d = json_decode(file_get_contents("/opt/fpp/www/settings.json"), true); $k = array();' +
    'foreach ($d["settings"] as $n => $s) { if (($s["type"] ?? "") === "password") { $k[] = $n; } } echo json_encode($k);'));
  expect(keys, 'the control: settings.json declares the passwords').toEqual(expect.arrayContaining(['osPassword', 'gitHubPAT']));
  const planted: Record<string, string> = {};
  for (const k of [...keys, 'emailgpass', 'secret']) {
    planted[k] = `fppTestsPlant${k}Z`;
    setSettingInFile(k, planted[k]);
  }
  return planted;
}

// A password field the page draws carries the stored value (the settings
// pages print these server-side; see the test after next).
function withoutPasswordFieldValues(html: string): string {
  return html.replace(/<input type='password'[^>]*>/g, '<input type=\'password\'>');
}

test('no stored password or token appears in any page as served, outside its own password field', async ({ request }) => {
  // Regression: 2fac94d9d -- see the two tests above; this one reads every
  // page's served HTML, the Backup and setup pages included, scripts and all.
  test.setTimeout(240_000);
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '3');
    const planted = plantSecrets();
    const pages = allPages();
    expect(pages, 'the control: the page list').toEqual(expect.arrayContaining(['/index.php', '/backup.php', '/initialSetup.php', '/settings-mqtt.php']));
    const leaks: string[] = [];
    for (const path of pages) {
      const r = await request.get(path, { timeout: 60_000 });
      const html = withoutPasswordFieldValues(await r.text());
      if (['/index.php', '/backup.php', '/initialSetup.php'].includes(path)) {
        expect(html, `the control: ${path} has its settings script`).toContain('settings["fppMode"]');
      }
      for (const [k, v] of Object.entries(planted)) if (html.includes(v)) leaks.push(`${k} in ${path}`);
    }
    expect(leaks).toEqual([]);
  });
});

// Where a stored secret may be in a page as served: only as the value of its
// own password field, on the page that edits it.  The settings pages print
// those fields with the stored value (the design 4cdd77ac8 relied on for the
// API); if they stop, entries come off this list.
const PREFILLED: Record<string, string[]> = {
  password: ['/initialSetup.php', '/settings-ui.php'],
  passwordVerify: ['/initialSetup.php', '/settings-ui.php'],
  TetherPSK: ['/networkconfig.php'],
  MQTTPassword: ['/settings-mqtt.php'],
  emailpass: ['/settings-email.php'],
  gitHubPAT: ['/settings-developer.php'],
};

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('a stored secret is in a page only as the value of its own password field, on its own settings page', async ({ request }) => {
  // Regression: 2fac94d9d, as the test before; this one also pins where the
  // pre-filled password fields are, so a secret anywhere else is caught.
  test.setTimeout(240_000);
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '3');
    const planted = plantSecrets();
    const leaks: string[] = [];
    const prefilled: string[] = [];
    for (const path of allPages()) {
      const html = await (await request.get(path, { timeout: 60_000 })).text();
      for (const [k, v] of Object.entries(planted)) {
        const all = count(html, v);
        if (all === 0) continue;
        const field = new RegExp(`<input type='password' id='${k}'[^>]*value="${v}"`, 'g');
        const inField = (html.match(field) ?? []).length;
        const allowed = (PREFILLED[k] ?? []).includes(path) ? inField : 0;
        if (all > allowed) leaks.push(`${k} in ${path} (${all - allowed} outside its field)`);
        if (allowed) prefilled.push(`${k} ${path}`);
      }
    }
    expect(leaks).toEqual([]);
    // The control: the settings pages do print the fields this list allows.
    expect(prefilled).toEqual(expect.arrayContaining(['MQTTPassword /settings-mqtt.php', 'gitHubPAT /settings-developer.php']));
  });
});
