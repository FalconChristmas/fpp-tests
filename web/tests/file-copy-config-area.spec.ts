import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, putFile, snapshotSettings, settingInFile } from './settings-file';

// A File Copy restore of Configuration by settings area (#3157): the same
// areas as the JSON settings restore (Show Setup -> schedule, Channel Outputs,
// Network ...), with its Keep Network / Keep Player-Remote choices, from any
// File Copy backup with Configuration in it.  copystorage.php has the copy
// script stage the backup's settings files (its "Stage"), and backup.php reads
// the chosen area from the stage and restores it as doRestore() restores one
// from a JSON backup.  Fixed by 701370118 (171045dc0 reads the folder).
//
// The image has no rsync.  The stand-in below logs how it was called and, for
// the stage only, copies what the real filter takes (settings, config/ without
// its backups/, playlists/, scripts/).  The device scenario
// test_file_copy_remote.py runs the real rsync for the stage.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-rsync-stage-stub';
const RSYNC = '/usr/local/bin/rsync';
const LOG = '/tmp/fpp-tests-rsync-stage.log';
const FOLDER = 'fpp-tests-filecopy-area';
const SOURCE = `${MEDIA}/backups/${FOLDER}`;
// Each run stages into its own tmp/filecopy-stage-<id>/.
const STAGES = `${MEDIA}/tmp/filecopy-stage*`;
const FAIL = '/tmp/fpp-tests-rsync-stage-fail';
const ENTRY = 'fpp-tests-filecopy-area-entry';

const STUB = `#!/bin/sh
# ${MARK}
echo "rsync $*" >> ${LOG}
src=; dst=
for a in "$@"; do src=$dst; dst=$a; done
case "$dst" in
  */tmp/filecopy-stage*/)
    [ -e ${FAIL} ] && exit 23
    for f in settings config playlists scripts; do [ -e "$src$f" ] && cp -a "$src$f" "$dst"; done
    rm -rf "\${dst}config/backups" ;;
esac
exit 0
`;

test.beforeEach(() => {
  const real = inPlayer('sh', '-c', `test -e ${RSYNC} && ! grep -q ${MARK} ${RSYNC} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${RSYNC} is a real program in the player; not replacing it`);
  putFile(RSYNC, STUB);
  inPlayer('sh', '-c', `chmod 755 ${RSYNC} && : > ${LOG} && chmod 666 ${LOG} && rm -rf ${SOURCE} && mkdir -p ${SOURCE}/config`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${RSYNC} 2>/dev/null && rm -f ${RSYNC}; rm -rf ${LOG} ${FAIL} ${SOURCE} ${STAGES} /fpp_restored; true`);
});

test('a File Copy restore offers Configuration by settings area, with the keep choices', async ({ page }) => {
  // Ticking Configuration saves it as a setting; put the file back after.
  const restoreSettings = snapshotSettings();
  try {
    await offersAreas(page);
  } finally {
    restoreSettings();
  }
});

async function offersAreas(page: Page) {
  inPlayer('sh', '-c', `cp ${MEDIA}/settings ${SOURCE}/settings`);
  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  const row = page.locator('tr.copyConfigArea');
  const configuration = page.locator('#backup\\.Configuration');
  await configuration.check();
  // A backup has nothing to choose: the choice is the restore's.
  await expect(row).toBeHidden();
  await page.locator('#backup\\.Direction').selectOption('FROMLOCAL');
  await expect(row).toBeVisible();
  // ...and only a restore of Configuration.
  await configuration.uncheck();
  await expect(row).toBeHidden();
  await configuration.check();
  await expect(row).toBeVisible();
  // ...and hidden again for a backup, with Configuration still ticked.
  await page.locator('#backup\\.Direction').selectOption('TOLOCAL');
  await expect(row).toBeHidden();
  await page.locator('#backup\\.Direction').selectOption('FROMLOCAL');
  await expect(row).toBeVisible();

  const area = page.locator('#backup\\.ConfigArea');
  await expect(area).toHaveValue('everything');
  await expect(area.locator('option[value="show_setup/schedule"]')).toHaveCount(1);
  await expect(area.locator('option[value="network"]')).toHaveCount(1);
  // Plugin Settings restores every plugin's, so no plugin is offered alone;
  // the Virtual EEPROM box restores the EEPROM.
  await expect(area.locator('option[value="plugins"]')).toHaveCount(1);
  await expect(area.locator('option[value^="plugins/"]')).toHaveCount(0);
  await expect(area.locator('option[value^="virtualEEPROM"]')).toHaveCount(0);
  // ...nor what a backup folder can't hold or need not have.
  await expect(area.locator('option[value="settings/timezone"]')).toHaveCount(0);
  await expect(area.locator('option[value^="network/interface."]')).toHaveCount(0);
  const keep = page.locator('.copyConfigAreaKeep');
  await expect(keep).toBeHidden();
  await area.selectOption('show_setup/schedule');
  await expect(keep).toBeVisible();

  // What Copy asks copystorage.php for.  The boxes are settings, so they are
  // set without a change event, which would save them.
  await expect(page.locator(`#backup\\.PathSelect option[value="${FOLDER}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.locator('#backup\\.PathSelect').selectOption(FOLDER);
  await page.evaluate(() => {
    document.querySelectorAll<HTMLInputElement>('#CopyFlagsTable input[type=checkbox]').forEach((b) => { b.checked = false; });
    (document.getElementById('backup.Configuration') as HTMLInputElement).checked = true;
    (document.getElementById('backup.KeepNetwork') as HTMLInputElement).checked = false;
  });
  let asked = '';
  // A regex: the query holds slashes (storageLocation), which a glob's * doesn't cross.
  await page.route(/\/copystorage\.php\?/, async (route) => {
    asked = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'BACKUP COMPLETE\n' });
  });
  page.once('dialog', (d) => d.accept());
  await expect(page.locator('#backupCopyBtn')).toBeEnabled({ timeout: 15_000 });
  await page.locator('#backupCopyBtn').click();
  await expect.poll(() => asked).not.toBe('');
  const url = new URL(asked);
  expect(url.searchParams.get('direction')).toBe('FROMLOCAL');
  expect(url.searchParams.get('flags')).toBe('Configuration');
  expect(url.searchParams.get('configArea')).toBe('show_setup/schedule');
  expect(url.searchParams.get('keepNetwork')).toBe('no');
  expect(url.searchParams.get('keepPlayerRemote')).toBe('yes');
}

