import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { realSystemctl, standInSystemctl, systemctlCalls } from './pw-systemctl';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { listen, nullSink, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: 47a0b9a0e ("restore group volumes from the config that
// describes the running graph").  After the audio stack restarts, the saved
// output group volumes are put back.  The PHP restore always read the
// Advanced mode's pipewire-audio-groups.json; on a Simple mode player that
// still had one from an earlier setup it set the volume of that config's
// group (fpp_group_main_output, which doesn't exist) and never the running
// fpp_group_default.  The restart here is System Health's
// (/api/pipewire/audio/services/restart, whose RestartPipeWireStack() runs
// the restore); systemctl is pw-systemctl.ts's stand-in, whose PipeWire
// units are the test's own daemons.  The fix's fppinit half
// (restorePipeWireVolumes(), at boot) isn't run here.

test.skip(!container, 'replaces systemctl and runs a real PipeWire inside the run-web.sh container');

// fppd, restarted with the stack, puts its master volume on the default sink
// (the only one here): full scale, so it is not what is measured.
let master = 0;
let restoreSettings: () => void;
test.beforeEach(async ({ request }) => {
  master = (await (await request.get('/api/system/volume')).json()).volume;
  await request.post('/api/system/volume', { data: { volume: 100 } });
  restoreSettings = snapshotSettings();
  standInSystemctl();
});

test.afterEach(async ({ request }) => {
  realSystemctl();
  stopPipeWire();
  cleanupPipeWire();
  inPlayer('rm', '-f', `${CONFIG}/pipewire-audio-groups-simple.json`);
  restoreSettings();
  await settleAfterApply(request);
  await request.post('/api/system/volume', { data: { volume: master } });
});

test("a Simple mode player gets its own group's volume back after an audio restart, not a leftover Advanced config's", async ({ request }) => {
  test.setTimeout(180_000);
  setSettingInFile('MediaBackend', 'pipewire-simple');
  writeFile(`${CONFIG}/pipewire-audio-groups-simple.json`, {
    groups: [{ id: 1, name: 'Default', enabled: true, volume: 60, channels: 2, members: [{ cardId: 'X', channels: 2 }] }],
  });
  // Left from an earlier Advanced setup.
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Main Output', enabled: true, volume: 30, channels: 2, members: [{ cardId: 'X', channels: 2 }] }],
  });
  // The running Simple graph's group sink, as the stack brings it up: at full level.
  startPipeWire({ objects: [nullSink('fpp_group_default')], waitFor: ['fpp_group_default'] });
  expect(sinkVolume('fpp_group_default')).toBe(100);

  const r = await request.post('/api/pipewire/audio/services/restart', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  // The control: the restart really restarted the stack (and the sink came back at 100%).
  expect(systemctlCalls()).toContain('restart fpp-pipewire.service');
  // A suspended sink reports its old volume until it runs; keep it running.
  listen('fpp_group_default');
  await expect.poll(() => { try { return sinkVolume('fpp_group_default'); } catch { return -1; } },
    { timeout: 15_000, message: 'the saved Simple mode volume was not put back' }).toBe(60);
});
