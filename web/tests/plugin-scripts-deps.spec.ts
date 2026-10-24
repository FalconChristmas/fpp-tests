import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, PLUGINS, exists, pluginInfo, restoreState, saveState, sh } from './plugin-repo';

// What a plugin's own files make the Plugin Manager do: its scripts (however
// they were committed), its own update check and upgrade script, and the
// Python packages its pluginInfo.json declares.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const repos: PluginRepo[] = [];
function newRepo(name: string): PluginRepo {
  const r = new PluginRepo(name);
  repos.push(r);
  return r;
}

test.beforeEach(saveState);
test.afterEach(() => {
  const names = repos.map((r) => r.name);
  for (const r of repos.splice(0)) r.remove();
  restoreState(names);
  sh('rm -f /tmp/fpp-tests-scripts-*');
});

async function install(request: any, repo: PluginRepo): Promise<any> {
  const r = await request.post('/api/plugin', { data: repo.body(), timeout: 180_000 });
  const text = await r.text();
  // Before 10.0's install rework the JSON came after the install's own output.
  const json = text.slice(text.indexOf('{'));
  try { return JSON.parse(json); } catch { return { raw: text }; }
}

const isExecutable = (path: string) => sh(`[ -x '${path}' ] && echo yes || echo no`).trim() === 'yes';

test('a plugin whose scripts were committed without the executable bit still has its install script run', async ({ request }) => {
  // Regression: 3b7f320e0.  git keeps a file's mode, so a plugin whose
  // author committed scripts/fpp_install.sh (and its callbacks) at 0644
  // cloned in non-executable, and the is_executable() gate skipped the
  // install script without a word.  Now the files FPP runs are made
  // executable after the clone.
  const NAME = 'fpp-tests-scripts-mode';
  const marker = '/tmp/fpp-tests-scripts-installed';
  const repo = newRepo(NAME);
  repo.commit({
    'pluginInfo.json': pluginInfo(NAME),
    'scripts/fpp_install.sh': { content: `#!/bin/sh\ntouch ${marker}\n`, mode: '644' },
    'callbacks': { content: '#!/bin/sh\necho\n', mode: '644' },
  });
  // The control: the clone really is 0644.
  expect(sh(`git -C ${repo.src} ls-files -s scripts/fpp_install.sh callbacks | cut -c1-6 | sort -u`).trim()).toBe('100644');

  const r = await install(request, repo);
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  expect(exists(marker), 'the install script ran').toBe(true);
  for (const f of ['scripts/fpp_install.sh', 'callbacks']) {
    expect(isExecutable(`${PLUGINS}/${NAME}/${f}`), `${f} is executable`).toBe(true);
  }
});

test('fppd runs the callbacks of a plugin committed without the executable bit', async ({ request }) => {
  // The receiving end of 3b7f320e0: an install loads the plugin into the
  // running fppd (07f19dda1), which runs its callbacks script with --list
  // to learn what it hooks; a callbacks file committed at 0644 could not be
  // run.  This one answers that it hooks nothing, so fppd keeps nothing
  // loaded once the test is over.
  const NAME = 'fpp-tests-scripts-callbacks';
  const marker = '/tmp/fpp-tests-scripts-callbacks-listed';
  const repo = newRepo(NAME);
  repo.commit({
    'pluginInfo.json': pluginInfo(NAME),
    'callbacks': { content: `#!/bin/sh\ncase "$1" in\n    --list) touch ${marker}; echo ;;\nesac\n`, mode: '644' },
  });
  const r = await install(request, repo);
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  // fppd loads it on the main loop: give it a moment.
  for (let i = 0; i < 50 && !exists(marker); i++) await new Promise((res) => setTimeout(res, 100));
  expect(exists(marker), "fppd ran the plugin's callbacks --list").toBe(true);
});

