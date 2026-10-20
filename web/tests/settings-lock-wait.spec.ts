import { test, expect } from '@playwright/test';
import { container, inPlayer } from './container';

// scripts/common's getSetting and setSetting wait for the settings file's lock
// instead of giving up. Fixed in fpp efb6fcf92 ("fix(scripts): wait for the
// settings lock in getSetting/setSetting instead of exiting"). Before it both
// took an exclusive `flock -n` and ran "exit 1" when it failed, so any lock
// on the file -- every PHP page load and fppd read takes a shared one -- made
// setSetting drop the write and getSetting return an empty value.
//
// The test runs common's functions inside the player against a scratch
// settings file (CFGFILE), while a separate process holds a shared lock on it
// the way a reader does, so the player's own settings are never touched.

const DIR = '/tmp/fpp-tests-settings-lock';

const SCRIPT = `
set -u
D=${DIR}; F=$D/settings
rm -rf $D; mkdir -p $D
printf 'FppTestsOther = "kept"\\n' > $F
# A reader holding a shared lock until told to let go.
( flock -s 9; touch $D/held; while [ ! -e $D/release ]; do sleep 0.05; done ) 9<$F &
HOLDER=$!
for i in $(seq 100); do [ -e $D/held ] && break; sleep 0.05; done
[ -e $D/held ] || { echo "holder=never-locked"; exit 0; }
echo "holder=locked"
run() { CFGFILE=$F FPPDIR=/opt/fpp bash -c ". /opt/fpp/scripts/common; $1"; }
echo "get=$(run 'getSetting FppTestsOther')"
( run 'setSetting FppTestsLock landed'; echo $? > $D/rc ) 2>$D/err &
SETTER=$!
sleep 1
kill -0 $SETTER 2>/dev/null && echo "waiting=yes" || echo "waiting=no"
grep -q FppTestsLock $F && echo "early=yes" || echo "early=no"
touch $D/release
wait $HOLDER
wait $SETTER
echo "rc=$(cat $D/rc)"
echo "value=$(grep FppTestsLock $F)"
echo "other=$(grep FppTestsOther $F)"
`;

function run(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of inPlayer('bash', '-c', SCRIPT).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

test.describe('settings lock in scripts/common', () => {
  test.skip(!container, 'needs the player container that run-web.sh serves');
  test.afterEach(() => { inPlayer('rm', '-rf', DIR); });

  test('setSetting waits out a reader\'s lock and then writes; getSetting reads through it', () => {
    const r = run();
    // The control: the reader really held its lock while common ran.
    expect(r.holder, JSON.stringify(r)).toBe('locked');
    expect(r.get, 'getSetting returned nothing while a reader held the file').toBe('kept');
    expect(r.waiting, `setSetting gave up instead of waiting: ${JSON.stringify(r)}`).toBe('yes');
    expect(r.early, 'setSetting wrote while the lock was held').toBe('no');
    expect(r.rc, JSON.stringify(r)).toBe('0');
    expect(r.value, 'the value never landed').toBe('FppTestsLock = "landed"');
    expect(r.other, 'the existing setting was lost').toBe('FppTestsOther = "kept"');
  });
});
