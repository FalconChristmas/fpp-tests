import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// The banners every page shows when the media directory is unusable --
// missing, not writable, short of space or inodes, or a drive /etc/fstab
// mounts there that is not mounted -- and what each says about why.  The
// media directory is moved by rewriting www/media_root.txt for one request,
// as media-dir-and-kiosk.spec.ts does; php-fpm runs as root in the player,
// so "cannot create" and "not writable" are made with paths under /proc and
// /sys, which root cannot write either.

test.skip(!container, 'changes files inside the run-web.sh container');

const ROOT = '/opt/fpp/www/media_root.txt';
// A page with the menu (and so the banners) on a player not set up yet.
const PAGE = '/initialSetup.php';

// The page PAGE renders with media_root.txt holding `bytes` (printf's
// format: \000 is a NUL byte).  Returns the status and body.
async function pageWith(request: APIRequestContext, bytes: string) {
  const saved = inPlayer('cat', ROOT);
  inPlayer('sh', '-c', `printf "$1" > ${ROOT}`, 'sh', bytes);
  try {
    const r = await request.get(PAGE);
    return { status: r.status(), body: await r.text() };
  } finally {
    inPlayer('sh', '-c', `printf '%s' "$1" > ${ROOT}`, 'sh', saved);
  }
}

// The banner's text, tags dropped and whitespace squeezed.
function banner(body: string, what: RegExp) {
  const m = body.match(new RegExp(`<div class="alert alert-danger"><b>WARNING:</b>((?:(?!</div>)[\\s\\S])*?(?:${what.source})[\\s\\S]*?)</div>`));
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
}

test.describe('a media_root.txt that names no usable folder', () => {
  test.afterEach(() => {
    inPlayer('sh', '-c', 'rm -rf /opt/fpp/www/fpp-tests-relative /fpp-tests-relative /tmp/fpp-tests-file /tmp/fpp-tests-loop');
  });

  test('a NUL byte in it leaves the pages up, with the banner, instead of a fatal error', async ({ request }) => {
    // Regression: 24644a06e.  mkdir() threw a ValueError on the NUL, which
    // @ does not silence, so every page and API call died.
    const r = await pageWith(request, '/home/fpp/med\\000ia');
    expect(r.body).not.toMatch(/Fatal error|ValueError|must not contain any null bytes/);
    expect(r.status).toBe(200);
    expect(banner(r.body, /does not/)).toMatch(/the media directory \S+ does not exist/);
  });

  test('a relative path in it is not created under the web server\'s working directory', async ({ request }) => {
    // Regression: 24644a06e.  "fpp-tests-relative/media" was created inside
    // /opt/fpp/www, passed is_dir(), and every setting and upload went there.
    const r = await pageWith(request, 'fpp-tests-relative/media');
    expect(r.status).toBe(200);
    expect(inPlayer('sh', '-c', 'ls -d /opt/fpp/www/fpp-tests-relative /fpp-tests-relative 2>/dev/null; true').trim()).toBe('');
    expect(banner(r.body, /does not/), 'the control: it is reported as missing').toContain('fpp-tests-relative/media does not');
  });

  test('the missing-media banner names the step of the path that fails', async ({ request }) => {
    // Feature: 5b1e3c30c.  The banner said only that the directory did not
    // exist; it now walks the path and names the first step that fails.
    inPlayer('sh', '-c', 'printf x > /tmp/fpp-tests-file && ln -sfn /tmp/fpp-tests-loop /tmp/fpp-tests-loop');
    const cases: Array<[string, string]> = [
      // Under /proc, so mkdir cannot make it.
      ['/proc/fpp-tests-missing/media', 'Why: /proc/fpp-tests-missing does not exist'],
      ['/tmp/fpp-tests-file/media', 'Why: /tmp/fpp-tests-file (root:root 0644) is a file, not a folder'],
      ['/tmp/fpp-tests-loop/media', 'Why: the symlinks under /tmp/fpp-tests-loop/media loop back on themselves'],
      ['fpp-tests-relative/media', 'Why: the path "fpp-tests-relative/media" is not absolute (it does not start with /)'],
      ['/home/fpp/med\\000ia', 'Why: the path in media_root.txt contains a NUL byte'],
    ];
    for (const [root, why] of cases) {
      const text = banner((await pageWith(request, root)).body, /does not/);
      expect(text, root).toContain(`It is set by ${ROOT}.`);
      expect(text, root).toContain(why);
    }
    // And its evidence: the bytes of a media_root.txt holding a NUL, and
    // mkdir's error for the one it could not make.
    expect(banner((await pageWith(request, '/home/fpp/med\\000ia\\n')).body, /does not/))
      .toContain('media_root.txt holds "/home/fpp/med\\x00ia\\x0a" (17 bytes)');
    expect(banner((await pageWith(request, '/proc/fpp-tests-missing/media')).body, /does not/))
      .toMatch(/Details: .*creating it: .*No such file or directory/);
  });
});
