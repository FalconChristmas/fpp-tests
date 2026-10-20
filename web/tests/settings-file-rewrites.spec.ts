import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Rewriting the settings file must keep what is in it and add nothing.
//
// A line with no '=' (a hand-written '#' note, a stray line) was read as a
// key with no value, and the next save wrote it back as `<line> = ""`, a
// setting that was carried into backups from then on.  Fixed in fpp
// c0f5ae635 ("fix(settings): a line with no '=' is not a setting").
//
// DeleteSettingFromFile() re-read the file with PHP's parse_ini_file(), which
// strips every embedded '"', so a JSON value (privacyConsent, for one) was
// written back as {a:b} over the good value.  Reset Config's audio backend
// area deletes settings that way.  Fixed in fpp ca1181176 ("fix(settings):
// keep JSON values intact when DeleteSettingFromFile() rewrites").

const SETTINGS = '/home/fpp/media/settings';
const SAVED = '/tmp/fpp-tests-settings.saved';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');
test.beforeEach(() => inPlayer('cp', '-p', SETTINGS, SAVED));
test.afterEach(() => inPlayer('sh', '-c', `cp -p ${SAVED} ${SETTINGS} && rm -f ${SAVED}`));

const lines = () => inPlayer('cat', SETTINGS).split('\n');
const append = (text: string) => inPlayer('sh', '-c', `printf '%s\\n' '${text}' >> ${SETTINGS}`);

test('a line with no "=" is not written back as a setting', async ({ request }) => {
  append('# fpp-tests hand-written note');
  const r = await request.put('/api/settings/HostDescription?skipApply=1', { data: 'fpp-tests rewrite' });
  expect(r.ok(), await r.text()).toBe(true);
  // The control: the save rewrote the file.
  expect(lines()).toContain('HostDescription = "fpp-tests rewrite"');
  expect(lines().filter((l) => l.includes('fpp-tests hand-written note')),
    'the stray line came back as a setting').not.toContainEqual(expect.stringContaining('='));
  expect((await (await request.get('/api/settings')).text())).not.toContain('fpp-tests hand-written note');
});

test('deleting a setting keeps another setting\'s JSON value intact', async ({ request }) => {
  const json = 'fppTestsJson = {"name":"a b","on":true,"list":["x","y"]}';
  append(json);
  append('PipeWireSinkName_5 = "fpp-tests-sink"');
  // Reset Config's audio backend area deletes PipeWireSinkName_5, among others.
  const r = await request.get('/resetConfig.php?areas=audiobackend');
  expect(r.ok()).toBe(true);
  // The control: the deletion rewrote the file.
  expect(lines().filter((l) => l.startsWith('PipeWireSinkName_5 '))).toEqual([]);
  expect(lines().filter((l) => l.startsWith('fppTestsJson ')), 'the JSON value was rewritten').toEqual([json]);
});
