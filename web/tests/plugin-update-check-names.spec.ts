import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The background plugin update check names the plugins it couldn't check.
// Fixed in fpp 6d85714bc ("fix(plugins): name the plugins whose update check
// failed #3046"); before it the result only said "1 of 2 could not be
// checked", and the per-plugin log line is written only when a verdict
// changes, so a lasting failure was named once and then only counted.
//
// Two clones: one whose origin is a local repository, which fetches, and one
// whose origin refuses the connection.  (With every fetch failing the pass
// counts as offline and names nothing, by design.)

test.skip(!container, 'seeds plugin clones inside the run-web.sh container');

const PLUGINS = '/home/fpp/media/plugins';
const SRC = '/tmp/fpp-tests-plugin-src';

test('the plugin update check names the plugin it could not check', async ({ request }) => {
  inPlayer('sh', '-c', `set -e
    rm -rf ${SRC} ${SRC}.git ${PLUGINS}/fpp-tests-good ${PLUGINS}/fpp-tests-broken
    mkdir -p ${SRC} && cd ${SRC} && git init -q -b master .
    echo '{"name":"fpp-tests-good","repoName":"fpp-tests-good","versions":[{"minFPPVersion":"0","maxFPPVersion":"0","branch":"master"}]}' > pluginInfo.json
    git add . && git -c user.name=t -c user.email=t@t commit -q -m init
    git clone -q --bare ${SRC} ${SRC}.git
    git clone -q ${SRC}.git ${PLUGINS}/fpp-tests-good
    git clone -q ${SRC}.git ${PLUGINS}/fpp-tests-broken
    git -C ${PLUGINS}/fpp-tests-broken remote set-url origin http://127.0.0.1:9/fpp-tests-broken.git`);
  try {
    // Run to completion here, before anything asks /api/plugin/updateStatus:
    // that endpoint starts a background pass of its own when none has run,
    // and a pass that finds a plugin's fetch lock taken skips it.
    inPlayer('sh', '-c', 'php /opt/fpp/scripts/plugin_update_check.php --force > /dev/null 2>&1 || true');
    // The control: the pass finished and counted one failure.  (Polled: the
    // endpoint reports a pass still recording as in progress.)
    let text = '';
    await expect.poll(async () => {
      text = await (await request.get('/api/plugin/updateStatus')).text();
      return text;
    }, { timeout: 30_000 }).toContain('1 of 2 could not be checked');
    expect(text).toContain('(fpp-tests-broken)');
  } finally {
    inPlayer('rm', '-rf', SRC, `${SRC}.git`, `${PLUGINS}/fpp-tests-good`, `${PLUGINS}/fpp-tests-broken`);
  }
});
