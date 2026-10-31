import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, php, setSettingInFile } from './privacy-helpers';
import { readFile, SETTINGS } from './settings-file';

// www/common.php's shared helpers -- the settings reader and the setting
// widgets plugins build their pages from, the file-size labels, the www
// file cache and the remote-version check -- run in the player as the pages
// and the API run them.

test.skip(!container, 'runs PHP inside the run-web.sh container');

test.describe('file sizes', () => {
  const SYSLOG = '/var/log/syslog.fpp-tests';
  const MUSIC = '/home/fpp/media/music';
  test.afterEach(() => {
    inPlayer('rm', '-f', SYSLOG, `${MUSIC}/fpp-tests-size-1.mp3`, `${MUSIC}/fpp-tests-size-2.mp3`, `${MUSIC}/fpp-tests-size-3.mp3`);
  });

  test("a system log's size is read as bytes under a kilobyte, and kB above", async ({ request }) => {
    // Regression: 202f211b8.  du's answer kept its newline, which both made
    // PHP warn ("non well formed numeric value") and was counted as a digit:
    // a 500-byte log read "0.49kB".
    // Regression: 6e9668aad.  Sizes read "1.50KB" where every other listing
    // says "kB".  The listing is the Logs tab's, where the system logs are
    // the files sized this way (human_filesize()).
    const size = async (bytes: number) => {
      inPlayer('sh', '-c', `head -c ${bytes} /dev/zero > ${SYSLOG}`);
      const files = (await (await request.get('/api/files/Logs')).json()).files as Array<{ name: string; sizeHuman: string }>;
      return files.find((f) => f.name.endsWith('syslog.fpp-tests'))?.sizeHuman;
    };
    expect(await size(1536)).toBe('1.50kB');
    expect(await size(500)).toBe('500.00B');
  });

  test('a media listing reads its sizes in B, kB and MB', async ({ request }) => {
    // humanFileSize() (48658c5d2), which sizes every other listing.
    inPlayer('sh', '-c', `: > ${MUSIC}/fpp-tests-size-1.mp3; head -c 1536 /dev/zero > ${MUSIC}/fpp-tests-size-2.mp3; head -c 2097152 /dev/zero > ${MUSIC}/fpp-tests-size-3.mp3`);
    const files = (await (await request.get('/api/files/Music')).json()).files as Array<{ name: string; sizeHuman: string }>;
    const sizes = Object.fromEntries(files.filter((f) => f.name.startsWith('fpp-tests-size-')).map((f) => [f.name, f.sizeHuman]));
    expect(sizes).toEqual({ 'fpp-tests-size-1.mp3': '0B', 'fpp-tests-size-2.mp3': '1.50kB', 'fpp-tests-size-3.mp3': '2.00MB' });
  });
});

