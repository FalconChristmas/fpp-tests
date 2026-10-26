import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { putFile } from './settings-file';

// A PipeWire restart from the API (POST /api/pipewire/audio/services/restart,
// and every apply that restarts the stack) first stops fppd's playback with
// Stop Now, so a playlist's media lets go of PipeWire, and reports whether
// something was playing.  The player has no systemd: systemctl is replaced
// for the test by a stand-in that answers for the three PipeWire units and
// hands every other unit to the real one.  The receiving end is fppd: its log
// shows whether the Stop Now reached it.

test.skip(!container, 'replaces systemctl inside the run-web.sh container');

const STATE = '/tmp/fpp-tests-systemctl-gate';
const LOG = '/home/fpp/media/logs/fppd.log';
const SEQ = 'fpp-tests-gate.fseq';
const PLAYLIST = 'fpp-tests-gate';
const STUB = `#!/bin/sh
echo "$*" >> ${STATE}/calls
case "$2" in
  fpp-pipewire.service|fpp-wireplumber.service|fpp-pipewire-pulse.service) exit 0 ;;
esac
exec ${STATE}/systemctl.real "$@"
`;

// FSEQ v1, 3 channels, 2400 frames of 50 ms: two minutes.
function longSequence(): Buffer {
  const header = Buffer.alloc(28);
  header.write('PSEQ', 0, 'latin1');
  header.writeUInt16LE(28, 4);
  header.writeUInt8(1, 7);
  header.writeUInt16LE(28, 8);
  header.writeUInt32LE(3, 10);
  header.writeUInt32LE(2400, 14);
  header.writeUInt8(50, 18);
  return Buffer.concat([header, Buffer.alloc(3 * 2400, 0x40)]);
}

const logSize = () => Number(inPlayer('sh', '-c', `wc -c < ${LOG} 2>/dev/null || echo 0`).trim());
const logSince = (offset: number) => inPlayer('sh', '-c', `tail -c +${offset + 1} ${LOG} 2>/dev/null || true`);
const status = async (request: APIRequestContext) => (await request.get('/api/fppd/status')).json();

async function restartServices(request: APIRequestContext) {
  const r = await request.post('/api/pipewire/audio/services/restart', { timeout: 60_000 });
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  await settleAfterApply(request);
  return body;
}

test.beforeEach(async ({ request }) => {
  inPlayer('sh', '-c', `rm -rf ${STATE} && mkdir -p ${STATE} && cp -a /usr/bin/systemctl ${STATE}/systemctl.real`);
  putFile('/usr/bin/systemctl', STUB);
  inPlayer('chmod', '755', '/usr/bin/systemctl');
  putFile(`/home/fpp/media/sequences/${SEQ}`, longSequence());
  const saved = await request.post(`/api/playlist/${PLAYLIST}`, { data: {
    name: PLAYLIST, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [],
    mainPlaylist: [{ type: 'sequence', enabled: 1, playOnce: 0, sequenceName: SEQ }] } });
  expect(saved.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Stop Now', args: [] } });
  await request.get('/api/sequence/current/stop');
  inPlayer('sh', '-c', `cp -a ${STATE}/systemctl.real /usr/bin/systemctl && rm -rf ${STATE}`);
  await request.delete(`/api/playlist/${PLAYLIST}`);
  inPlayer('rm', '-f', `/home/fpp/media/sequences/${SEQ}`);
  await settleAfterApply(request);
});

test('a playlist playing is stopped with Stop Now before the restart, and reported as playing', async ({ request }) => {
  // The control for the test below: what the stop does when it applies.
  await request.post('/api/command', { data: { command: 'Start Playlist', args: [PLAYLIST, 'false', 'false'] } });
  await expect.poll(async () => (await status(request)).current_playlist?.playlist, { timeout: 10_000 }).toBe(PLAYLIST);
  const mark = logSize();
  const body = await restartServices(request);
  expect(body.wasPlaying).toBe(true);
  expect(logSince(mark)).toMatch(/running command "Stop Now/);
});

test('a sequence played on its own is not stopped with Stop Now before the restart', async ({ request }) => {
  // Regression: 04e1b8545.  Since ae524f919 such a sequence reports status 1,
  // which was all StopFppdPlaybackSafe() checked: it sent Stop Now, which
  // doesn't stop the sequence but marks the last playlist force-stopped for
  // the scheduler (until fppd restarts), and slept half a second for media
  // that wasn't playing.  It now acts only on a playlist, the playback it
  // stops and resumes.
  const started = await request.get(`/api/sequence/${SEQ}/start/0`);
  expect(started.ok()).toBe(true);
  await expect.poll(async () => {
    const s = await status(request);
    return `${s.status} ${s.status_name} ${s.current_sequence} '${s.current_playlist?.playlist ?? ''}'`;
  }, { timeout: 10_000 }).toBe(`1 playing ${SEQ} ''`);
  const mark = logSize();
  const body = await restartServices(request);
  // fppd's side: the restart reached it (the control that the log is the one
  // it writes), and no Stop Now came before it.
  const log = logSince(mark);
  expect(log).toMatch(/Shutting down main loop/);
  expect(log).not.toMatch(/running command "Stop Now/);
  expect(body.wasPlaying).toBe(false);
});
