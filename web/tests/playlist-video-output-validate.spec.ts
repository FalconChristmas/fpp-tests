import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// What the playlist validation says about a media entry's video output.  It
// must name one that is missing and never a healthy entry, so it answers yes
// whenever it can't tell.

const NAME = 'fpp-tests-video-output-validate';

test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
});

async function messages(request: any, videoOuts: string[]) {
  const mainPlaylist = videoOuts.map((videoOut) => ({ type: 'media', enabled: 1, playOnce: 0, mediaName: 'fpp-tests-none.mp3', videoOut }));
  const saved = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(saved.ok()).toBe(true);
  const all = await (await request.get('/api/playlists/validate')).json();
  const p = all.find((x: { name: unknown }) => x.name === NAME);
  expect(p, JSON.stringify(all)).toBeTruthy();
  return p.issues.map((i: { message: string }) => i.message).filter((m: string) => m.startsWith('Video output'));
}

test('a video output the system does not have is reported, the built-in choices are not', async ({ request }) => {
  // Regression: e7af31507.  A gone overlay model looked like a valid choice,
  // and the only sign of it was a log line at playback.  "null" is what an empty
  // select used to save.
  expect(await messages(request, ['fpp-tests-gone-model', 'null', '--Default--', 'Disabled', '--Disabled--', '--HDMI--', '']))
    .toEqual(["Video output 'fpp-tests-gone-model' not found", "Video output 'null' not found"]);
});

test('a video output is only reported when the system can tell', () => {
  // Regression: e7af31507.  With fppd down there are no models to compare a
  // name with, and without /sys/class/drm no connectors; neither is a problem
  // with the entry.  In a PHP of its own, as a container can't hide sysfs.
  test.skip(!container, 'runs PHP in the run-web.sh container');
  const php = (code: string, ...ini: string[]) => inPlayer('php', ...ini, '-d', 'display_errors=1', '-d', 'html_errors=0', '-r',
    'require "/opt/fpp/www/api/controllers/playlist.php"; ' + code).trim().split('\n').pop();
  const check = (name: string, models: string) =>
    `$c = array("videoOutputModels" => ${models}); echo json_encode(validationVideoOutputExists("${name}", $c));`;
  expect(php(check('fpp-tests-model', 'null')), 'fppd down').toBe('true');
  expect(php(check('fpp-tests-model', 'array("fpp-tests-model")')), 'a model fppd has').toBe('true');
  expect(php(check('fpp-tests-model', 'array("another")')), 'a model fppd lacks').toBe('false');
  expect(php(check('HDMI-A-9', 'null'), '-d', 'open_basedir=/opt/fpp/www:/tmp'), 'no DRM to compare with').toBe('true');
});
