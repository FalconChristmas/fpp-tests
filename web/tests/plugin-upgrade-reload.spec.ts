import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Upgrading a plugin swaps the new version into the running fppd, with no
// restart.  Fixed in fpp 6c38a47c5 ("feat(plugins): an upgrade reloads the
// plugin in fppd instead of needing a restart"); before it an upgrade neither
// unloaded nor loaded the plugin, so fppd kept running the old version until
// it was restarted.
//
// The plugin is a clone of a repository inside the player: a script plugin
// (callbacks.sh, so fppd loads it) whose commands (commands/descriptions.json)
// fppd registers when it loads it, so they show which version fppd runs.

test.skip(!container, 'builds a plugin repository inside the run-web.sh container');

const PLUGIN = 'fpp-tests-reload';
const DIR = `/home/fpp/media/plugins/${PLUGIN}`;
const SRC = '/tmp/fpp-tests-reload-src';

function commit(version: string) {
  inPlayer('sh', '-c', `set -e; cd ${SRC}
    mkdir -p commands
    printf '#!/bin/sh\\ncase "$1" in --list) echo playlist ;; esac\\nexit 0\\n' > callbacks.sh; chmod 755 callbacks.sh
    printf '#!/bin/sh\\nexit 0\\n' > commands/run.sh; chmod 755 commands/run.sh
    printf '[{"name":"FPPTests Cmd ${version}","script":"run.sh","args":[]}]\\n' > commands/descriptions.json
    git add -A && git -c user.name=t -c user.email=t@t commit -q -m ${version}
    git push -q origin master`);
}

async function commandNames(request: any): Promise<string[]> {
  return ((await (await request.get('/api/commands')).json()) as { name: string }[]).map((c) => c.name);
}

test('a plugin upgrade reloads the plugin in the running fppd', async ({ request }) => {
  inPlayer('sh', '-c', `set -e; rm -rf ${SRC} ${SRC}.git ${DIR}
    git init -q --bare -b master ${SRC}.git
    git init -q -b master ${SRC} && cd ${SRC} && git remote add origin ${SRC}.git
    echo '{"name":"${PLUGIN}","repoName":"${PLUGIN}","srcURL":"${SRC}.git","versions":[{"minFPPVersion":"0","maxFPPVersion":"0","branch":"master"}]}' > pluginInfo.json`);
  try {
    commit('v1');
    inPlayer('git', 'clone', '-q', `${SRC}.git`, DIR);
    const load = await request.post(`/api/fppd/plugin/${PLUGIN}/load`);
    expect(load.ok(), await load.text()).toBe(true);
    // The control: fppd runs v1.
    expect(await commandNames(request)).toContain('FPPTests Cmd v1');

    commit('v2');
    const up = await request.post(`/api/plugin/${PLUGIN}/upgrade`, { timeout: 120_000 });
    const out = await up.text();
    expect(inPlayer('git', '-C', DIR, 'log', '-1', '--format=%s').trim(), `the upgrade did not update the clone:\n${out}`).toBe('v2');
    expect(await commandNames(request), `fppd still runs the old version:\n${out}`).toContain('FPPTests Cmd v2');
  } finally {
    await request.post(`/api/fppd/plugin/${PLUGIN}/unload`);
    inPlayer('rm', '-rf', SRC, `${SRC}.git`, DIR);
  }
});
