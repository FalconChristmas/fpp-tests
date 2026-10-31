import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/files/<dir>: one listing of the directory, sub-directories and
// files, each with name, mtime, sizeBytes and sizeHuman (Feature: b7d22c4f7,
// which rewrote it to a single find per kind for the file manager's backups).

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const DIR = `${MEDIA}/scripts/fpp-tests-listing`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${DIR} && mkdir -p ${DIR}/sub/deeper && printf 12345 > ${DIR}/top.txt && printf abc > ${DIR}/sub/inner.txt && printf z > ${DIR}/sub/deeper/low.txt`);
});
test.afterEach(() => {
  inPlayer('rm', '-rf', DIR);
});

test('the listing has directories and files with their sizes, nested names relative to the directory', async ({ request }) => {
  const body = await (await request.get('/api/files/scripts')).json();
  const mine = body.files.filter((f: any) => f.name.startsWith('fpp-tests-listing'));
  const by = Object.fromEntries(mine.map((f: any) => [f.name, f]));
  expect(Object.keys(by).sort()).toEqual([
    'fpp-tests-listing', 'fpp-tests-listing/sub', 'fpp-tests-listing/sub/deeper',
    'fpp-tests-listing/sub/deeper/low.txt', 'fpp-tests-listing/sub/inner.txt', 'fpp-tests-listing/top.txt']);
  expect(by['fpp-tests-listing/sub']).toMatchObject({ isDirectory: true, sizeBytes: 0, sizeHuman: 'Directory' });
  expect(by['fpp-tests-listing/top.txt']).toMatchObject({ sizeBytes: 5 });
  expect(by['fpp-tests-listing/sub/inner.txt']).toMatchObject({ sizeBytes: 3 });
  expect(by['fpp-tests-listing/top.txt'].mtime).toMatch(/^\d\d\/\d\d\/\d\d\s+\d\d:\d\d [AP]M$/);
  expect(by['fpp-tests-listing/top.txt'].isDirectory).toBeFalsy();
});

test('maxdepth limits how far down the listing goes', async ({ request }) => {
  const body = await (await request.get('/api/files/scripts?maxdepth=2')).json();
  const names: string[] = body.files.map((f: any) => f.name).filter((n: string) => n.startsWith('fpp-tests-listing'));
  expect(names).toContain('fpp-tests-listing/top.txt');
  expect(names).not.toContain('fpp-tests-listing/sub/inner.txt');
});