const fppdEntries = async (request: APIRequestContext) =>
  ((await (await request.get('/api/fppd/schedule')).json()).schedule?.entries ?? [])
    .map((e: { playlist: string }) => e.playlist);

test('a File Copy restore of one settings area restores that area alone, and fppd runs the restored schedule', async ({ request }) => {
  // Regression: #3157.  File Copy restored all of Configuration or none of
  // it, so getting the schedule back meant taking the other player's
  // settings, hostname and network with it.
  const restoreSettings = snapshotSettings();
  const before = await (await request.get('/api/schedule')).json();
  const hostname = settingInFile('HostName');
  try {
    // The backup: this player's schedule with one more (disabled) entry, and
    // another player's settings file.
    expect((await request.post('/api/schedule', {
      data: [...before, { enabled: 0, day: 7, playlist: ENTRY, startTime: '10:00:00', endTime: '11:00:00',
        startDate: '2099-01-01', endDate: '2099-01-02', repeat: 0, stopType: 0 }],
    })).ok()).toBe(true);
    inPlayer('sh', '-c', `cp ${MEDIA}/config/schedule.json ${SOURCE}/config/schedule.json && ` +
      `sed 's/^HostName *=.*/HostName = "fpp-tests-elsewhere"/' ${MEDIA}/settings > ${SOURCE}/settings`);
    expect((await request.post('/api/schedule', { data: before })).ok()).toBe(true);
    expect(inPlayer('cat', `${MEDIA}/config/schedule.json`)).not.toContain(ENTRY);
    expect(await fppdEntries(request), 'the control: fppd runs the schedule without the entry').not.toContain(ENTRY);

    const r = await request.get(`/copystorage.php?wrapped=1&direction=FROMLOCAL&path=${FOLDER}` +
      '&flags=Configuration&configArea=show_setup%2Fschedule&keepNetwork=yes&keepPlayerRemote=yes' +
      '&storageLocation=none&remoteStorage=none&delete=no&compress=no', { timeout: 120_000 });
    const out = await r.text();
    expect(r.ok(), out.slice(-1500)).toBe(true);
    expect(out, out.slice(-1500)).toContain('show_setup/schedule: restored');
    expect(out).toContain('BACKUP COMPLETE');
    expect(out).not.toContain('BACKUP FAILED');

    expect(inPlayer('cat', `${MEDIA}/config/schedule.json`), 'the schedule was not restored').toContain(ENTRY);
    await expect.poll(() => fppdEntries(request), { message: 'the schedule fppd runs after the restore', timeout: 10_000 })
      .toContain(ENTRY);
    // That area alone: the other player's settings stayed in the backup.
    expect(settingInFile('HostName')).toBe(hostname);
    expect(stagesLeft(), 'the stage was left behind').toBe('');
  } finally {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    restoreSettings();
  }
});

