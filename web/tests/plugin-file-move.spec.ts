import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// An upload a plugin claims (pluginInfo.json "fileExtensions") is moved only
// into the media directory, and a download's suggested filename can't break
// out of its header.  Before fpp 79f8cd70d ("fix(security): Plugin-driven
// file-move escape and download header injection"), MovePluginFile() renamed
// the upload to <media>/<folder>/<name> with the plugin's "folder" unchecked,
// "../" included, and GetFileImpl() wrote the file name into
// Content-Disposition as it was, quotes included.

test.skip(!container, 'seeds a plugin and files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const PLUGIN = `${MEDIA}/plugins/fpp-tests-mv`;

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}

test("a plugin's file folder can't move an upload out of the media directory", async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${PLUGIN} && cat > ${PLUGIN}/pluginInfo.json <<'JSON'
{"name":"fpp-tests-mv","repoName":"fpp-tests-mv","fileExtensions":{
  ".fpptestsout":{"folder":"../../../tmp"},
  ".fpptestsok":{"folder":"music"}}}
JSON
echo x > ${MEDIA}/upload/fpp-tests.fpptestsout; echo x > ${MEDIA}/upload/fpp-tests.fpptestsok`);
  try {
    // The control: a folder inside the media directory gets the upload.
    const ok = await request.get('/api/file/move/fpp-tests.fpptestsok');
    expect(await ok.text()).toContain('"OK"');
    expect(exists(`${MEDIA}/music/fpp-tests.fpptestsok`)).toBe(true);

    const r = await request.get('/api/file/move/fpp-tests.fpptestsout');
    const body = await r.text();
    expect(exists('/tmp/fpp-tests.fpptestsout'), `moved outside the media directory: ${body}`).toBe(false);
    expect(exists(`${MEDIA}/upload/fpp-tests.fpptestsout`)).toBe(true);
  } finally {
    inPlayer('rm', '-rf', PLUGIN, '/tmp/fpp-tests.fpptestsout', `${MEDIA}/upload/fpp-tests.fpptestsout`,
      `${MEDIA}/upload/fpp-tests.fpptestsok`, `${MEDIA}/music/fpp-tests.fpptestsok`);
  }
});

test("a download's filename stays one quoted value in Content-Disposition", async ({ request }) => {
  inPlayer('sh', '-c', `echo x > '${MEDIA}/music/fpp-tests"q.mp3'`);
  try {
    const r = await request.get('/api/file/Music/fpp-tests%22q.mp3?attach=1');
    expect(r.status()).toBe(200);
    const cd = r.headers()['content-disposition'] || '';
    expect(cd).toContain('fpp-tests');
    expect((cd.match(/"/g) || []).length, cd).toBe(2);
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/music/fpp-tests"q.mp3`);
  }
});