test('a JSON setting whose value has spaces in it can have a part of it updated', async ({ request }) => {
  // Regression: 3dda9b01a.  ReadSettingFromFile() took a value only up to
  // its first space, so jsonValueUpdate read '{"description":' back, found
  // it no JSON object, and refused every update of the setting.
  await keepingSettings(async () => {
    setSettingInFile('fppTestsJsonSpaces', '{"description": "two words", "count": 1}');
    const r = await request.put('/api/settings/fppTestsJsonSpaces/jsonValueUpdate', { data: '{"count": 2}', headers: { 'Content-Type': 'text/plain' } });
    expect((await r.json()).status).toBe('OK');
    const line = readFile(SETTINGS).split('\n').find((l) => l.startsWith('fppTestsJsonSpaces'))!;
    expect(JSON.parse(line.replace(/^[^=]*=\s*/, '').replace(/^"|"$/g, '').replace(/\\"/g, '"'))).toEqual({ description: 'two words', count: 2 });
  });
});

test.describe('the setting widgets', () => {
  test("a plugin's text setting shows the plugin's value, not FPP's setting of the same name", () => {
    // Regression: a56ac0e5a.  PrintSettingText() and PrintSettingTextSaved()
    // looked in FPP's own settings first, so a plugin setting named like one
    // of FPP's (HostName, say) showed FPP's value in the plugin's page.
    const out = php(`
$settings['HostName'] = 'fpp-value';
$pluginSettings['HostName'] = 'plugin-value';
PrintSettingText('HostName', 0, 0, 32, 32, 'fpp-tests-plugin');
echo "\\n---\\n";
PrintSettingTextSaved('HostName', 0, 0, 32, 32, 'fpp-tests-plugin');
echo "\\n---\\n";
PrintSettingTextSaved('HostName', 0, 0, 32, 32);
`);
    const [text, saved, own] = out.split('\n---\n');
    expect(text).toContain('value="plugin-value"');
    expect(saved).toContain('value="plugin-value"');
    // The control: FPP's own page still shows FPP's value.
    expect(own).toContain('value="fpp-value"');
  });

  test("a setting's change callback is told which setting changed", () => {
    // Regression: 38dd28b51.  The callback was called with no arguments, so
    // one callback shared by several settings could not tell them apart.
    const out = php(`
PrintSettingSelect('Test', 'fppTestsSelect', 0, 0, 'a', array('A' => 'a', 'B' => 'b'), '', 'fppTestsCallback');
PrintSettingTextSaved('fppTestsText', 0, 0, 32, 32, '', '', 'fppTestsCallback');
`);
    expect(out).toContain("fppTestsCallback('fppTestsSelect');");
    expect(out).toContain("fppTestsCallback('fppTestsText');");
  });

  test("a setting's description can name the classes of its label and field columns", () => {
    // Regression: 0c3312104.  PrintSetting() always used the default column
    // classes; labelClass and fieldClass let a setting lay itself out.
    const out = php(`
$settingInfos['fppTestsClassed'] = array('name' => 'fppTestsClassed', 'description' => 'Classed', 'type' => 'text', 'labelClass' => 'col-6 fpp-tests-label', 'fieldClass' => 'col-6 fpp-tests-field');
$settingInfos['fppTestsPlain'] = array('name' => 'fppTestsPlain', 'description' => 'Plain', 'type' => 'text');
PrintSetting('fppTestsClassed');
echo "\\n---\\n";
PrintSetting('fppTestsPlain');
`);
    const [classed, plain] = out.split('\n---\n');
    expect(classed).toContain("class='printSettingLabelCol col-6 fpp-tests-label'");
    expect(classed).toContain("class='printSettingFieldCol col-6 fpp-tests-field'");
    // The control: a setting that names none gets the defaults.
    expect(plain).toContain("class='printSettingLabelCol col-md-4 col-lg-3 col-xxxl-2'");
    expect(plain).toContain("class='printSettingFieldCol col-md'");
  });
});

test('an expired cached value is served stale while another request is recalculating it', () => {
  // Regression: fc558ffc4.  A request that found the cache expired waited
  // for the lock of the one recalculating it, then recalculated it again
  // itself: every page asking for, say, the remote version stalled behind a
  // slow lookup.  Now it only tries the lock, and takes the old value while
  // another request holds it.
  const CACHE = '/tmp/cache_fppTestsGrace.cache';
  // Past file_cache()'s default 90s cache time and 10s grace.
  inPlayer('sh', '-c', `rm -f ${CACHE} ${CACHE}_recalc; printf old > ${CACHE}; touch -d '@'$(($(date +%s) - 200)) ${CACHE}`);
  // Another request, mid-recalculation: it holds the lock for 6 seconds.
  inPlayer('sh', '-c', `setsid flock -o ${CACHE}_recalc sleep 6 > /dev/null 2>&1 < /dev/null & sleep 0.5`);
  try {
    const fetch = () => JSON.parse(php(`
$t = microtime(true);
$v = file_cache('fppTestsGrace', function () { return 'new'; });
echo json_encode(array($v, microtime(true) - $t));
`)) as [string, number];
    const [value, seconds] = fetch();
    expect(value, 'it waited for the other request and recalculated').toBe('old');
    expect(seconds).toBeLessThan(2);
    // The control: with nobody else recalculating, it does recalculate.
    inPlayer('sh', '-c', 'pkill -x flock; true');
    expect(fetch()[0]).toBe('new');
  } finally {
    inPlayer('sh', '-c', `pkill -x flock; rm -f ${CACHE} ${CACHE}_recalc; true`);
  }
});

test("the remote version is the head of this build's own branch", () => {
  // Regression: 912dfc6d0.  The lookup ran in a closure that never got the
  // branch, so it asked the remote for every branch's head and took the
  // last one listed.  The checkout here is a scratch clone (no upstream set)
  // whose origin has this build's branch and another that sorts after it.
  const GIT = '/tmp/fpp-tests-gitver';
  const branch = php('echo getFPPBranch();').trim();
  const cache = `/tmp/cache_git_${branch}.cache`;
  // A failed check holds off the next for a minute (see get_remote_git_version()).
  const failed = `/tmp/cache_git_${branch}.failed`;
  inPlayer('sh', '-c', `set -e; rm -rf ${GIT}; mkdir -p ${GIT}; cd ${GIT}
git init -q --bare origin.git
git init -q -b '${branch}' work; cd work
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
git push -q ../origin.git HEAD:refs/heads/'${branch}'
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
git push -q ../origin.git HEAD:refs/heads/zzz-fpp-tests-other
cd ..; git clone -q -b '${branch}' origin.git clone; cd clone; git branch -q --unset-upstream`);
  const own = inPlayer('git', `--git-dir=${GIT}/origin.git`, 'rev-parse', `refs/heads/${branch}`).trim().slice(0, 9);
  try {
    inPlayer('sh', '-c', `mv -f ${cache} ${cache}.fpp-tests 2>/dev/null; mv -f ${failed} ${failed}.fpp-tests 2>/dev/null; true`);
    const got = php(`
$settings['fppDir'] = '${GIT}/clone';
$settings['UpgradeSource'] = 'fpp-tests.invalid';
echo get_remote_git_version();
`).trim();
    expect(got, 'another branch\'s head').toBe(own);
  } finally {
    inPlayer('sh', '-c', `rm -rf ${GIT} ${cache} ${failed}; mv -f ${cache}.fpp-tests ${cache} 2>/dev/null; mv -f ${failed}.fpp-tests ${failed} 2>/dev/null; true`);
  }
});
