import { test, expect } from './fixtures';
import http from 'http';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// A streamed page that does a long job ends at its next echo once the browser
// goes away (a closed tab, a reload), unless it asks PHP to carry on: the job
// is then left half done. Each test starts the job, drops the connection as
// soon as the first bytes arrive, and checks later that the job finished.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// GET a page and hang up once it has started answering.
function startAndHangUp(path: string): Promise<string> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(path, base), { agent: false }, (res) => {
      res.once('data', (chunk: Buffer) => {
        req.destroy();
        resolve(chunk.toString());
      });
    });
    req.on('error', (e) => (req.destroyed ? undefined : reject(e)));
    req.setTimeout(60_000, () => req.destroy(new Error('the page never started answering')));
  });
}

// Regression: f4be25ad3 (Reset Config finishes once started). A closed tab
// stopped PHP at the next line it printed, part way through deleting the
// chosen areas.
test('Reset Config finishes the areas it was given after the browser goes', async () => {
  const uploads = `${MEDIA}/upload`;
  const last = `${MEDIA}/effects/fpp-tests-last.eseq`;
  // Enough files that their names are still being printed well after the
  // connection is gone.
  inPlayer('sh', '-c', `mkdir -p ${uploads}/fpp-tests-many && cd ${uploads}/fpp-tests-many && seq 1 20000 | sed 's/^/fpp-tests-file-/' | xargs touch`);
  putFile(last, 'fpp-tests');
  try {
    const first = await startAndHangUp('/resetConfig.php?areas=uploads,effects');
    expect(first).toContain('Resetting FPP Configuration');
    await expect.poll(() => exists(last), { timeout: 60_000, message: 'the reset stopped when the browser went away' }).toBe(false);
    expect(exists(`${uploads}/fpp-tests-many`)).toBe(false);
  } finally {
    inPlayer('rm', '-rf', `${uploads}/fpp-tests-many`, last);
  }
});

// Regression: 0bc5f0adf ("finish long operations when the browser goes
// away"). In packagesHelper.php apt carried on after the browser went, but PHP
// stopped at its next echo and never recorded the package: it could not be
// uninstalled from the page, nor replayed after an OS reflash. apt-get and
// apt-cache are stood in for by scripts that print slowly and succeed.
test('a package install is recorded after the browser goes', async ({ request }) => {
  const PKG = 'fpp-tests-pkg';
  const MANIFEST = `${MEDIA}/config/userpackages.json`;
  const hadManifest = exists(MANIFEST);
  const manifest = hadManifest ? readFile(MANIFEST) : '';
  putFile('/usr/local/bin/apt-get', `#!/bin/sh
# fpp-tests stand-in for apt-get
case " $* " in
  *" -s "*) echo "Inst ${PKG} (1.0 fpp-tests [all])"; exit 0 ;;
esac
i=0
while [ $i -lt 30 ]; do echo "fpp-tests apt-get $* line $i"; sleep 0.1; i=$((i+1)); done
exit 0
`);
  putFile('/usr/local/bin/apt-cache', `#!/bin/sh
# fpp-tests stand-in for apt-cache
if [ "$1" = pkgnames ]; then echo ${PKG}; exit 0; fi
exec /usr/bin/apt-cache "$@"
`);
  inPlayer('chmod', '+x', '/usr/local/bin/apt-get', '/usr/local/bin/apt-cache');
  try {
    await startAndHangUp(`/packagesHelper.php?action=install&package=${PKG}`);
    await expect.poll(async () => Object.keys(await (await request.get('/packagesHelper.php')).json()),
      { timeout: 60_000, message: 'the installed package was never recorded' }).toContain(PKG);
  } finally {
    inPlayer('rm', '-f', '/usr/local/bin/apt-get', '/usr/local/bin/apt-cache');
    if (hadManifest) putFile(MANIFEST, manifest); else inPlayer('rm', '-f', MANIFEST);
  }
});
