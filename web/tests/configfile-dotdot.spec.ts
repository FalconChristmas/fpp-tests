import { test, expect } from './fixtures';
import { container } from './container';
import { SETTINGS, readFile } from './settings-file';

// Regression: 7cf41c962 ("Prevent Path Traversal and Arbitrary File Access in
// Config and File APIs"). The config-file and file APIs joined the name they
// were given to their directory as it was, so a "../" in it (sent encoded
// twice, which gets it past Apache's own normalisation) read, replaced or
// deleted files outside the config directory -- the settings file next to it,
// or anything else root can reach. (A link to a sibling directory is
// path-containment.spec.ts.)

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const UP = '..%252F';

test('the config-file and file APIs refuse a name that climbs out of their directory', async ({ request }) => {
  const settings = readFile(SETTINGS);
  expect(settings).toContain('privacyConsent');
  for (const url of [`/api/configfile/${UP}settings`, `/api/file/config/${UP}settings`, `/api/file/config/${UP}${UP}${UP}etc%252Fpasswd`]) {
    const r = await request.get(url);
    const body = await r.text();
    expect(body, `${url} served a file outside its directory`).not.toContain('privacyConsent');
    expect(body, url).not.toContain('root:x:0:0');
    expect([400, 403, 404], `${url}: ${r.status()}`).toContain(r.status());

    // (Refused, though the file API's DELETE says so with a 200.)
    await request.post(url, { data: 'fpp-tests = "overwritten"\n' });
    await request.delete(url);
  }
  expect(readFile(SETTINGS), 'the settings file was replaced or deleted').toBe(settings);

  // The control: an ordinary name in the directory is served.
  expect((await request.get('/api/configfile/commandPresets.json')).status()).toBe(200);
});

// Regression: dcc98eb15 ("DELETE /api/file refuses a missing file or an
// outside path with a 4xx"). DeleteFile refused both with a 200 whose status
// said "Invalid path: directory traversal detected..."; the GET and POST
// routes refuse with a 403.
test('the file API answers a refused delete with a 4xx', async ({ request }) => {
  const settings = readFile(SETTINGS);
  const outside = await request.delete(`/api/file/config/${UP}settings`);
  expect(outside.status(), await outside.text()).toBe(403);
  const missing = await request.delete('/api/file/music/fpp-tests-no-such-file.mp3');
  expect(missing.status(), await missing.text()).toBe(404);
  expect((await missing.json()).status).toBe('File Not Found');
  expect(readFile(SETTINGS)).toBe(settings);
});
