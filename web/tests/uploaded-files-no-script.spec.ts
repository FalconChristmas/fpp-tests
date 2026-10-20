import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Files a user or a remote put on the player never run as pages of the
// player's own origin, which would give their script the whole API.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const HTML = '<html><body><script>window.__ran = 1;</script>fpp-tests</body></html>';

function header(r: { headersArray(): { name: string; value: string }[] }, name: string): string {
  return r.headersArray().filter((h) => h.name.toLowerCase() === name).map((h) => h.value).join(' | ');
}

test('an image holding HTML is served by its extension, sandboxed', async ({ request }) => {
  // Regression: 8ec71211f.  GetFileImpl() typed Images with
  // mime_content_type(), so an "x.png" holding HTML came back as text/html,
  // with no nosniff and no sandbox.
  const path = `${MEDIA}/images/fpp-tests-page.png`;
  inPlayer('sh', '-c', `printf '%s' '${HTML}' > ${path}`);
  try {
    const r = await request.get('/api/file/Images/fpp-tests-page.png');
    expect(r.status()).toBe(200);
    expect(header(r, 'content-type')).toBe('image/png');
    expect(header(r, 'x-content-type-options')).toContain('nosniff');
    expect(header(r, 'content-security-policy')).toMatch(/\bsandbox\b/);
  } finally {
    inPlayer('rm', '-f', path);
  }
});

test('a played file of an unknown type is not served as HTML', async ({ request }) => {
  // Regression: 8ec71211f.  With ?play=1 a type it did not recognise got
  // PHP's default text/html.
  const path = `${MEDIA}/music/fpp-tests-page.fpptests`;
  inPlayer('sh', '-c', `printf '%s' '${HTML}' > ${path}`);
  try {
    const r = await request.get('/api/file/Music/fpp-tests-page.fpptests?play=1');
    expect(r.status()).toBe(200);
    expect(header(r, 'content-type')).not.toContain('text/html');
    expect(header(r, 'content-security-policy')).toMatch(/\bsandbox\b/);
  } finally {
    inPlayer('rm', '-f', path);
  }
});

for (const ext of ['php', 'phar', 'php7']) {
  test(`a .${ext} file put in virtualdisplay_assets does not run`, async ({ request }) => {
    // Regression: 0fd5a3227.  virtualdisplay_assets is linked into the web
    // root and the file API writes to it, so php-fpm ran a .php put there.
    const name = `fpp-tests-run.${ext}`;
    const up = await request.post(`/api/file/virtualdisplay_assets/${name}`, { data: '<?php echo "RAN" . (1 + 1);' });
    expect(up.ok(), await up.text()).toBe(true);
    try {
      const r = await request.get(`/virtualdisplay_assets/${name}`);
      expect(await r.text()).not.toContain('RAN2');
      expect(r.status()).toBe(403);
    } finally {
      await request.delete(`/api/file/virtualdisplay_assets/${name}`);
    }
  });
}
