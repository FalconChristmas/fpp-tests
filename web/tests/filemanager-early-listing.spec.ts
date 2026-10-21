import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// filemanager.php asks for every listing from an inline script in its
// <head>.  A listing that answered before the parser had reached that tab's
// <table> was rendered into an empty jQuery set: fileData had the files, the
// table showed nothing (not even "No files found"), and Hide Empty Tabs never
// ran for it.  Fixed in fpp 7ca2533d9 ("fix(filemanager): a listing that answers
// before its table is parsed still fills it").
//
// The page is fetched through a proxy that holds it back just before the
// Music table until the browser has had the Music listing answered.

test.skip(!container, 'seeds a file inside the run-web.sh container');

const TABLE = '<table id="tblMusic"';

async function startHoldingProxy(target: string, pagePath: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, target);
    const headers = { ...req.headers, host: url.host, 'accept-encoding': 'identity' };
    const upstream = http.request(url, { method: req.method, headers }, (up) => {
      if (url.pathname !== pagePath) {
        res.writeHead(up.statusCode!, up.headers);
        up.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const at = body.indexOf(TABLE);
        const out = { ...up.headers };
        delete out['content-length'];
        res.writeHead(up.statusCode!, out);
        res.write(at < 0 ? body : body.slice(0, at));
        await released;
        res.end(at < 0 ? '' : body.slice(at));
      });
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, release, close: () => server.close() };
}

test('a listing that answers before its table is parsed still fills the table', async ({ page, baseURL }) => {
  const file = '/home/fpp/media/music/fpp-tests-early.mp3';
  inPlayer('sh', '-c', `echo x > ${file}`);
  const proxy = await startHoldingProxy(baseURL!, '/filemanager.php');
  try {
    const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files/Music');
    await page.goto(`${proxy.origin}/filemanager.php#tab-audio`, { waitUntil: 'commit' });
    await listed;
    await page.waitForTimeout(300);
    proxy.release();
    await page.waitForLoadState('load');
    await page.locator('#tab-audio-tab').click();
    await expect(page.locator('#tblMusic tbody tr', { hasText: 'fpp-tests-early.mp3' })).toBeVisible();
  } finally {
    proxy.release();
    proxy.close();
    inPlayer('rm', '-f', file);
  }
});