const stagesLeft = () => inPlayer('sh', '-c', `ls -d ${STAGES} 2>/dev/null || true`).trim();

const areaRestore = async (request: APIRequestContext, query: string) => {
  const r = await request.get(`/copystorage.php?wrapped=1&direction=FROMLOCAL&path=${FOLDER}&flags=Configuration` +
    `&${query}&storageLocation=none&remoteStorage=none&delete=no&compress=no`, { timeout: 120_000 });
  const out = await r.text();
  expect(r.ok(), out.slice(-1500)).toBe(true);
  return out;
};

test('a restore of Network that keeps this player\'s network restores nothing, and says so rather than failing', async ({ request }) => {
  const restoreSettings = snapshotSettings();
  try {
    inPlayer('sh', '-c', `cp ${MEDIA}/settings ${SOURCE}/settings && printf 'INTERFACE=eth0\\nPROTO=dhcp\\n' > ${SOURCE}/config/interface.eth0`);
    const out = await areaRestore(request, 'configArea=network&keepNetwork=yes&keepPlayerRemote=yes');
    expect(out, out.slice(-1500)).toContain("Nothing restored: this player's network settings were kept");
    expect(out).toContain('BACKUP COMPLETE');
    expect(out).not.toContain('BACKUP FAILED');
  } finally {
    restoreSettings();
  }
});

test('a settings area that is not one is refused before anything is copied', async ({ request }) => {
  // Regression: #3157 review.  Only the main area was checked, so a sub-area
  // that isn't one, a single plugin (Plugin Settings restores them all) or
  // the EEPROM went through and restored nothing or more than was asked.
  for (const area of ['nosucharea', 'all/<b>x</b>', '../settings', 'show_setup/bogus', 'plugins/fpp-test',
    'virtualEEPROM', 'virtualEEPROM/cape-eeprom.bin', 'outputProcessors/x', 'settings/timezone']) {
    const out = await areaRestore(request, `configArea=${encodeURIComponent(area)}`);
    expect(out, area).toContain('Invalid settings area');
    expect(out, area).not.toContain('copy_settings_to_storage.sh');
  }
  expect(inPlayer('cat', LOG).trim(), 'rsync ran').toBe('');
});

test('a restore of System Settings says what it restored', async ({ request }) => {
  // Regression: #3157 review.  The settings, plugins and network areas keep a
  // top-level SUCCESS (false) beside their sub-areas' results, and the report
  // took that for the area's own: a restore that worked said "Nothing
  // restored: the backup has nothing for that area".
  const restoreSettings = snapshotSettings();
  const presets = `${MEDIA}/config/commandPresets.json`;
  const saved = inPlayer('sh', '-c', `cat ${presets} 2>/dev/null || true`);
  const had = inPlayer('sh', '-c', `test -e ${presets} && echo yes || echo no`).trim() === 'yes';
  try {
    inPlayer('sh', '-c', `cp ${MEDIA}/settings ${SOURCE}/settings && ` +
      `echo '{"commands":[{"name":"fpp-tests-filecopy-preset","command":"Stop Now","args":[]}]}' > ${SOURCE}/config/commandPresets.json`);
    const out = await areaRestore(request, 'configArea=settings%2FcommandPresets&keepNetwork=yes&keepPlayerRemote=yes');
    expect(out, out.slice(-1500)).toContain('settings/commandPresets: restored');
    expect(out).not.toContain('Nothing restored');
    expect(out).toContain('BACKUP COMPLETE');
    expect(inPlayer('cat', presets)).toContain('fpp-tests-filecopy-preset');
  } finally {
    if (had) putFile(presets, saved); else inPlayer('rm', '-f', presets);
    restoreSettings();
  }
});