test("a plugin's own update check and upgrade script decide and do its update", async ({ request }) => {
  // Feature: 8f72f1002.  A plugin whose artifacts live outside git (a
  // release binary) can say it has an update: scripts/fpp_update_check.sh's
  // last line "1" is an update even with no new commits, "0" or a failed
  // run is not; and an update runs scripts/fpp_upgrade.sh after the pull,
  // in place of re-running fpp_install.sh.
  const NAME = 'fpp-tests-scripts-own-check';
  const installed = '/tmp/fpp-tests-scripts-own-install';
  const upgraded = '/tmp/fpp-tests-scripts-own-upgrade';
  const answer = '/tmp/fpp-tests-scripts-own-answer';
  const repo = newRepo(NAME);
  repo.commit({
    'pluginInfo.json': pluginInfo(NAME),
    'scripts/fpp_install.sh': { content: `#!/bin/sh\necho run >> ${installed}\n`, mode: '755' },
    'scripts/fpp_upgrade.sh': { content: `#!/bin/sh\necho run >> ${upgraded}\n`, mode: '755' },
    // Prints the contents of $answer; exits with its second line, if any.
    'scripts/fpp_update_check.sh': { content: `#!/bin/sh\necho checking\nhead -1 ${answer}\nexit $(sed -n 2p ${answer} | grep . || echo 0)\n`, mode: '755' },
  });
  sh(`echo 0 > ${answer}`);
  expect((await install(request, repo)).Status).toBe('OK');
  sh(`rm -f ${installed}`);

  const check = async () => {
    const r = await request.post(`/api/plugin/${NAME}/updates`, { data: '', timeout: 120_000 });
    return (await r.json()).updatesAvailable;
  };
  // The control: no new commits, and the script says none.
  expect(await check(), 'answer 0').toBe(0);
  sh(`echo 1 > ${answer}`);
  expect(await check(), 'answer 1').toBe(1);
  sh(`printf '1\\n3\\n' > ${answer}`);
  expect(await check(), 'answer 1, but the check failed').toBe(0);

  // FPPOS trusts every repository (SD/FPP_Install.sh: safe.directory '*');
  // the container may not, and the update's root "git pull" in the
  // fpp-owned clone needs it before FPP passed safe.directory itself.
  const trusted = sh(`git config --system --get-all safe.directory | grep -qxF '*' && echo yes || echo no`).trim() === 'yes';
  if (!trusted) sh(`git config --system --add safe.directory '*'`);
  try {
    repo.commit({ 'v.txt': '2\n' }, 'v2');
    // Streamed: until later, the plain reply took the script's output array
    // for its exit status and said "Could not run git pull" whenever a
    // script ran.
    const up = await request.post(`/api/plugin/${NAME}/upgrade?stream=true`, { timeout: 180_000 });
    expect(up.ok(), await up.text()).toBe(true);
    expect(sh(`git -c safe.directory='*' -C ${PLUGINS}/${NAME} log -1 --format=%s`).trim(), 'the update pulled v2').toBe('v2');
    expect(exists(upgraded), 'fpp_upgrade.sh ran').toBe(true);
    expect(exists(installed), 'fpp_install.sh ran on the update').toBe(false);
  } finally {
    if (!trusted) sh(`git config --system --unset-all safe.directory '^\\*$' || true`);
  }
});

// A stand-in for python3 in /usr/local/bin (ahead of /usr/bin in PATH and in
// sudo's secure_path): "python3 -m pip ..." is logged and answered as the test
// sets up in /tmp/fpp-tests-scripts-pip (absent: pip is there and every
// install works; "nopip": there is no pip; "fail": installs fail); anything
// else runs the real python3.
const PIP_LOG = '/tmp/fpp-tests-scripts-pip.log';
const PIP_MODE = '/tmp/fpp-tests-scripts-pip';
function standInPip() {
  sh(`cat > /usr/local/bin/python3 <<'SH'
#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
    shift 2
    echo "pip $*" >> ${PIP_LOG}
    mode=$(cat ${PIP_MODE} 2>/dev/null)
    [ "$mode" = nopip ] && { echo "/usr/bin/python3: No module named pip" >&2; exit 1; }
    case "$1" in
        --version) echo "pip 25.1 from /usr/lib/python3/dist-packages/pip (python 3.13)"; exit 0 ;;
        install) [ "$mode" = fail ] && { echo "ERROR: No matching distribution" >&2; exit 1; }; echo "Successfully installed"; exit 0 ;;
    esac
    exit 0
fi
exec /usr/bin/python3 "$@"
SH
chmod 755 /usr/local/bin/python3; rm -f ${PIP_LOG} ${PIP_MODE}`);
}

test("a plugin's declared Python packages are installed with pip, and the install fails when they can't be", async ({ request }) => {
  // Feature: fbb0b5662 (a pluginInfo.json "dependencies": {"python": [...]}
  // is installed with the plugin, and an install that can't install them
  // fails and is removed).  Regression: c042791c0 (that was done with uv,
  // which FPP's image does not ship, so every such plugin was refused; now it
  // is pip, which the image provisions).
  test.setTimeout(240_000);
  const NAME = 'fpp-tests-scripts-python';
  const repo = newRepo(NAME);
  repo.commit({ 'pluginInfo.json': pluginInfo(NAME, { dependencies: { python: ['fpp-tests-pydep'] } }) });
  standInPip();
  try {
    let r = await install(request, repo);
    expect(r.Status, JSON.stringify(r)).toBe('OK');
    const log = () => sh(`cat ${PIP_LOG} 2>/dev/null || true`);
    expect(log(), 'the pip calls').toMatch(/^pip install .*fpp-tests-pydep$/m);
    expect(exists(`${PLUGINS}/${NAME}/pluginInfo.json`)).toBe(true);

    // pip fails to install it: the plugin is not installed.
    sh(`rm -rf '${PLUGINS}/${NAME}'; echo fail > ${PIP_MODE}`);
    r = await install(request, repo);
    expect(r.Status, JSON.stringify(r)).not.toBe('OK');
    expect(exists(`${PLUGINS}/${NAME}`), 'the failed install was left behind').toBe(false);

    // No pip at all: refused, saying why, and nothing left behind.
    sh(`echo nopip > ${PIP_MODE}`);
    const out = await (await request.post('/api/plugin?stream=true', { data: repo.body(), timeout: 180_000 })).text();
    expect(out).toContain('requires Python package dependencies but \'pip\' is not available');
    expect(exists(`${PLUGINS}/${NAME}`), 'the refused install was left behind').toBe(false);
  } finally {
    sh(`rm -f /usr/local/bin/python3 ${PIP_LOG} ${PIP_MODE}`);
  }
});
