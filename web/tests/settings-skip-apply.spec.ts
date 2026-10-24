import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, readSettingsFile } from './privacy-helpers';

// PUT /api/settings/<name> writes the value and then applies it (an OS
// password runs chpasswd for the fpp account) and takes a configuration
// backup.  ?skipApply=1 and ?skipBackup=1 leave those out, for a caller saving
// many settings at once.  The player has no fpp account, so the test makes
// one for the length of the test and the real chpasswd changes its password:
// the receiving end is the account's password hash, checked with the
// system's own crypt().

test.skip(!container, 'adds an account inside the run-web.sh container');

const BACKUPS = '/home/fpp/media/config/backups';

function backups(): string[] {
  return inPlayer('sh', '-c', `ls ${BACKUPS} 2>/dev/null || true`).split('\n').filter((l) => l.trim());
}

function shadowHash(): string {
  return inPlayer('sh', '-c', 'getent shadow fpp | cut -d: -f2').trim();
}

// Whether `password` is the fpp account's password, by the same crypt() login
// would use.
function isPassword(password: string): boolean {
  return inPlayer('perl', '-e', 'my ($h, $p) = @ARGV; print crypt($p, $h) eq $h ? "yes" : "no"', shadowHash(), password).trim() === 'yes';
}

test('a setting saved with skipApply and skipBackup is stored, not applied, and not backed up', async ({ request }) => {
  // Feature: 9959810ab.
  const hadUser = inPlayer('sh', '-c', 'id fpp >/dev/null 2>&1 && echo y || echo n').trim() === 'y';
  test.skip(hadUser, 'the player has an fpp account of its own');
  inPlayer('sh', '-c', "useradd -M -d /home/fpp fpp && echo 'fpp:fpp-tests-before' | chpasswd");
  const before = backups();
  try {
    expect(isPassword('fpp-tests-before'), 'the control: crypt() checks the password').toBe(true);
    await keepingSettings(async () => {
      let r = await request.put('/api/settings/osPassword?skipApply=1&skipBackup=1', { data: 'fpp-tests-skip' });
      expect(r.ok(), await r.text()).toBe(true);
      expect(readSettingsFile()).toMatch(/^osPassword = "fpp-tests-skip"$/m);
      await new Promise((res) => setTimeout(res, 500));
      expect(isPassword('fpp-tests-before'), 'the password changed for a skipApply save').toBe(true);
      expect(backups()).toEqual(before);

      // The control: the same save without them changes the password and
      // backs up.
      r = await request.put('/api/settings/osPassword', { data: 'fpp-tests-apply' });
      expect(r.ok()).toBe(true);
      await expect.poll(() => isPassword('fpp-tests-apply')).toBe(true);
      // A new file, not a longer list: the directory is pruned to a fixed count.
      await expect.poll(() => backups().filter((f) => !before.includes(f)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    });
  } finally {
    const made = backups().filter((b) => !before.includes(b));
    if (made.length) inPlayer('sh', '-c', `cd ${BACKUPS} && rm -f ${made.map((m) => `'${m}'`).join(' ')}`);
    inPlayer('userdel', 'fpp');
  }
});
