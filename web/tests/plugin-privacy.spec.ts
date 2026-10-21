import { randomUUID } from 'crypto';
import { test, expect } from './fixtures';
import { container } from './container';
import {
  PluginRepo, CONFIG, sh, exists, readFile, writeFile, installPlugin, uninstallPlugin, clearPluginSourceSettings,
} from './plugin-backfill';

// A plugin's privacy disclosure (pluginInfo.json "privacy"): what the
// operator accepted is recorded in config/pluginPrivacyAccepted.json, and an
// install, update or reinstall whose disclosure is not the accepted one is
// refused with Code "PrivacyMismatch" and the block to review.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const PLUGIN = 'fpp-tests-privacy';
const repo = new PluginRepo(PLUGIN);
const ACCEPTED = `${CONFIG}/pluginPrivacyAccepted.json`;

const blockA = {
  summary: 'Plays a tune.', sends: [], collects: [], sensors: [], remoteAccess: 'none',
  systemChanges: [], closedCode: false, other: 'none',
};
const blockB = { ...blockA, sends: [{ what: 'play counts', to: 'stats.fpp-tests.invalid', when: 'always' }] };

test.afterEach(() => {
  repo.remove();
  sh(`rm -f ${ACCEPTED} ${ACCEPTED}.*`);
  clearPluginSourceSettings();
});

function accepted(): any {
  return exists(ACCEPTED) ? JSON.parse(readFile(ACCEPTED)) : null;
}

async function upgrade(request: any, body?: unknown): Promise<any> {
  const r = await request.post(`/api/plugin/${PLUGIN}/upgrade`, { data: body === undefined ? '' : JSON.stringify(body), timeout: 180_000 });
  return r.json();
}

test('a changed disclosure is reported, and an update that would land it unseen is refused', async ({ request }) => {
  // Feature: 6f7d29efd (GET .../privacy), 2bcc9b338 (POST .../updates says
  // privacyChanged).  Regression: a13b3b890.  An update that carried no
  // acknowledgement (Update All, a script, an old page) landed a changed
  // disclosure silently.  The author's "other" notes are material too; the
  // summary is not.
  repo.init({ privacy: blockA });
  expect((await installPlugin(request, repo.info({ privacy: blockA, privacyAccepted: blockA }))).Status).toBe('OK');
  const installed = repo.installedHead();

  // A summary-only change is not asked about.
  repo.setInfo({ privacy: { ...blockA, summary: 'Plays a better tune.' } }, 'summary');
  let u = await (await request.post(`/api/plugin/${PLUGIN}/updates`, { timeout: 120_000 })).json();
  expect(u, JSON.stringify(u)).toMatchObject({ Status: 'OK', updatesAvailable: 1, privacyChanged: false });

  // A change to "other" is.
  repo.setInfo({ privacy: { ...blockA, other: 'Keeps a log.' } }, 'other');
  u = await (await request.post(`/api/plugin/${PLUGIN}/updates`, { timeout: 120_000 })).json();
  expect(u.privacyChanged, JSON.stringify(u)).toBe(true);

  repo.setInfo({ privacy: blockB }, 'sends');
  u = await (await request.post(`/api/plugin/${PLUGIN}/updates`, { timeout: 120_000 })).json();
  expect(u.privacyChanged, JSON.stringify(u)).toBe(true);
  const st = await (await request.get(`/api/plugin/${PLUGIN}/privacy`)).json();
  expect(st).toMatchObject({ Status: 'OK', changed: true, recorded: true, accepted: blockA, pending: blockB });

  const r = await upgrade(request);
  expect(r, JSON.stringify(r)).toMatchObject({ Status: 'Error', Code: 'PrivacyMismatch', pending: blockB });
  expect(repo.installedHead(), 'the update landed a disclosure nobody accepted').toBe(installed);
});

test('an update that accepts the changed disclosure lands it and records it', async ({ request }) => {
  // Feature: 2bcc9b338.  POST .../upgrade with {"privacyAccepted": <the
  // pending block>} goes ahead, and the record is the block that landed.
  repo.init({ privacy: blockA });
  expect((await installPlugin(request, repo.info({ privacy: blockA, privacyAccepted: blockA }))).Status).toBe('OK');
  const tip = repo.setInfo({ privacy: blockB }, 'sends');
  const r = await upgrade(request, { privacyAccepted: blockB });
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  expect(repo.installedHead()).toBe(tip);
  expect(accepted().plugins[PLUGIN]).toMatchObject({ privacy: blockB, sha: tip });
});

test('no disclosure in a fallback copy is not read as the author taking it back', async ({ request }) => {
  // Regression: 6b0c51a24.  When the clone has no upstream to read (not on a
  // branch), the block comes from a fallback (the listing, or the installed
  // pluginInfo.json); none there against a recorded block was reported as a
  // changed disclosure ("the author removed it"), which only the target
  // version's own pluginInfo.json can say.
  repo.init({ privacy: blockA });
  expect((await installPlugin(request, repo.info({ privacy: blockA, privacyAccepted: blockA }))).Status).toBe('OK');
  sh(`git -C ${repo.dir} checkout -q --detach`);
  writeFile(`${repo.dir}/pluginInfo.json`, JSON.stringify(repo.info()));
  const st = await (await request.get(`/api/plugin/${PLUGIN}/privacy`, { timeout: 60_000 })).json();
  expect(st, JSON.stringify(st)).toMatchObject({ Status: 'OK', recorded: true, pending: null, changed: false });
  expect(st.source).not.toBe('upstream');
});

test("another player's acceptance record is not honoured, and is moved aside", async ({ request }) => {
  // Regression: 9546ea9c2.  config/pluginPrivacyAccepted.json had no owner, so
  // one restored from another player's backup (or a card moved to another
  // board) pre-accepted disclosures nobody on this player was shown.
  const foreign = randomUUID();
  writeFile(ACCEPTED, JSON.stringify({ uuid: foreign, plugins: { [PLUGIN]: { privacy: blockA, sha: '', acceptedAt: '2026-01-01T00:00:00+00:00' } } }));
  repo.init({ privacy: blockA });
  const r = await installPlugin(request, repo.info({ privacy: blockA }));
  expect(r, JSON.stringify(r)).toMatchObject({ Status: 'Error', Code: 'PrivacyMismatch', reason: 'notAccepted' });

  const ok = await installPlugin(request, repo.info({ privacy: blockA, privacyAccepted: blockA }));
  expect(ok.Status, JSON.stringify(ok)).toBe('OK');
  const now = accepted();
  expect(now.uuid).not.toBe(foreign);
  expect(now.uuid).toMatch(/^[0-9a-f-]{36}$/i);
  expect(now.plugins[PLUGIN].privacy).toEqual(blockA);
  expect(JSON.parse(readFile(`${ACCEPTED}.foreign.bak`)).uuid).toBe(foreign);

  // The plugins area of Reset Config takes the record with the plugins.
  await request.post('/resetConfig.php?areas=plugins,dummy', { timeout: 60_000 });
  expect(exists(ACCEPTED)).toBe(false);
});