test('a restore of Network that does not keep this player\'s network says what it restored', async ({ request }) => {
  // Regression: #3157 review, as for System Settings above.
  const restoreSettings = snapshotSettings();
  const dns = `${MEDIA}/config/dns`;
  const saved = inPlayer('sh', '-c', `cat ${dns} 2>/dev/null || true`);
  const had = inPlayer('sh', '-c', `test -e ${dns} && echo yes || echo no`).trim() === 'yes';
  try {
    inPlayer('sh', '-c', `cp ${MEDIA}/settings ${SOURCE}/settings && printf 'DNS1=192.0.2.53\\n' > ${SOURCE}/config/dns`);
    // All of Network, from a backup with only its DNS: the interfaces it has
    // no config for were tried and had nothing to write, which is not a failure
    // (#3157 second review: they said FAILED).
    const out = await areaRestore(request, 'configArea=network&keepNetwork=no&keepPlayerRemote=yes');
    expect(out, out.slice(-1500)).toContain('network/dns: restored');
    expect(out).not.toContain('Nothing restored');
    expect(out).not.toContain('FAILED');
    expect(out).toContain('BACKUP COMPLETE');
    expect(inPlayer('cat', dns)).toContain('192.0.2.53');
  } finally {
    if (had) putFile(dns, saved); else inPlayer('rm', '-f', dns);
    restoreSettings();
  }
});

test('a stage that fails restores nothing, ends with one FAILED banner and leaves no stage', async ({ request }) => {
  const restoreSettings = snapshotSettings();
  const before = inPlayer('cat', `${MEDIA}/config/schedule.json`);
  try {
    inPlayer('sh', '-c', `cp ${MEDIA}/settings ${SOURCE}/settings && echo '[]' > ${SOURCE}/config/schedule.json && touch ${FAIL}`);
    const out = await areaRestore(request, 'configArea=show_setup%2Fschedule&keepNetwork=yes&keepPlayerRemote=yes');
    expect(out, out.slice(-1500)).toContain('BACKUP FAILED (rc=23)');
    expect(out.split('BACKUP FAILED').length - 1, 'one banner').toBe(1);
    expect(out).not.toContain('Restoring settings area');
    expect(out).not.toContain('BACKUP COMPLETE');
    expect(inPlayer('cat', `${MEDIA}/config/schedule.json`)).toBe(before);
    expect(stagesLeft(), 'the stage was left behind').toBe('');
  } finally {
    restoreSettings();
  }
});

test('an All settings areas restore leaves this player\'s cape EEPROM as it was', async ({ request }) => {
  // Regression: #3157 second review.  The stage leaves the backup's EEPROM out
  // (the Virtual EEPROM box restores it), and the missing file read as an empty
  // one, so restoring all the areas wrote an empty file over this player's.
  const restoreSettings = snapshotSettings();
  const eeprom = `${MEDIA}/config/cape-eeprom.bin`;
  const had = inPlayer('sh', '-c', `test -e ${eeprom} && echo yes || echo no`).trim() === 'yes';
  const before = had ? inPlayer('sh', '-c', `md5sum < ${eeprom}`) : '';
  try {
    if (!had) putFile(eeprom, 'FPP02fpp-tests eeprom');
    const sum = inPlayer('sh', '-c', `md5sum < ${eeprom}`);
    inPlayer('sh', '-c', `cp ${MEDIA}/settings ${SOURCE}/settings`);
    const out = await areaRestore(request, 'configArea=all&keepNetwork=yes&keepPlayerRemote=yes');
    expect(out, out.slice(-1500)).toContain('BACKUP COMPLETE');
    expect(out).not.toContain('virtualEEPROM');
    expect(inPlayer('sh', '-c', `md5sum < ${eeprom}`), 'the EEPROM was overwritten').toBe(sum);
  } finally {
    if (!had) inPlayer('rm', '-f', eeprom);
    else expect(inPlayer('sh', '-c', `md5sum < ${eeprom}`)).toBe(before);
    restoreSettings();
  }
});

test('a settings area is refused together with All', async ({ request }) => {
  // Regression: #3157 second review.  All copies the whole media directory,
  // the stage included, and with Delete extras removes it.
  const r = await request.get(`/copystorage.php?wrapped=1&direction=FROMLOCAL&path=${FOLDER}&flags=All%20Configuration` +
    '&configArea=show_setup%2Fschedule&storageLocation=none&remoteStorage=none&delete=yes&compress=no', { timeout: 120_000 });
  const out = await r.text();
  expect(out).toContain("A settings area can't be restored together with All");
  expect(inPlayer('cat', LOG).trim(), 'rsync ran').toBe('');
});
