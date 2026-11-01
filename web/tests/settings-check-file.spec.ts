import { test, expect } from './fixtures';

import { container, inPlayer } from './container';

// A setting can name files in "checkFile" that decide whether it is offered;
// a name starting with "!" wants the file to be absent.

// Regression: a44490bf0 ("Fix inverted checkFile handling").  A "!" name whose
// file existed still counted as a pass (the inverted test fell into the same
// branch as the plain one), so a setting meant only for players without the
// file (bootDelay, "!/etc/fpp/container") was shown on every player that had it.
test.describe('checkFile with an inverted name', () => {
  test.skip(!container, 'moves a file inside the player');

  const MARK = '/etc/fpp/container';
  const row = async (request: any) => (await (await request.get('/settings-system.php')).text()).includes("id='bootDelayRow'");

  test('a setting that wants the file absent is left out while it exists, and shown when it is not', async ({ request }) => {
    const had = inPlayer('sh', '-c', `test -e ${MARK} && echo y || echo n`).trim() === 'y';
    try {
      inPlayer('sh', '-c', `mkdir -p /etc/fpp && touch ${MARK}`);
      expect(await row(request), 'bootDelay offered although the file exists').toBe(false);
      inPlayer('sh', '-c', `rm -f ${MARK}`);
      expect(await row(request), 'bootDelay missing although the file is absent').toBe(true);
    } finally {
      if (had) inPlayer('sh', '-c', `mkdir -p /etc/fpp && touch ${MARK}`);
    }
  });
});
