import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { PluginRepo, installPlugin, uninstallPlugin } from './plugin-backfill';

// Feature: 1131fe61e ("consolidate FPP logging into fppd.log,
// fpp_system_upgrades.log & fpp_plugin_manager.log").  A plugin install's
// output went to a log of its own per operation (logs/fpp_plugin_<name>.log
// and the like), scattered and never rotated; it now goes into the one
// logs/fpp_plugin_manager.log, each line tagged with the operation and the
// plugin.  The plugin is a local git repository (plugin-backfill.ts) whose
// fpp_install.sh prints a marker.

test.skip(!container, 'installs a plugin from a local repository inside the run-web.sh container');

const LOGS = '/home/fpp/media/logs';
const LOG = `${LOGS}/fpp_plugin_manager.log`;

test('a plugin install writes its output into fpp_plugin_manager.log', async ({ request }) => {
  test.setTimeout(240_000);
  const repo = new PluginRepo('fpp-tests-oplog');
  repo.init({}, { 'scripts/fpp_install.sh': '#!/bin/sh\necho fpp-tests-oplog-install-ran\n' });
  const before = inPlayer('sh', '-c', `ls ${LOGS}`).split('\n');
  try {
    const r = await installPlugin(request, repo.info());
    // Trees of the fix's time printed the install's output ahead of the JSON.
    const status = r.Status ?? /\{"Status":"([^"]*)"/.exec(r.raw ?? '')?.[1];
    expect(status, JSON.stringify(r)).toBe('OK');
    const log = inPlayer('sh', '-c', `cat ${LOG} 2>/dev/null || true`);
    const ours = log.split('\n').filter((l) => l.includes('fpp-tests-oplog'));
    // The install script's own output is in the shared log, with the plugin named.
    expect(ours.some((l) => l.includes('fpp-tests-oplog-install-ran')), log.slice(-3000)).toBe(true);
    // ... and in no log of its own.
    const added = inPlayer('sh', '-c', `ls ${LOGS}`).split('\n').filter((f) => f && !before.includes(f));
    expect(added.filter((f) => f.includes('fpp-tests-oplog')), 'a per-plugin log was made').toEqual([]);
  } finally {
    await uninstallPlugin(request, repo.name);
    repo.remove();
  }
});
