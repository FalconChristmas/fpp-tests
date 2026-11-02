import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Logs directory's listings carry the system logs from /var/log beside
// the files of the logs folder, whatever case the directory is asked for in
// and whether the full listing or only the names are asked for.

test.skip(!container, 'writes the system log inside the run-web.sh container');

const SYSLOG = '/var/log/syslog';
let had = false;

test.beforeEach(() => {
  had = inPlayer('sh', '-c', `test -e ${SYSLOG} && echo y || echo n`).trim() === 'y';
  if (!had) inPlayer('sh', '-c', `echo "fpp-tests syslog" > ${SYSLOG}; chmod 644 ${SYSLOG}`);
});
test.afterEach(() => {
  if (!had) inPlayer('rm', '-f', SYSLOG);
});

test('a name-only listing of the logs is a plain list of names that includes the system log', async ({ request }) => {
  // Regression: adf31929a ("Optimize files API call when only retrieving
  // list of file names", which also fixed the Logs listing of messages and
  // syslog).  ?nameOnly=1 answers a flat array of names, and for the Logs
  // directory adds the /var/log files.
  const r = await request.get('/api/files/Logs?nameOnly=1');
  expect(r.status()).toBe(200);
  const names = await r.json();
  expect(Array.isArray(names), JSON.stringify(names).slice(0, 200)).toBe(true);
  expect(names).toContain(SYSLOG);
  // A plain directory's names are bare names, not objects.
  expect(names.every((n: unknown) => typeof n === 'string')).toBe(true);
});

test('the Logs directory is the Logs directory in any case', async ({ request }) => {
  // Regression: adf31929a.  The system logs were added to the listing when
  // the directory was named exactly "Logs", and to a list nobody returned.
  for (const dir of ['logs', 'Logs', 'LOGS']) {
    const list = await (await request.get(`/api/files/${dir}`)).json();
    expect(list.files.map((f: any) => f.name), dir).toContain(SYSLOG);
    const names = await (await request.get(`/api/files/${dir}?nameOnly=1`)).json();
    expect(names, `${dir} names`).toContain(SYSLOG);
  }
});
