import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: 9f1f9c3af ("don't rewrite a config file the upload does not
// change").  POST /api/configfile/<name> renamed a fresh copy over the file
// even when the upload was the same bytes, and fppd's FileMonitor (which
// watches for that rename, and for a close after writing) then tore down and
// rebuilt everything loaded from it -- every channel output, for a
// controller config xLights re-sends on each "output to lights".  Each upload
// also made a configuration backup.  An unchanged upload now writes nothing:
// the file keeps its inode, mtime and ctime, which no write or rename that
// FileMonitor reacts to could leave, and no backup is made.

test.skip(!container, 'saves and restores config files inside the run-web.sh container');

const FILE = '/home/fpp/media/config/co-other.json';
const BACKUPS = '/home/fpp/media/config/backups';
const CONTENT = JSON.stringify({ channelOutputs: [] }, null, 4) + '\n';

const stamp = () => inPlayer('stat', '-c', '%i %Y.%y %Z', FILE).trim();
const backups = () => Number(inPlayer('sh', '-c', `ls ${BACKUPS} 2>/dev/null | wc -l`).trim());

test('uploading a config file with exactly its current content leaves the file alone', async ({ request }) => {
  inPlayer('sh', '-c', `if [ -e ${FILE} ]; then cp -p ${FILE} ${FILE}.fpp-tests; fi; mkdir -p ${BACKUPS}; ` +
    `ls ${BACKUPS} > /tmp/fpp-tests-configfile-backups`);
  try {
    let r = await request.post('/api/configfile/co-other.json', { data: CONTENT });
    expect(r.ok(), await r.text()).toBe(true);
    const first = stamp();
    const made = backups();
    await new Promise((res) => setTimeout(res, 1100));

    r = await request.post('/api/configfile/co-other.json', { data: CONTENT });
    expect(r.ok()).toBe(true);
    expect((await r.json()).Status).toBe('OK');
    expect(stamp(), 'the unchanged file was rewritten').toBe(first);
    expect(backups(), 'an unchanged upload made a backup').toBe(made);

    // The control: a change is written.
    r = await request.post('/api/configfile/co-other.json', { data: CONTENT.replace('[]', '[ ]') });
    expect(r.ok()).toBe(true);
    expect(stamp()).not.toBe(first);
    expect(inPlayer('cat', FILE)).toContain('[ ]');
  } finally {
    inPlayer('sh', '-c', `if [ -e ${FILE}.fpp-tests ]; then mv ${FILE}.fpp-tests ${FILE}; else rm -f ${FILE}; fi; ` +
      `cd ${BACKUPS} && ls | grep -vxF -f /tmp/fpp-tests-configfile-backups | xargs -r rm -f; rm -f /tmp/fpp-tests-configfile-backups`);
  }
});
