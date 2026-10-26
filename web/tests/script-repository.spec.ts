import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';
import { putFile } from './settings-file';

// The Script Repository page.  It used to fetch the fpp-scripts index from
// raw.githubusercontent.com as it was served; the test points that name at
// the player's loopback, where a listener notes every connection made to it,
// so nothing goes to GitHub and the receiving end can say whether the page
// tried.

test.skip(!container, 'listens for GitHub inside the run-web.sh container');

const HOSTS_LINE = '127.0.0.1 raw.githubusercontent.com # fpp-tests-script-repository';
const LOG = '/tmp/fpp-tests-raw-github.log';

test('the Script Repository page says it is deprecated and where scripts are now, and fetches nothing', async ({ page, request }) => {
  // Feature: e2d5682da ("deprecate the in-app Script Repository Browser,
  // provide suggested replacements").
  putFile('/tmp/fpp-tests-listen.py', `
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 443))
s.listen(8)
while True:
    c, a = s.accept()
    open('${LOG}', 'a').write('connection\\n')
    c.close()
`);
  inPlayer('sh', '-c', `rm -f ${LOG}; grep -q fpp-tests-script-repository /etc/hosts || echo '${HOSTS_LINE}' >> /etc/hosts`);
  docker('exec', '-d', container, 'python3', '/tmp/fpp-tests-listen.py');
  try {
    // The control: a fetch from the player for raw.githubusercontent.com reaches the listener.
    await expect.poll(() => {
      inPlayer('sh', '-c', 'curl -s --max-time 2 https://raw.githubusercontent.com/x > /dev/null 2>&1; true');
      return inPlayer('sh', '-c', `cat ${LOG} 2>/dev/null | wc -l`).trim();
    }, { timeout: 10_000 }).not.toBe('0');
    inPlayer('rm', '-f', LOG);

    const r = await request.get('/scriptbrowser.php', { timeout: 60_000 });
    expect(r.ok()).toBe(true);
    await page.goto('/scriptbrowser.php');
    const notice = page.locator('.callout-warning');
    await expect(notice).toContainText('The FPP-sanctioned Script Repository has been deprecated.');
    // Where to go instead: your own scripts in the File Manager, and the
    // repository's README for what replaced each old script.
    await expect(notice.locator('a[href="filemanager.php#tab-scripts"]').first()).toBeVisible();
    await expect(notice.locator('a[href="https://github.com/FalconChristmas/fpp-scripts/blob/master/README.md"]')).toBeVisible();
    expect(inPlayer('sh', '-c', `cat ${LOG} 2>/dev/null | wc -l`).trim(), 'the page fetched from the script repository').toBe('0');
  } finally {
    inPlayer('sh', '-c', "pkill -f 'python3 /tmp/[f]pp-tests-listen' || true");
    inPlayer('sh', '-c', `rm -f /tmp/fpp-tests-listen.py ${LOG};
      grep -v fpp-tests-script-repository /etc/hosts > /tmp/fpp-tests-hosts; cat /tmp/fpp-tests-hosts > /etc/hosts; rm -f /tmp/fpp-tests-hosts`);
  }
});
