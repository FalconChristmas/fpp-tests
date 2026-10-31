import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

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
