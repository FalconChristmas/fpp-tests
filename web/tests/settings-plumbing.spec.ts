import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { SETTINGS, putFile, readFile, settingInFile, setSettingInFile, snapshotSettings } from './settings-file';

// The settings plumbing every page shares: fpp.js's SetSetting(), the
// PrintSetting*() helpers in common.php that render a setting's control, and
// WriteSettingToFile() behind PUT api/settings.

test.skip(!container, 'reads and seeds the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('a setting whose save reloads the page still records the restart it needs', async ({ page, request }) => {
  // Regression: e0a25d514.  SetSetting() ran the setting's callback first and
  // only then set restartFlag; for a "reloadUI" setting the callback reloads
  // the page.  Send MultiSync Packets (MultiSyncEnabled) is one: restart 2,
  // reloadUI 1, on Settings > Playback.
  setSettingInFile('MultiSyncEnabled', '0');
  setSettingInFile('restartFlag', '0');
  try {
    await page.goto('/settings.php?tab=Playback');
    const box = page.locator('#MultiSyncEnabled');
    await expect(box).not.toBeChecked({ timeout: 15_000 });
    const reloaded = page.waitForEvent('framenavigated', { timeout: 30_000 });
    await box.check();
    await reloaded;
    await page.waitForLoadState('load');
    // The control: the save went through and the page reloaded on it.
    await expect.poll(() => settingInFile('MultiSyncEnabled')).toBe('1');
    await expect.poll(() => settingInFile('restartFlag'), { timeout: 10_000 }).toBe('2');
    // The receiving end: the status the header reads asks for the restart, and
    // the reloaded page shows it.
    expect(String((await (await request.get('/api/system/status')).json()).restartFlag)).toBe('2');
    await expect(page.locator('#restartFlag')).toBeVisible({ timeout: 15_000 });
  } finally {
    // fppd was told it is on.
    await request.put('/api/settings/MultiSyncEnabled', { data: '0' });
  }
});

test("a setting's restart is recorded even when its save callback fails", async ({ page }) => {
  // Regression: e0a25d514.  The flags were set after the callback, so a
  // callback that reloads the page or throws ran first; one that throws left
  // the restart unrecorded.  (A reload, as in the test above, does not cancel
  // the synchronous flag save in Chromium, so this is the case that shows it
  // there.)
  setSettingInFile('restartFlag', '0');
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).SetSetting === 'function');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() => (window as any).SetSetting('fppTestsFlagSetting', 'x', 1, 0, true, null,
    () => { throw new Error('fpp-tests callback failed'); }));
  // The control: the save went through and the callback ran (and threw).
  await expect.poll(() => settingInFile('fppTestsFlagSetting')).toBe('x');
  await expect.poll(() => errors.join('\n')).toContain('fpp-tests callback failed');
  await expect.poll(() => settingInFile('restartFlag'), { timeout: 10_000 }).toBe('1');
  // The receiving end: the header shows the restart request.
  await expect(page.locator('#restartFlag')).toBeVisible();
});

test('a saved value the select no longer offers is replaced by the default, and fppd uses it', async ({ page, request }) => {
  // Feature: 82e7441b6.  A select whose saved value is not one of its
  // options showed the first option as if chosen while the old value stayed
  // in force.  PrintSettingSelect() now selects the default (or the first
  // option) and saves it.  Date Format is such a select, and fppd formats
  // the status page's date with it.
  // A value no release offers, as an older FPP or a hand edit could leave.
  expect((await request.put('/api/settings/DateFormat', { data: '%Y==%j' })).ok()).toBe(true);
  const dateStr = async () => String((await (await request.get('/api/fppd/status')).json()).dateStr ?? '');
  // The control: fppd is using it.
  await expect.poll(dateStr, { timeout: 15_000 }).toMatch(/^\d{4}==\d{3}$/);
  await page.goto('/settings.php?tab=Localization');
  await expect(page.locator('#DateFormat')).toHaveValue('%a %b %e', { timeout: 15_000 });
  await expect.poll(() => settingInFile('DateFormat'), { message: 'the unavailable value was left saved' }).toBe('%a %b %e');
  expect((await (await request.get('/api/settings/DateFormat')).json()).value).toBe('%a %b %e');
  // The receiving end: fppd's own status formats the date with the default
  // ("Thu Oct 29"), not "2026==302".
  await expect.poll(dateStr, { timeout: 15_000 }).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2}$/);
});

