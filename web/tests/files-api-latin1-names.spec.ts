import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: c49f70845 ("Try to better handle the non-utf8 things that
// Windows insists on using").  A file whose name is ISO-8859-1, not UTF-8 --
// what a Windows copy over Samba or a zip made on Windows leaves -- made
// json_encode() fail on the whole listing, so api/files answered with an empty
// body and the File Manager tab showed nothing at all.  The name is listed
// converted to UTF-8, in the full listing and the name-only one.

test.skip(!container, 'creates a file inside the run-web.sh container');

const MUSIC = '/home/fpp/media/music';
const LATIN1 = 'fpp-tests-caf\\351.mp3'; // printf escape: "café" with é as the byte 0xE9
const UTF8 = 'fpp-tests-café.mp3';

test('a file named in ISO-8859-1 is listed, converted to UTF-8', async ({ request }) => {
  inPlayer('sh', '-c', `printf x > "${MUSIC}/$(printf '${LATIN1}')"; printf x > ${MUSIC}/fpp-tests-plain.mp3`);
  try {
    // The control: the name on disk is not UTF-8.
    expect(inPlayer('sh', '-c', `ls ${MUSIC} | grep fpp-tests-caf | od -An -c`)).toContain('351');

    const full = await request.get('/api/files/music');
    expect(full.ok()).toBe(true);
    const text = await full.text();
    expect(text, 'the listing is not JSON').toMatch(/^\{/);
    const names = (JSON.parse(text).files as any[]).map((f) => f.name);
    expect(names).toContain('fpp-tests-plain.mp3');
    expect(names).toContain(UTF8);

    const short = await request.get('/api/files/music?nameOnly=1');
    expect(short.ok()).toBe(true);
    expect(await short.json()).toEqual(expect.arrayContaining(['fpp-tests-plain.mp3', UTF8]));
  } finally {
    inPlayer('sh', '-c', `rm -f ${MUSIC}/fpp-tests-caf* ${MUSIC}/fpp-tests-plain.mp3`);
  }
});
