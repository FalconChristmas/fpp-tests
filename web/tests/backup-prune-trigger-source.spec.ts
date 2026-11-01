import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS } from './settings-file';

// Backups made on behalf of a plugin (POST /api/backups/configuration with a
// trigger_source, as GET/PUT of /api/configfile does for a config file) are
// pruned to the newest 5 of each source, so a plugin that rewrites its
// settings often can't push the player's own backups out of the 60 kept.
// Feature: d3e6aa4ab ("Improvments to settings backup file maintenance for
// plugins").  The whole-box limit only applies once 60 backups exist, so the
// test fills the folder first.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SOURCE = 'fpp-tests-plugin-source';

// Regression: MakeJSONBackup() requires backup.php inside the function, and
// $fpp_backup_max_plugin_backups_key was missing from its `global` list, so the
// limit was null there and pruneOrRemoveAgedBackupFiles() treated every backup
// with a trigger source as over it.  Once 60 backups existed, each API backup
// deleted all of them, the one just made included, and still answered success.

test('a plugin source keeps only its newest 5 backups, while the rest are within the limit', async ({ request }) => {
  test.setTimeout(180_000);
  const now = Math.floor(Date.now() / 1000);
  // 61 backups with no source, older than anything else; then 12 from the
  // plugin, newer than those but older than the one made below.  All 73 plus
  // the new one are over 60, so the whole-box limit alone would drop only the
  // oldest of the others and keep every plugin backup.
  const script = [
    `cd ${BACKUPS}`,
    `i=0; while [ $i -lt 61 ]; do t=$((${now} - 100000 - i)); n=$(printf 'fpp-tests-other-backup_%014d.json' $t)`,
    `printf '{"fpp_backup_version":"8.0","backup_comment":"fpp-tests other","backup_trigger_source":null,"backup_taken":%d}' $t > $n; i=$((i+1)); done`,
    `i=0; while [ $i -lt 12 ]; do t=$((${now} - 1000 - i)); n=$(printf 'fpp-tests-plugin-backup_%014d.json' $t)`,
    `printf '{"fpp_backup_version":"8.0","backup_comment":"fpp-tests plugin","backup_trigger_source":"${SOURCE}","backup_taken":%d}' $t > $n; i=$((i+1)); done`,
  ].join('\n');
  inPlayer('sh', '-c', `mkdir -p ${BACKUPS}\n${script}`);
  try {
    const made = await (await request.post('/api/backups/configuration', {
      data: { backup_comment: 'fpp-tests plugin newest', trigger_source: SOURCE },
    })).json();
    expect(made.success, JSON.stringify(made)).toBe(true);
    const newest = String(made.backup_file_path).split('/').pop()!;

    const rows: Array<Record<string, any>> = await (await request.get('/api/backups/configuration/list')).json();
    const fromPlugin = rows.filter((b) => b.backup_trigger_source === SOURCE);
    expect(fromPlugin.map((b) => b.backup_filename), 'the plugin source was not cut to 5').toHaveLength(5);
    // The newest are the ones kept: the one just made, then the four newest seeded.
    expect(fromPlugin.map((b) => b.backup_filename)).toContain(newest);
    expect(rows.length, 'the whole-box limit of 60 no longer applies').toBeLessThanOrEqual(60);
  } finally {
    inPlayer('sh', '-c', `rm -f ${BACKUPS}/fpp-tests-other-backup_*.json ${BACKUPS}/fpp-tests-plugin-backup_*.json`);
    const left = (await (await request.get('/api/backups/configuration/list')).json() as Array<Record<string, any>>)
      .filter((b) => b.backup_trigger_source === SOURCE || b.backup_comment === 'fpp-tests plugin newest');
    for (const b of left) await request.delete(`/api/backups/configuration/JsonBackups/${b.backup_filename}`);
  }
});
