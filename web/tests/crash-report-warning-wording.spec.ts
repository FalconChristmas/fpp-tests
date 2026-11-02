import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The status warning that says crash reports are waiting in the File Manager.

test.skip(!container, 'drops crash reports in the run-web.sh container');

const DIR = '/home/fpp/media/crashes';

async function crashWarning(request: any): Promise<string> {
  const r = await request.get('/api/system/status');
  const s = await r.json();
  return (s.warnings as string[]).find((w) => w.includes('crash report')) ?? '';
}

test('the crash-report warning counts the reports and says whether they are sent automatically', async ({ request }) => {
  // Regression: e4b5ce953.  The warning always read "There are crash reports
  // available, please submit ... or delete" -- no count, wrong for exactly
  // one report -- and told a player that uploads them by itself to submit
  // them.  It now has the count and the right is/are and singular/plural,
  // and with ShareCrashData on it says they are sent automatically and may
  // be deleted.
  inPlayer('sh', '-c', `mkdir -p ${DIR} && rm -f ${DIR}/fpp-tests-w*.zip && echo x > ${DIR}/fpp-tests-w1.zip`);
  try {
    await keepingSettings(async () => {
      setSettingInFile('ShareCrashData', '0');
      const one = await crashWarning(request);
      expect(one).toContain('There is 1 crash report available');
      expect(one, 'a player that does not upload asks the user to send them').toContain('Send or delete');
      expect(one).not.toContain('automatically');

      inPlayer('sh', '-c', `echo x > ${DIR}/fpp-tests-w2.zip`);
      const two = await crashWarning(request);
      expect(two).toContain('There are 2 crash reports available');

      setSettingInFile('ShareCrashData', '1');
      const shared = await crashWarning(request);
      expect(shared).toContain('There are 2 crash reports available');
      expect(shared, 'a player that uploads them says so').toContain('automatically');
      expect(shared).not.toContain('Send or delete');
    });
  } finally {
    inPlayer('sh', '-c', `rm -f ${DIR}/fpp-tests-w*.zip`);
  }
});
