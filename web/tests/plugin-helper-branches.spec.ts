import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { php, writeFile } from './privacy-helpers';

// Pure helpers in plugin.php: how a dependencies block is read, how a plugin's
// source URL identifies its repo, how versions compare, and how package-change
// records are capped, merged and described.  All of them run in the player as
// the Plugin Manager runs them, without reaching the network.

test.skip(!container, 'runs PHP inside the run-web.sh container');

const PLUGINS = '/tmp/fpp-tests-plugin-helpers';

function pluginPhp(code: string): any {
  const out = php(`
require_once '/opt/fpp/www/api/controllers/plugin.php';
${code}
`);
  return JSON.parse(out.trim().split('\n').pop()!);
}

test.afterEach(() => inPlayer('rm', '-rf', PLUGINS));

test('a dependencies block is read only when it declares something usable', () => {
  const out = pluginPhp(`
echo json_encode(array(
  'packagesNo' => DepsRequirePackages(null),
  'packagesEmpty' => DepsRequirePackages(array('packages' => array())),
  'packagesBlank' => DepsRequirePackages(array('packages' => array('', 'git'))),
  'packagesYes' => DepsRequirePackages(array('packages' => array('git'))),
  'pythonNo' => DepsRequirePython(array('python' => 'requests')),
  'pythonBlank' => DepsRequirePython(array('python' => array(''))),
  'pythonYes' => DepsRequirePython(array('python' => array('requests'))),
  'mergeNone' => MergePluginDependencies(null, null),
  'merge' => MergePluginDependencies(
    array('packages' => array('a'), 'python' => array('p')),
    array('dependencies' => array('packages' => array('b'), 'plugins' => array('q')))),
  'noVersions' => SelectPluginVersionEntry(array()),
));
`);
  expect(out).toEqual({
    packagesNo: false, packagesEmpty: false, packagesBlank: true, packagesYes: true,
    pythonNo: false, pythonBlank: false, pythonYes: true, mergeNone: null,
    merge: { packages: ['a', 'b'], python: ['p'], plugins: ['q'] }, noVersions: null,
  });
});

test('a clone URL is judged by host and owner, and versions compare as numbers', () => {
  const out = pluginPhp(`
echo json_encode(array(
  'official' => IsOfficialPluginSrcURL('https://github.com/FalconChristmas/fpp-plugin-X'),
  'noSegments' => IsOfficialPluginSrcURL('https://github.com/'),
  'unofficial' => IsOfficialPluginSrcURL('https://github.com/someone-else/fpp-plugin-X'),
  'badURL' => IsOfficialPluginSrcURL('not a url'),
  'slugGitHub' => PluginRepoSlugFromURL('https://github.com/Owner/Repo.git'),
  'slugRaw' => PluginRepoSlugFromURL('https://raw.githubusercontent.com/Owner/Repo/master/pluginInfo.json'),
  'slugOtherHost' => PluginRepoSlugFromURL('https://gitlab.com/Owner/Repo'),
  'slugShort' => PluginRepoSlugFromURL('https://github.com/Owner'),
  'slugNull' => PluginRepoSlugFromURL(null),
  'v' => PluginVersionToNumber('v1.2.3'),
  'short' => PluginVersionToNumber('10.2'),
  'dash' => PluginVersionToNumber('10.2.3-foo'),
  'capped' => PluginVersionToNumber('9999.0.0'),
  'clamped' => PluginVersionToNumber('100.0.0'),
  'less' => ComparePluginFPPVersions('10.2.3', '10.2.4'),
  'equal' => ComparePluginFPPVersions('v10.2', '10.2.0'),
));
`);
  expect(out).toEqual({
    official: true, noSegments: false, unofficial: false, badURL: false,
    slugGitHub: 'owner/repo', slugRaw: 'owner/repo', slugOtherHost: '', slugShort: '', slugNull: '',
    v: 10203, short: 100200, dash: 100203, capped: 9999, clamped: 990000,
    less: -1, equal: 0,
  });
});

test('package changes are sorted, capped, merged and described without guessing', () => {
  const out = pluginPhp(`
$c = array();
PluginPackageChangesKeep($c, 'removed', array('zebra', 'alpha 1.0', 'zebra'));
$capped = array();
$many = array();
for ($i = 0; $i < 51; $i++) { $many[] = 'pkg' . $i; }
PluginPackageChangesKeep($capped, 'added', $many);
$merged = PluginPackageChangesMerge(
  array('added' => array('pkg 1.0'), 'unknown' => true),
  array('removed' => array('pkg')));
echo json_encode(array(
  'kept' => $c,
  'capped' => $capped,
  'mergeEmpty' => PluginPackageChangesMerge(array(), array()),
  'merged' => $merged,
  'addedOnly' => PluginPackageChangesText('install', 'fpp-tests', array('added' => array('pkg 1.0'), 'addedCount' => 1)),
  'text' => PluginPackageChangesText('install', 'fpp-tests', array(
    'removed' => array('/etc/apt/sources.list.d/fpp-tests.list:all', 'zebra:amd64 1.0', 'alpha 2.0', 'beta 3.0', 'gamma 4.0', 'delta 5.0', 'epsilon 6.0'),
    'removedCount' => 9,
    'aptFiles' => array('/etc/apt/sources.list.d/x.list (added)'),
  ), 'installing dependencies'),
  'unknown' => PluginPackageChangesText('install', 'fpp-tests', array('unknown' => true)),
));
`);
  expect(out.kept).toEqual({ removed: ['alpha 1.0', 'zebra', 'zebra'] });
  expect(out.capped.added).toHaveLength(50);
  expect(out.capped.addedCount).toBe(51);
  expect(out.mergeEmpty).toBeNull();
  expect(out.merged).toEqual({ addedRemoved: ['pkg 1.0'], unknown: true });
  expect(out.addedOnly).toBe('');
  expect(out.text).toContain('System packages changed while FPP was installing dependencies');
  expect(out.text).toContain('removed 9 (sources.list.d/fpp-tests.list, zebra, alpha, beta, gamma, ...)');
  expect(out.text).toContain('apt sources/keys/pins 1 (sources.list.d/x.list (added))');
  expect(out.unknown).toContain('Could not tell which system packages changed while fpp-tests\'s install script was running');
  expect(out.unknown).toContain('the package list could not be read');
});

