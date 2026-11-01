import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, putFile, snapshotSettings } from './settings-file';
import { keepingFile } from './privacy-helpers';

// What a restore reports for each file of an area: VALID_DATA says whether the
// backup held something usable for it, so "nothing to restore" is told apart
// from "restore failed".  Feature: 7c96905d6 ("Misc tweaks to JSON Settings
// backups", the new VALID_DATA key in the restore reply).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const BACKUP = 'fpp-tests-valid-data_20260101000000.json';
const UNIVERSES = `${MEDIA}/config/co-universes.json`;

async function restore(request: import('@playwright/test').APIRequestContext, universes: unknown) {
  putFile(`${BACKUPS}/${BACKUP}`, JSON.stringify({
    fpp_backup_version: '8.0', backup_comment: 'fpp-tests valid data', channelOutputs: { universes },
  }));
  const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${BACKUP}`, { data: 'channelOutputs' });
  const body = await r.text();
  try { return { body, reply: JSON.parse(body) }; } catch { throw new Error(`the restore did not answer JSON: ${body.slice(0, 400)}`); }
}

test('a restore says which files of an area held data', async ({ request }) => {
  const restoreSettings = snapshotSettings();
  try {
    await keepingFile(UNIVERSES, async () => {
      const good = await restore(request, { universes: [{ active: 0 }] });
      const g = good.reply.Message.channelOutputs?.universes;
      expect(g?.VALID_DATA, good.body).toBe(true);
      expect(g?.ATTEMPT, good.body).toBe(true);
      expect(g?.SUCCESS, good.body).toBe(true);

      // A file the backup carries as something unusable: not valid, not attempted.
      const bad = await restore(request, 'not a file list');
      const b = bad.reply.Message.channelOutputs?.universes;
      expect(b?.VALID_DATA, bad.body).toBe(false);
      expect(b?.ATTEMPT, bad.body).toBeUndefined();
    });
  } finally {
    restoreSettings();
    inPlayer('rm', '-f', `${BACKUPS}/${BACKUP}`, '/fpp_restored');
  }
});
