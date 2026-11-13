import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, exists, putFile, readFile } from './settings-file';

// POST /api/scripts/<name> is the File Manager's script editor Save: the body
// is the script's text as one JSON string, written over an existing script
// (www/api/controllers/scripts.php script_save; the editor itself is in
// filemanager-editors.spec.ts).  A saved script is one a schedule or a button
// runs, so what a save does to it when the body is not that string matters.

test.skip(!container, 'seeds scripts inside the run-web.sh container');

const NAME = 'fpp-tests-scriptsave.sh';
const FILE = `${MEDIA}/scripts/${NAME}`;
const ORIGINAL = '#!/bin/sh\necho "the original"\n';
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });

// A save makes a JSON configuration backup: the ones made here are removed.
let backups = '';
const listBackups = () => inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && cd ${BACKUPS} && find . -type f | sort`);
const clean = () => inPlayer('sh', '-c', `find ${MEDIA}/scripts ${MEDIA} -maxdepth 1 -name 'fpp-tests-scriptsave*' -exec rm -rf -- {} +`);
test.beforeEach(() => {
  backups = listBackups();
  clean();
  putFile(FILE, ORIGINAL);
});
test.afterEach(() => {
  clean();
  const had = new Set(backups.split('\n'));
  for (const f of listBackups().split('\n').filter((l) => l && !had.has(l))) inPlayer('rm', '-f', `${BACKUPS}/${f}`);
});

test('a save writes the text as sent, line ends and odd characters included, and a backup is made', async ({ request }) => {
  const text = '#!/bin/bash\r\n# é ü — "quotes" \'single\' $VAR `tick` \\n\n\techo done\n';
  const r = await request.post(`/api/scripts/${NAME}`, raw(JSON.stringify(text)));
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: 'OK', scriptName: NAME, scriptBody: text });
  expect(readFile(FILE)).toBe(text);
  expect(await (await request.get(`/api/scripts/${NAME}`)).text()).toBe(text);
  await expect.poll(() => listBackups() !== backups, { message: 'a configuration backup after the save' }).toBe(true);

  // An empty script is a script: the string "" is saved as that.
  expect((await (await request.post(`/api/scripts/${NAME}`, raw('""'))).json()).status).toBe('OK');
  expect(readFile(FILE)).toBe('');
});

test('a save does not make a script: one that is not there is an error and stays not there', async ({ request }) => {
  const r = await request.post('/api/scripts/fpp-tests-scriptsave-new.sh', raw('"echo new"'));
  expect(await r.json()).toEqual({ status: 'Error, file does not exist' });
  expect(exists(`${MEDIA}/scripts/fpp-tests-scriptsave-new.sh`)).toBe(false);
  expect(listBackups(), 'a backup was made for a save that did nothing').toBe(backups);
});

test('a name that is not a bare file name is refused, and nothing outside the scripts folder is written', async ({ request }) => {
  putFile(`${MEDIA}/fpp-tests-scriptsave-outside`, 'outside');
  for (const name of ['..%5Cfpp-tests-scriptsave-outside', 'a..b', 'x%5Cy']) {
    const r = await request.post(`/api/scripts/${name}`, raw('"overwritten"'));
    expect(r.status(), name).toBe(400);
    expect(await r.json(), name).toEqual({ status: 'Invalid scriptName' });
  }
  // A doubly-encoded "../" arrives as the text "..%2F", which has ".." in it.
  const r = await request.post('/api/scripts/..%252Ffpp-tests-scriptsave-outside', raw('"overwritten"'));
  expect(r.status()).toBe(400);
  expect(readFile(`${MEDIA}/fpp-tests-scriptsave-outside`)).toBe('outside');
  expect(readFile(FILE)).toBe(ORIGINAL);
});

test('a script that cannot be written is reported as an error, not as saved', async ({ request }) => {
  // A directory of that name: the one write failure a root player can stage.
  inPlayer('sh', '-c', `rm -f '${FILE}' && mkdir '${FILE}'`);
  const r = await request.post(`/api/scripts/${NAME}`, raw('"echo x"'));
  expect(await r.json()).toEqual({ status: 'Error updating file' });
  expect(listBackups()).toBe(backups);
});

for (const [what, body] of [
  ['the script sent as it is, not as a JSON string', '#!/bin/sh\necho "edited"\n'],
  ['an empty body', ''],
  ['a body cut short', '"#!/bin/sh\\necho'],
  ['null', 'null'],
] as const) {
  test(`${what} does not empty the script`, async ({ request }) => {
    const r = await request.post(`/api/scripts/${NAME}`, raw(body));
    expect(readFile(FILE), `the script was replaced (answer ${r.status()} ${await r.text()})`).toBe(ORIGINAL);
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });
}

for (const [what, body] of [
  ['a list', '["#!/bin/sh\\n", "echo two\\n"]'],
  ['an object', '{"scriptBody": "echo x"}'],
  ['a number', '42'],
] as const) {
  test(`${what} in place of the text is refused, and the script stays`, async ({ request }) => {
    const r = await request.post(`/api/scripts/${NAME}`, raw(body));
    expect(readFile(FILE), `the script was replaced (answer ${r.status()} ${await r.text()})`).toBe(ORIGINAL);
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });
}
