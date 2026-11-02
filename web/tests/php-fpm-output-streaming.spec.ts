import { test, expect } from './fixtures';
import * as http from 'http';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// A PHP page that flushes its output reaches the browser at once, through
// Apache's proxy to php-fpm, instead of when the response ends: the update,
// branch-change and plugin-install pages are progress listings that would sit
// blank until they finished.

test.skip(!container, 'adds a scratch PHP page inside the run-web.sh container');

const PAGE = '/opt/fpp/www/zz-fpp-tests-stream.php';

test.afterEach(() => {
  inPlayer('rm', '-f', PAGE);
});

test('flushed PHP output arrives before the page has finished', async ({ baseURL }) => {
  // Regression: a3fcb56e0.  Apache's fcgi proxy to php-fpm buffered a response
  // until its 16K buffer filled; flushpackets=on on the proxy sends each flush
  // on.  A page that prints a line, flushes and then works for three seconds
  // has to show the line in well under that.
  putFile(PAGE, '<?php\nheader("Content-Type: text/plain");\necho "first\\n";\nob_flush();\nflush();\nsleep(3);\necho "second\\n";\n');
  inPlayer('chmod', '644', PAGE);
  const t0 = Date.now();
  const arrivals: { at: number; text: string }[] = await new Promise((resolve, reject) => {
    const seen: { at: number; text: string }[] = [];
    const req = http.get(new URL('/zz-fpp-tests-stream.php', baseURL), (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => seen.push({ at: Date.now() - t0, text: d }));
      res.on('end', () => resolve(seen));
    });
    req.on('error', reject);
  });
  expect(arrivals.map((a) => a.text).join('')).toBe('first\nsecond\n');
  const first = arrivals.find((a) => a.text.includes('first'))!;
  expect(first.at, `"first" came after ${first.at}ms`).toBeLessThan(2000);
  expect(arrivals[arrivals.length - 1].at).toBeGreaterThan(2500);
});