test('installed plugins are found by their manifest, and their own files are recognised', () => {
  inPlayer('mkdir', '-p', `${PLUGINS}/alpha/scripts`);
  inPlayer('mkdir', '-p', `${PLUGINS}/beta`);
  inPlayer('touch', `${PLUGINS}/alpha/scripts/install`);
  writeFile(`${PLUGINS}/alpha/pluginInfo.json`, JSON.stringify({
    dependencies: { packages: ['git'] },
    versions: [{ branch: 'main', dependencies: { python: ['requests'] } }],
  }));

  const out = pluginPhp(`
$settings['pluginDirectory'] = '${PLUGINS}';
$ext = null;
$goodIcon = PluginIconURLIsAllowed('https://raw.githubusercontent.com/Owner/Repo/master/icon.png', $ext);
$goodExt = $ext;
$badIcon = PluginIconURLIsAllowed('https://example.com/icon.png', $ext);
echo json_encode(array(
  'names' => InstalledPluginNames(),
  'ownScript' => PluginHasOwnScript('alpha', array('install')),
  'noScript' => PluginHasOwnScript('beta', array('install')),
  'icon' => array($goodIcon, $goodExt, $badIcon, $ext),
  'deps' => PluginDeclaredDependencies('alpha'),
  'missingDeps' => PluginDeclaredDependencies('beta'),
  'version' => SelectPluginVersion(array('versions' => array(array('branch' => 'main', 'sha' => 'abc')))),
  'noVersion' => SelectPluginVersion(array()),
  'mayChangePackages' => DepsMayChangePackages(array('packages' => array('git'))),
  'declared' => DeclaredPackages(array('packages' => array('git:armhf', '', 'curl'))),
  'githubURL' => IsGitHubURL('https://api.github.com/repos/o/r'),
  'otherURL' => IsGitHubURL('https://example.com/o/r'),
  'streaming' => array(PluginStreaming(null), PluginStreaming('1')),
  'releaseNotesText' => PluginReleaseNotesText("\\xFF bad"),
));
`);
  expect(out.names).toEqual(['alpha']);
  expect(out.ownScript).toBe(true);
  expect(out.noScript).toBe(false);
  expect(out.icon).toEqual([true, 'png', false, null]);
  expect(out.deps).toEqual({ packages: ['git'], python: ['requests'] });
  expect(out.missingDeps).toBe(false);
  expect(out.version).toEqual({ branch: 'main', sha: 'abc' });
  expect(out.noVersion).toBeNull();
  expect(out.mayChangePackages).toBe(true);
  expect(out.declared).toEqual(['git', 'curl']);
  expect(out.githubURL).toBe(true);
  expect(out.otherURL).toBe(false);
  expect(out.streaming).toEqual([false, true]);
  expect(out.releaseNotesText).toContain('\uFFFD bad');
});

test('a release-notes style is offered only when its source is there', () => {
  inPlayer('mkdir', '-p', `${PLUGINS}/fpp-tests-script/scripts`);
  const out = pluginPhp(`
$settings['pluginDirectory'] = '${PLUGINS}';
$script = array('releaseNotesStyle' => 'script');
$git = array('releaseNotesStyle' => 'gitRelease', 'srcURL' => 'https://github.com/Owner/Repo.git');
echo json_encode(array(
  'scriptMissing' => PluginOfferedReleaseNotesStyle('fpp-tests-script', $script),
  'gitNoRepo' => PluginOfferedReleaseNotesStyle('fpp-tests-script', array('releaseNotesStyle' => 'gitRelease')),
  'unknownStyle' => PluginOfferedReleaseNotesStyle('fpp-tests-script', array('releaseNotesStyle' => 'weird')),
));
`);
  expect(out).toEqual({ scriptMissing: 'none', gitNoRepo: 'none', unknownStyle: 'none' });

  inPlayer('touch', `${PLUGINS}/fpp-tests-script/scripts/fpp_releasenotes.sh`);
  const offered = pluginPhp(`
$settings['pluginDirectory'] = '${PLUGINS}';
echo json_encode(array(
  'scriptPresent' => PluginOfferedReleaseNotesStyle('fpp-tests-script', array('releaseNotesStyle' => 'script')),
  'gitRepo' => PluginOfferedReleaseNotesStyle('fpp-tests-script', array('releaseNotesStyle' => 'gitRelease', 'srcURL' => 'https://github.com/Owner/Repo.git')),
));
`);
  expect(offered).toEqual({ scriptPresent: 'script', gitRepo: 'gitRelease' });
});