test('a JSON object saved through the API is stored as JSON and read back intact', async ({ request }) => {
  // Feature: c10796467 ("allow api for settings to accept json values"): a
  // JSON object value is written to the settings file as it is, not inside
  // another pair of quotes.
  const json = '{"name":"a b","on":true,"list":["x","y"]}';
  const r = await request.put('/api/settings/fppTestsJsonValue?skipApply=1', { data: json });
  expect(r.ok(), await r.text()).toBe(true);
  const lines = readFile(SETTINGS).split('\n').filter((l) => l.startsWith('fppTestsJsonValue '));
  expect(lines, 'the JSON value was quoted').toEqual([`fppTestsJsonValue = ${json}`]);
  // A plain value is still quoted.
  expect((await request.put('/api/settings/fppTestsPlainValue?skipApply=1', { data: 'a b' })).ok()).toBe(true);
  expect(readFile(SETTINGS).split('\n')).toContain('fppTestsPlainValue = "a b"');
  // The receiving end: the API (the same reader every page uses) answers
  // the object unchanged.
  const back = await (await request.get('/api/settings/fppTestsJsonValue')).json();
  expect(JSON.parse(back.value)).toEqual(JSON.parse(json));
});

test('the status page prints the host name as text', async ({ request }) => {
  // Regression: 1197a1b4d ("correctly escape printing of settings").  The
  // status page printed HostName into its heading raw.  A hand edit or a
  // restored backup can carry anything there (the API refuses it), and the
  // browser parses the markup as the page arrives, before the page's script
  // rewrites the heading.  (The <title> half of the fix is now done in
  // config.php, 9abdda210.)
  const name = 'fpp<img class=fpptestsinj src=x>';
  setSettingInFile('HostName', name);
  const html = await (await request.get('/index.php')).text();
  const span = /<span class="statusHostname">([^<]*(?:<(?!\/span>)[^<]*)*)<\/span>/.exec(html);
  expect(span, 'no host name in the heading').not.toBeNull();
  expect(span![1]).toBe('fpp&lt;img class=fpptestsinj src=x&gt;');
});

test("the status page's title shows the host name once escaped", async ({ page, request }) => {
  // Regression: fpp 2c5fc94c1.  config.php already escapes the host name
  // into $pageTitle, and index.php escaped it again: the tab title read
  // "FPP - fpp&lt;img ..." instead of the name.
  const name = 'fpp<img class=fpptestsinj src=x>';
  setSettingInFile('HostName', name);
  const html = await (await request.get('/index.php')).text();
  expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe('FPP - fpp&lt;img class=fpptestsinj src=x&gt;');
  // The receiving end: the browser's title is the name, as text.
  await page.goto('/index.php');
  await expect(page).toHaveTitle(`FPP - ${name}`);
});

// PrintSettingTextSaved() run by the tree's own common.php in the player, the
// way a plugin's page calls it.
const DRIVER = '/tmp/fpp-tests-print-setting-text.php';
const DRIVER_SRC = `<?php
// argv: identType ('' for the default), or "page" for two class-identified
// inputs with a format check, as the page would print them
chdir('/opt/fpp/www');
$skipJSsettings = 1;
require_once 'config.php';
require_once 'common.php';
$settings['fppTestsTextSetting'] = 'v';
ob_start();
if ($argv[1] === 'page') {
    $sData = array('regex' => '^[a-z]+$', 'regexDesc' => 'lower case letters');
    PrintSettingTextSaved('fppTestsTextSetting', 0, 0, 32, 32, '', '', '', '', 'text', $sData, 'class');
    PrintSettingTextSaved('fppTestsTextSetting', 0, 0, 32, 32, '', '', '', '', 'text', $sData, 'class');
    echo json_encode(ob_get_clean());
    exit;
}
if ($argv[1] === 'extras') {
    // Two class-identified inputs whose value decides a child row, and one
    // with its own change handler.
    $kids = array('children' => array('*' => array('fppTestsKid')));
    PrintSettingTextSaved('fppTestsParentSetting', 0, 0, 32, 32, '', '', '', '', 'text', $kids, 'class');
    PrintSettingTextSaved('fppTestsParentSetting', 0, 0, 32, 32, '', '', '', '', 'text', $kids, 'class');
    PrintSettingTextSaved('fppTestsCustomSetting', 0, 0, 32, 32, '', '', '', '', 'text', array('onChange' => 'fppTestsCustomChanged'), 'class');
    echo json_encode(ob_get_clean());
    exit;
}
if ($argv[1] === '') {
    PrintSettingTextSaved('fppTestsTextSetting', 0, 0, 32, 32);
} else {
    PrintSettingTextSaved('fppTestsTextSetting', 0, 0, 32, 32, '', '', '', '', 'text', array(), $argv[1]);
}
$html = ob_get_clean();
preg_match("/<input [^>]*>/s", $html, $m);
echo json_encode($m[0] ?? '');
`;

test('a text setting can be rendered identified by class instead of id', async () => {
  // Feature: 0775a4adc ("add ability to identify by class rather than id on
  // PrintSettingText").  A plugin page that prints the same setting more
  // than once passes identType "class" so the inputs do not share an id.
  putFile(DRIVER, DRIVER_SRC);
  try {
    const input = (ident: string) => JSON.parse(inPlayer('php', DRIVER, ident).trim().split('\n').pop()!) as string;
    const byClass = input('class');
    expect(byClass).toMatch(/class='mw-100 fppTestsTextSetting'/);
    expect(byClass, 'the input still carries the id').not.toMatch(/\bid=/);
    // The default is unchanged: an id, and no class named for the setting.
    const byId = input('');
    expect(byId).toMatch(/id='fppTestsTextSetting'/);
    expect(byId).not.toMatch(/mw-100 fppTestsTextSetting/);
  } finally {
    inPlayer('rm', '-f', DRIVER);
  }
});

