import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, SETTINGS, exists, putFile, readFile } from './settings-file';

// PUT or POST /api/plugin/<plugin>/settings/<name> stores one setting of a
// plugin in config/plugin.<plugin>, the file the plugin's own code reads
// (www/api/controllers/plugin.php PluginSetSetting, PluginGetSetting).  The
// plugin name becomes a file name and the setting name a key in that file, so
// both are checked; the body is the value, as text.

test.skip(!container, 'reads the plugin config file inside the run-web.sh container');

const PLUGIN = 'fpp-tests-plugset';
const FILE = `${MEDIA}/config/plugin.${PLUGIN}`;
const url = (name: string, plugin = PLUGIN) => `/api/plugin/${plugin}/settings/${name}`;
const text = (value: string) => ({ data: Buffer.from(value), headers: { 'Content-Type': 'text/plain' } });
const clean = () => inPlayer('sh', '-c', `find ${MEDIA}/config ${MEDIA} -maxdepth 1 -name '*fpp-tests-plugset*' -exec rm -rf -- {} +`);

let settings = '';
test.beforeEach(() => { clean(); settings = readFile(SETTINGS); });
test.afterEach(() => {
  clean();
  if (readFile(SETTINGS) !== settings) putFile(SETTINGS, settings);
});

test('a setting is stored in the plugin\'s own file, read back, and the others in it are kept', async ({ request }) => {
  putFile(FILE, 'Existing = "kept"\nMode = "old"\n');
  let r = await request.put(url('Mode'), text('new value with spaces'));
  expect(r.status(), await r.text()).toBe(200);
  expect(await r.json()).toEqual({ status: 'OK', Mode: 'new value with spaces' });
  r = await request.post(url('Added'), text('7'));
  expect(await r.json()).toEqual({ status: 'OK', Added: '7' });

  expect(readFile(FILE)).toBe('Existing = "kept"\nMode = "new value with spaces"\nAdded = "7"\n');
  expect(await (await request.get(url('Existing'))).json()).toEqual({ status: 'OK', Existing: 'kept' });
  expect(readFile(SETTINGS), 'the main settings file was written').toBe(settings);
});

test('the first setting of a plugin makes its file; a trailing line end is dropped; an empty value is stored', async ({ request }) => {
  let r = await request.put(url('Host'), text('192.0.2.7\n'));
  expect(await r.json()).toEqual({ status: 'OK', Host: '192.0.2.7' });
  r = await request.put(url('Empty'), text(''));
  expect(r.status()).toBe(200);
  expect(readFile(FILE)).toBe('Host = "192.0.2.7"\nEmpty = ""\n');
  // A setting never stored reads as not there, not as an error.
  r = await request.get(url('Never'));
  expect(r.status()).toBe(200);
  expect((await r.json()).status).toBe('OK');
});

test('a value with a line break in it is refused with an error status, and the file stays', async ({ request }) => {
  putFile(FILE, 'Mode = "old"\n');
  for (const value of ['one\ntwo', 'one\r\ntwo', 'a\0b']) {
    const r = await request.put(url('Mode'), text(value));
    expect(r.status(), JSON.stringify(value)).toBe(500);
    expect((await r.json()).status).toBe('ERROR');
  }
  expect(readFile(FILE)).toBe('Mode = "old"\n');
});

test('a setting name that could not be a key is refused, on the write and on the read', async ({ request }) => {
  putFile(FILE, 'Mode = "old"\n');
  for (const name of ['a%3Db', 'a%5Bb%5D', 'a%3Bb', 'a%23b', 'a%22b', 'a%27b', 'a%5Cb']) {
    const w = await request.put(url(name), text('x'));
    expect(w.status(), name).toBe(400);
    expect(await w.json(), name).toEqual({ status: 'ERROR', message: 'Invalid setting name.' });
    const g = await request.get(url(name));
    expect(g.status(), name).toBe(400);
    expect(await g.json(), name).toEqual({ status: 'ERROR', message: 'Invalid plugin or setting name.' });
  }
  expect(readFile(FILE)).toBe('Mode = "old"\n');
});

test('a plugin name that is not one writes no file, in the config folder or out of it', async ({ request }) => {
  const before = inPlayer('sh', '-c', `ls -A ${MEDIA}/config ${MEDIA} | sort`);
  for (const plugin of ['..%5Cfpp-tests-plugset', '.fpp-tests-plugset', 'fpp-tests..plugset', 'fpp-tests%20plugset', 'fpp-tests-plugset%3Bx', '-fpp-tests-plugset']) {
    const w = await request.put(url('Mode', plugin), text('x'));
    expect(w.status(), plugin).toBe(400);
    expect(await w.json(), plugin).toEqual({ status: 'ERROR', message: 'Invalid plugin name.' });
    const g = await request.get(url('HostName', plugin));
    expect(g.status(), plugin).toBe(400);
  }
  expect(inPlayer('sh', '-c', `ls -A ${MEDIA}/config ${MEDIA} | sort`)).toBe(before);
  expect(exists(FILE)).toBe(false);
});

test('a value with a quote in it is read back as it was stored', async ({ request }) => {
  test.fail(true, 'the value is written between quotes unescaped (FUTURE.md)');
  for (const value of ['say "hello" twice', 'ends with a quote"', 'a = "b"']) {
    const r = await request.put(url('Quoted'), text(value));
    expect(r.status(), value).toBe(200);
    expect((await (await request.get(url('Quoted'))).json()).Quoted, value).toBe(value);
  }
});
