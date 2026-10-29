import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// api/system/info's CPU utilisation is the change in /proc/stat since the
// last call, which get_server_cpu_usage() keeps in /tmp/cpustats.txt.  Every
// call rewrites that file, so a request that reads it while another is
// writing it can find it empty.
//
// Regression: 0a4d00b60 ("attempt to fix some errors detected in apache error
// log").  The saved counters were subtracted as read, and PHP 8 throws on
// arithmetic with a non-numeric string: an empty or damaged file made
// api/system/info (and every page and remote that asks it) answer 500.

test.skip(!container, 'writes /tmp/cpustats.txt inside the run-web.sh container');

const STATS = '/tmp/cpustats.txt';

test.afterEach(() => inPlayer('rm', '-f', STATS));

for (const [what, content] of [['empty', ''], ['damaged', 'x y z']]) {
  test(`system info answers when the CPU counter file is ${what}`, async ({ request }) => {
    putFile(STATS, content);
    const r = await request.get('/api/system/info');
    expect(r.status(), (await r.text()).slice(0, 500)).toBe(200);
    const body = await r.text();
    expect(body, 'PHP died answering it').not.toMatch(/Fatal error|Uncaught/);
    const cpu = (await r.json())?.Utilization?.CPU;
    expect(typeof cpu).toBe('number');
    expect(cpu).toBeGreaterThanOrEqual(0);
    expect(cpu).toBeLessThanOrEqual(100);
    // The file was written again, whole, for the next call.
    expect(inPlayer('cat', STATS).trim()).toMatch(/^\d+( \d+){6}$/);
  });
}
