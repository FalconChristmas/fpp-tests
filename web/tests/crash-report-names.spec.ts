import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// POST /api/crashes/upload/<file> sends one crash report to the FPP crash
// server.  The name comes off the wire, so it must be one of the reports in
// the crashes folder and nothing else on the player
// (www/api/controllers/crashes.php CrashReportPath).  Every request here is
// one that is refused before anything is sent: no report leaves the player.

test.skip(!container, 'seeds files inside the run-web.sh container');

const DIR = `${MEDIA}/crashes`;
const LINK = 'fpp-tests-crash-names-link.zip';
const MANUAL = 'fpp-tests-crash-names-manual.zip';
const json = { headers: { 'Content-Type': 'application/json' } };

const clean = () => inPlayer('sh', '-c', `rm -f -- "${DIR}"/fpp-tests-crash-names* "${MEDIA}"/fpp-tests-crash-names*`);
test.beforeEach(() => {
  inPlayer('mkdir', '-p', DIR);
  clean();
  putFile(`${MEDIA}/fpp-tests-crash-names-outside.zip`, 'not a crash report: a file elsewhere on the player');
  inPlayer('ln', '-s', `${MEDIA}/fpp-tests-crash-names-outside.zip`, `${DIR}/${LINK}`);
  putFile(`${DIR}/${MANUAL}`, 'fpp-tests: a report the user has not agreed to send');
  putFile(`${DIR}/fpp-tests-crash-names.txt`, 'in the folder, but not a report');
});
test.afterEach(clean);

test('a name that is not a crash report name is refused', async ({ request }) => {
  for (const name of [
    'fpp-tests-crash-names.txt',       // in the folder, wrong kind
    'settings', 'fpp_uuid',
    'core.zip',                        // no fpp- prefix
    'fpp-tests%20crash.zip',           // a space
    'fpp-tests-crash-names-manual.zip.bak',
  ]) {
    const r = await request.post(`/api/crashes/upload/${name}`, { ...json, data: { consent: true } });
    expect(await r.json(), name).toEqual({ Status: 'Error', Message: 'Not a crash report file name' });
  }
});

test('a path is cut down to its last part, which must still be a report in the folder', async ({ request }) => {
  // "..\..\settings" is reduced to "settings"; a report name behind a path is
  // looked for in the crashes folder only.
  let r = await request.post('/api/crashes/upload/..%5C..%5Csettings', { ...json, data: { consent: true } });
  expect(await r.json()).toEqual({ Status: 'Error', Message: 'Not a crash report file name' });
  r = await request.post('/api/crashes/upload/..%5Cfpp-tests-crash-names-outside.zip', { ...json, data: { consent: true } });
  expect(await r.json()).toEqual({ Status: 'Error', Code: 'not-found', Message: 'Crash report not found' });
  r = await request.post('/api/crashes/upload/fpp-tests-crash-names-none.zip', { ...json, data: { consent: true } });
  expect(await r.json()).toEqual({ Status: 'Error', Code: 'not-found', Message: 'Crash report not found' });
});

test('a link in the crashes folder that leads out of it is not sent', async ({ request }) => {
  const r = await request.post(`/api/crashes/upload/${LINK}`, { ...json, data: { consent: true } });
  expect(await r.json()).toEqual({ Status: 'Error', Message: 'Crash report is outside the crashes directory' });
});

test('a report made on request is not sent without the user\'s consent, said in JSON', async ({ request }) => {
  const refused = { Status: 'Error', Code: 'consent-required', Message: 'The user must agree to send this report first; then pass "consent": true' };
  for (const opts of [
    { ...json, data: {} },
    { ...json, data: { consent: 'true' } },
    { ...json, data: { consent: 1 } },
    { ...json, data: { consent: false } },
    // A form or plain-text post, which a page on another site could make.
    { form: { consent: 'true' } },
    { headers: { 'Content-Type': 'text/plain' }, data: Buffer.from('{"consent":true}') },
    {},
  ]) {
    const r = await request.post(`/api/crashes/upload/${MANUAL}`, opts);
    expect(await r.json(), JSON.stringify(opts)).toEqual(refused);
  }
});

test('a report is not built for a request that is not JSON', async ({ request }) => {
  const count = () => inPlayer('sh', '-c', `ls -A "${DIR}" | grep -c -- '-manual.zip$' || true`).trim();
  const before = count();
  for (const opts of [
    { form: { client: 'fpp-tests' } },
    { headers: { 'Content-Type': 'text/plain' }, data: Buffer.from('{"client":"fpp-tests"}') },
    { headers: { 'Content-Type': 'application/json' }, data: Buffer.from('"fpp-tests"') },
    { headers: { 'Content-Type': 'application/json' }, data: Buffer.from('{"client":') },
  ]) {
    const r = await request.post('/api/crashes/report', opts);
    expect(await r.json(), JSON.stringify(Object.keys(opts))).toEqual({ Status: 'Error', Code: 'bad-request', Message: 'Send a JSON object as application/json' });
  }
  expect(count(), 'a report was built').toBe(before);
});