test('a class-identified text setting saves the value of the input that changed', async ({ page }) => {
  // Regression: fpp 1105d4f9d.  The change handler read $('#<setting>'),
  // which a class-identified input doesn't have, so it saved "undefined";
  // and a value failing the format check was meant to put the cursor back
  // in the box, but .on("focus") only binds a handler, so nothing happened.
  // Also dd84b5b59: its deprecated-call rewrite turned the refocus into
  // .on("focus"), which is how it stopped working.
  putFile(DRIVER, DRIVER_SRC);
  try {
    const html = JSON.parse(inPlayer('php', DRIVER, 'page').trim().split('\n').pop()!) as string;
    await page.goto('/index.php');
    await page.waitForFunction(() => typeof (window as any).SetSetting === 'function');
    // jQuery runs the printed <script> as it inserts the markup.
    await page.evaluate((h) => (window as any).$('<div id="fppTestsHost"></div>').html(h).appendTo('body'), html);
    const inputs = page.locator('#fppTestsHost input.fppTestsTextSetting');
    await expect(inputs).toHaveCount(2);

    const saved = page.waitForResponse((r) => /\/api\/settings\/fppTestsTextSetting$/.test(r.url()) && r.request().method() === 'PUT');
    await inputs.nth(1).fill('second');
    await inputs.nth(1).dispatchEvent('change');
    expect((await saved).request().postData()).toBe('second');
    await expect.poll(() => settingInFile('fppTestsTextSetting')).toBe('second');

    // A value the format check refuses is not saved, and the box it was
    // typed in gets the focus back.
    await inputs.nth(0).evaluate((el) => {
      (window as any).fppTestsFocused = 0;
      el.addEventListener('focus', () => { (window as any).fppTestsFocused++; });
    });
    await inputs.nth(0).evaluate((el: HTMLInputElement) => { el.value = 'NOT OK'; el.dispatchEvent(new Event('change')); });
    await expect.poll(() => page.evaluate(() => (window as any).fppTestsFocused), { message: 'the refused box was not refocused' }).toBeGreaterThan(0);
    expect(settingInFile('fppTestsTextSetting')).toBe('second');
  } finally {
    inPlayer('rm', '-f', DRIVER);
  }
});

test("a class-identified text setting's child rows and custom change handler see its input", async ({ page }) => {
  // Regression: fpp 92dda4ffb.  1105d4f9d fixed only the default change
  // handler: the children check still read $('#<setting>'), which a
  // class-identified input doesn't have, so its child rows were shown
  // whatever the value; and a custom onChange (sData['onChange']) was called
  // with no element, so it couldn't tell which input changed.
  putFile(DRIVER, DRIVER_SRC);
  try {
    const html = JSON.parse(inPlayer('php', DRIVER, 'extras').trim().split('\n').pop()!) as string;
    await page.goto('/index.php');
    await page.waitForFunction(() => typeof (window as any).SetSetting === 'function');
    await page.evaluate((h) => {
      const w = window as any;
      // What a settings page provides: the shared hidden-children record, a
      // child setting's row, and the plugin's own handler.
      w.hiddenChildren = {};
      w.fppTestsCustomSeen = [];
      w.fppTestsCustomChanged = (el?: HTMLInputElement) => w.fppTestsCustomSeen.push(el ? el.value : '(no element)');
      w.$('<div id="fppTestsHost"><div id="fppTestsKidRow">child</div></div>').appendTo('body');
      w.$('#fppTestsHost').append(h);
    }, html);

    // The child row follows the parent's value: hidden while it's empty.
    const parents = page.locator('#fppTestsHost input.fppTestsParentSetting');
    await expect(parents).toHaveCount(2);
    const kid = page.locator('#fppTestsKidRow');
    await parents.nth(0).fill('');
    await page.evaluate(() => (window as any).UpdatefppTestsParentSettingChildren(0));
    // Soft, so the custom handler below is checked as well when this fails.
    await expect.soft(kid, 'the child row is shown for an empty parent').toBeHidden();
    await parents.nth(0).fill('set');
    await page.evaluate(() => (window as any).UpdatefppTestsParentSettingChildren(0));
    await expect(kid).toBeVisible();

    // The custom handler is given the input that changed.
    const custom = page.locator('#fppTestsHost input.fppTestsCustomSetting');
    await custom.fill('custom value');
    await custom.dispatchEvent('change');
    expect.soft(await page.evaluate(() => (window as any).fppTestsCustomSeen), 'the custom handler got no element').toEqual(['custom value']);
  } finally {
    inPlayer('rm', '-f', DRIVER);
  }
});
