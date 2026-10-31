import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// Files whose names hold characters that URLs, shells and regexes treat
// specially: they are listed, downloaded and deleted by their own name.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const NAMES = [
  'fpp-tests [brackets] 1.txt', // d8795d89b: square brackets in an upload's name
  'fpp-tests 50% off.txt', // 2807e1a97, 8338ea5c5: percent, spaces
  'fpp-tests a+b&c#d.txt', // 024fae795, a22ee7166: plus, ampersand, hash
  "fpp-tests it's (1).txt",
];

for (const name of NAMES) {
  test(`a file named "${name}" is listed, downloaded and deleted`, async ({ request }) => {
    const dir = 'scripts';
    inPlayer('sh', '-c', `mkdir -p ${MEDIA}/${dir} && printf %s hello > "${MEDIA}/${dir}/${name.replace(/"/g, '\\"')}"`);
    try {
      const list = await (await request.get(`/api/files/${dir}?nameOnly=1`)).json();
      const names: string[] = Array.isArray(list) ? list : list.files ?? [];
      expect(names, JSON.stringify(names).slice(0, 300)).toContain(name);
      const got = await request.get(`/api/file/${dir}/${encodeURIComponent(name)}`);
      expect(got.status(), `GET ${name}`).toBe(200);
      expect(await got.text()).toBe('hello');
      const del = await request.delete(`/api/file/${dir}/${encodeURIComponent(name)}`);
      expect(del.status(), `DELETE ${name}: ${await del.text()}`).toBe(200);
      expect(inPlayer('sh', '-c', `test -e "${MEDIA}/${dir}/${name}" && echo there || echo gone`).trim()).toBe('gone');
    } finally {
      inPlayer('rm', '-f', `${MEDIA}/${dir}/${name}`);
    }
  });
}

// The web server and the router each decode a URL once, so a name encoded
// twice by its client reaches the handler plain.  One encoded three times
// reaches it still encoded once, and the handler tries it decoded.
test('a name encoded three times is still found by the upload move', async ({ request }) => {
  // Regression: a22ee7166, 8338ea5c5.  The name was used as it came, so a
  // file with a space or percent sign in its name, from a client that encoded
  // it again, was reported not found in upload and never moved.  findFile()
  // now tries the decoded and sanitized names too.
  const enc = (n: string, times: number) => (times ? enc(encodeURIComponent(n), times - 1) : n);
  const moved = 'fpp-tests thrice moved 50% off.fseq';
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/upload ${MEDIA}/sequences`);
  try {
    // The control: encoded twice, the stack alone gives the handler the name.
    for (const times of [2, 3]) {
      putFile(`${MEDIA}/upload/${moved}`, 'x');
      inPlayer('rm', '-f', `${MEDIA}/sequences/${moved}`);
      const mv = await request.post(`/api/file/move/${enc(moved, times)}`);
      expect((await mv.json()).status, `move, encoded ${times} times`).toBe('OK');
      expect(inPlayer('sh', '-c', `test -e "${MEDIA}/sequences/${moved}" && echo there || echo missing`).trim(), `after the move, encoded ${times} times`).toBe('there');
    }
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/upload/${moved}`, `${MEDIA}/sequences/${moved}`);
  }
});

// An FSEQ v1 header, as sequence-fps.spec.ts writes them: two channels of
// one frame at a 50 ms step.
function tinyFseq(): Buffer {
  const h = Buffer.alloc(28);
  h.write('PSEQ', 0, 'latin1');
  h.writeUInt16LE(28, 4);
  h.writeUInt8(1, 7);
  h.writeUInt16LE(28, 8);
  h.writeUInt32LE(2, 10);
  h.writeUInt32LE(1, 14);
  h.writeUInt8(50, 18);
  h.writeUInt16LE(1, 22);
  h.writeUInt16LE(2, 24);
  return Buffer.concat([h, Buffer.alloc(2, 0x7f)]);
}

test('a sequence whose name holds a quote and a dollar sign has its metadata read', async ({ request }) => {
  // Regression: 2807e1a97.  The path went into the fsequtils command line
  // inside double quotes: a quote ended them and $NAME was expanded, so the
  // metadata came back as the "?.?" placeholder instead of the header's.
  const name = 'fpp-tests "q" $HOME.fseq';
  putFile(`${MEDIA}/sequences/${name}`, tinyFseq());
  try {
    // The control: fsequtils itself reads the file as written.
    expect(JSON.parse(inPlayer('/opt/fpp/src/fsequtils', '-j', `${MEDIA}/sequences/${name}`)).StepTime).toBe(50);
    const r = await request.get(`/api/sequence/${encodeURIComponent(name)}/meta`);
    expect(r.status()).toBe(200);
    const meta = await r.json();
    expect(meta.StepTime, JSON.stringify(meta)).toBe(50);
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/sequences/${name}`);
  }
});
