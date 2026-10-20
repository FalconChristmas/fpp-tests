import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, exists, pluginInfo, privacyRecord, restoreState, saveState } from './plugin-repo';

// A plugin's privacy disclosure (the `privacy` block of its pluginInfo.json)
// is a gate on every install: what the cloned copy declares must be what the
// operator accepted, or nothing is installed.
//
// - fpp a13b3b890 ("plugins(privacy): the disclosure check now covers every
//   way a plugin gets installed"): before it, an install whose accepted block
//   (`privacyAccepted`) was not the cloned one went ahead anyway and only
//   recorded nothing; and an uninstall forgot the accepted block, so a
//   reinstall from a script (no `privacyAccepted`) of a plugin whose
//   disclosure had since changed landed the new block unseen.  Now both are
//   refused with Code "PrivacyMismatch", the clone removed, and the record
//   kept across an uninstall to check a reinstall against.
// - fpp 02c141e69 ("fix(plugins): refuse an install whose privacy
//   disclosure was not accepted"): a fresh install with no `privacyAccepted`
//   and no record still installed (a scripted install skipped the dialog).
//   Now it is refused too, reason "notAccepted".
//
// The plugins are clones of repositories inside the player (plugin-repo.ts).

test.skip(!container, 'builds plugin repositories inside the run-web.sh container');

const NAME = 'fpp-tests-privacy';
const BLOCK_A = { sends: [{ to: 'example.invalid', what: 'fpp-tests A' }], remoteAccess: 'none' };
const BLOCK_B = { sends: [{ to: 'other.invalid', what: 'fpp-tests B' }], remoteAccess: 'none' };

let repo: PluginRepo;

test.beforeEach(() => {
  saveState();
  repo = new PluginRepo(NAME);
  repo.commit({ 'pluginInfo.json': pluginInfo(NAME, { privacy: BLOCK_A }) }, 'A');
});

test.afterEach(() => {
  repo.remove();
  restoreState([NAME]);
});

async function install(request: any, extra: Record<string, unknown> = {}) {
  const r = await request.post('/api/plugin', { data: repo.body(extra), timeout: 120_000 });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: text };
  }
}

test('02c141e69: a fresh install that accepted no disclosure is refused', async ({ request }) => {
  const refused = await install(request);
  expect(refused.Code, JSON.stringify(refused)).toBe('PrivacyMismatch');
  expect(refused.reason).toBe('notAccepted');
  expect(refused.pending).toEqual(BLOCK_A);
  expect(exists(`${PLUGINS}/${NAME}`), 'the refused clone was left behind').toBe(false);

  // The control: the same install, accepting the block the refusal handed
  // back, goes in and is recorded.
  const ok = await install(request, { privacyAccepted: refused.pending });
  expect(ok.Status, JSON.stringify(ok)).toBe('OK');
  expect(exists(`${PLUGINS}/${NAME}/pluginInfo.json`)).toBe(true);
  expect(privacyRecord(NAME)?.privacy).toEqual(BLOCK_A);
});

test('a13b3b890: an install whose accepted disclosure is not the cloned one is refused', async ({ request }) => {
  const refused = await install(request, { privacyAccepted: BLOCK_B });
  expect(refused.Code, JSON.stringify(refused)).toBe('PrivacyMismatch');
  expect(refused.plugin).toBe(NAME);
  expect(refused.pending).toEqual(BLOCK_A);
  expect(exists(`${PLUGINS}/${NAME}`), 'the refused clone was left behind').toBe(false);
  expect(privacyRecord(NAME)).toBeUndefined();

  // The control: accepting the cloned block installs it.
  const ok = await install(request, { privacyAccepted: BLOCK_A });
  expect(ok.Status, JSON.stringify(ok)).toBe('OK');
  expect(exists(`${PLUGINS}/${NAME}/pluginInfo.json`)).toBe(true);
});

test('a13b3b890: a reinstall without an acceptance is checked against the block accepted before the uninstall', async ({ request }) => {
  const ok = await install(request, { privacyAccepted: BLOCK_A });
  expect(ok.Status, JSON.stringify(ok)).toBe('OK');
  const gone = await request.delete(`/api/plugin/${NAME}`, { timeout: 120_000 });
  expect((await gone.json()).Status).toBe('OK');
  expect(exists(`${PLUGINS}/${NAME}`)).toBe(false);

  // The control for the record: a script's reinstall of the same disclosure
  // goes in without one being posted.
  const same = await install(request);
  expect(same.Status, JSON.stringify(same)).toBe('OK');
  expect((await (await request.delete(`/api/plugin/${NAME}`, { timeout: 120_000 })).json()).Status).toBe('OK');

  // The disclosure changes upstream; a script reinstalls it.
  repo.commit({ 'pluginInfo.json': pluginInfo(NAME, { privacy: BLOCK_B }) }, 'B');
  const refused = await install(request);
  expect(refused.Code, JSON.stringify(refused)).toBe('PrivacyMismatch');
  expect(refused.pending).toEqual(BLOCK_B);
  expect(exists(`${PLUGINS}/${NAME}`), 'the changed disclosure was installed unseen').toBe(false);
  expect(privacyRecord(NAME)?.privacy).toEqual(BLOCK_A);
});
