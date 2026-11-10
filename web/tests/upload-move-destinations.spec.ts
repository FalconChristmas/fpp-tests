import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// Where an uploaded file goes (MoveFile(), POST /api/file/move/<name>, which
// the File Manager calls once an upload is in upload/): by its extension, to
// the folder fppd and the pages look in, under the same name, and out of
// upload/.  A compressed sequence is unpacked there, a script loses its DOS
// line ends (a #! line ending in \r does not run), and a cape EEPROM image
// becomes the player's cape-eeprom.bin.

test.skip(!container, 'puts files in the player\'s upload folder inside the run-web.sh container');

const UPLOAD = `${MEDIA}/upload`;
const P = 'fpp-tests-move-';

let cleanup: string[] = [];
let restore: [string, string | null][] = [];
test.beforeEach(() => {
  cleanup = [];
  restore = [];
});
test.afterEach(() => {
  for (const f of cleanup) inPlayer('rm', '-f', f);
  for (const [f, c] of restore) {
    if (c === null) inPlayer('rm', '-f', f);
    else putFile(f, c);
  }
});

async function move(request: APIRequestContext, name: string) {
  const r = await request.post(`/api/file/move/${encodeURIComponent(name)}`);
  expect(r.ok()).toBe(true);
  return (await r.json()).status as string;
}
function upload(name: string, content: string | Buffer) {
  putFile(`${UPLOAD}/${name}`, content);
  cleanup.push(`${UPLOAD}/${name}`);
}

for (const [ext, dir] of [
  ['fseq', 'sequences'], ['FSEQ', 'sequences'], ['eseq', 'effects'],
  ['mp4', 'videos'], ['mkv', 'videos'], ['mov', 'videos'],
  ['png', 'images'], ['JPG', 'images'], ['gif', 'images'],
  ['mp3', 'music'], ['ogg', 'music'], ['wav', 'music'], ['flac', 'music'], ['m4a', 'music'],
  ['py', 'scripts'], ['php', 'scripts'],
] as const) {
  test(`a .${ext} upload goes to ${dir}/`, async ({ request }) => {
    const name = `${P}file.${ext}`;
    const dest = `${MEDIA}/${dir}/${name}`;
    cleanup.push(dest);
    upload(name, `fpp-tests ${ext}\n`);
    expect(await move(request, name)).toBe('OK');
    expect(exists(`${UPLOAD}/${name}`), 'still in upload/').toBe(false);
    expect(readFile(dest)).toBe(`fpp-tests ${ext}\n`);
  });
}

test('an upload replaces the file of the same name already there', async ({ request }) => {
  const name = `${P}again.fseq`;
  const dest = `${MEDIA}/sequences/${name}`;
  cleanup.push(dest);
  putFile(dest, 'old');
  upload(name, 'new');
  expect(await move(request, name)).toBe('OK');
  expect(readFile(dest)).toBe('new');
});

test('a compressed sequence is unpacked in sequences/', async ({ request }) => {
  const name = `${P}packed.fseq.gz`;
  const seq = `${MEDIA}/sequences/${P}packed.fseq`;
  cleanup.push(seq, `${MEDIA}/sequences/${name}`, `${UPLOAD}/${name}`);
  inPlayer('sh', '-c', 'printf "PSEQ fpp-tests packed" | gzip > "$1"', 'sh', `${UPLOAD}/${name}`);
  expect(await move(request, name)).toBe('OK');
  expect(readFile(seq)).toBe('PSEQ fpp-tests packed');
  expect(exists(`${MEDIA}/sequences/${name}`), 'the .gz is left beside it').toBe(false);
});

test('a script loses its DOS line ends, and nothing else', async ({ request }) => {
  const name = `${P}dos.sh`;
  const dest = `${MEDIA}/scripts/${name}`;
  cleanup.push(dest);
  upload(name, '#!/bin/sh\r\necho "fpp-tests"\r\n\techo \'tab\'\r\n');
  expect(await move(request, name)).toBe('OK');
  expect(readFile(dest)).toBe('#!/bin/sh\necho "fpp-tests"\n\techo \'tab\'\n');
});

test("a cape EEPROM image becomes this player's cape-eeprom.bin", async ({ request }) => {
  const eeprom = `${MEDIA}/config/cape-eeprom.bin`;
  restore.push([eeprom, exists(eeprom) ? readFile(eeprom) : null]);
  const name = `${P}F16-eeprom.bin`;
  upload(name, 'FPP02fpp-tests eeprom');
  expect(await move(request, name)).toBe('OK');
  expect(readFile(eeprom)).toBe('FPP02fpp-tests eeprom');
  expect(exists(`${UPLOAD}/${name}`)).toBe(false);
});

test('a file not in upload/ is said to be missing', async ({ request }) => {
  expect(await move(request, `${P}nowhere.fseq`)).toBe(`ERROR: Couldn't find file '${P}nowhere.fseq' in upload directory`);
});
