import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, pluginInfo, restoreState, saveState, sh } from './plugin-repo';

// fpp e26411c6c ("fix(plugins): a check asked for while one runs gets a full pass
// of its own"): Check for Updates and Update All ask for a check of every
// plugin, and when a check was already running they were told "already
// running" and given that check's answer.  It could have fetched a plugin
// before the commit the user was after was pushed (or, a page load's check,
// skipped it as recently checked), so Update All said "Nothing to update"
// with an update waiting.  Here the running check is held in a second
// plugin's own update-check script while the first plugin gets its update.

test.skip(!container, 'builds plugin repositories inside the run-web.sh container');

const A = 'fpp-tests-chk-a';
const SLOW = 'fpp-tests-chk-b-slow';

function stateOf(name: string) {
  const out = sh('cat /home/fpp/media/cache/plugin_updates.json 2>/dev/null || echo {}');
  const j = JSON.parse(out || '{}');
  return { sweep: j.sweep || {}, plugin: (j.plugins || {})[name] || {} };
}

test('a check asked for while one runs answers with what was pushed since', async ({ request }) => {
  test.setTimeout(180_000);
  saveState();
  const a = new PluginRepo(A);
  const slow = new PluginRepo(SLOW);
  try {
    a.commit({ 'pluginInfo.json': pluginInfo(A) }, 'v1');
    slow.commit({
      'pluginInfo.json': pluginInfo(SLOW),
      // "0": no update; the sleep is what holds the check running.
      'scripts/fpp_update_check.sh': { content: '#!/bin/sh\nsleep 6\necho 0\n', mode: '755' },
    }, 'v1');
    for (const repo of [a, slow]) {
      const r = await request.post('/api/plugin', { data: repo.body(), timeout: 120_000 });
      expect((await r.json()).Status).toBe('OK');
    }

    // Each install records an answer stamped with its second, and a check
    // drops its own answer for a plugin when the recorded one is as new, so
    // start it in a later second.
    const installedAt = Number(stateOf(A).plugin.checkedAt || 0);
    await new Promise((r) => setTimeout(r, 2_000));
    // The first check fetches A (oldest answer first), then sits in SLOW's script.
    expect((await (await request.post('/api/plugin/updateStatus/refresh')).json()).status).toBe('OK');
    await expect.poll(() => {
      const s = stateOf(A);
      return s.sweep.result === 'in-progress' && s.plugin.source === 'sweep' && Number(s.plugin.checkedAt) > installedAt;
    }, { timeout: 60_000, message: 'the running check to have fetched A' }).toBe(true);

    a.commit({ 'version.txt': '2\n' }, 'v2');
    const again = await (await request.post('/api/plugin/updateStatus/refresh')).json();
    expect(again.status).toBe('OK');

    let status: any = {};
    await expect.poll(async () => {
      status = await (await request.get('/api/plugin/updateStatus')).json();
      return status.sweep && status.sweep.result;
    }, { timeout: 90_000, message: 'the check to finish' }).not.toBe('in-progress');
    // The control: the first check really had fetched A before v2.
    expect(again.started, JSON.stringify(again)).toBe(false);
    expect(status.plugins, JSON.stringify(status)).toContain(A);
  } finally {
    a.remove();
    slow.remove();
    restoreState([A, SLOW]);
  }
});
