import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The logs zip (api/files/zip/Logs, the File Manager's Logs download and the
// support bundle) is a list of FPP's log files plus the state of FPP's own
// git checkout.  Read back with the zip tools inside the player.

test.skip(!container, 'writes logs and a git repository inside the run-web.sh container');

const LOGS = '/home/fpp/media/logs';
const STALE = ['git_branch.log', 'git_checkout_version.log', 'git_fetch.log'];
const KEEP = 'fpp-tests-keep.log';
const ZIP = '/tmp/fpp-tests-logs-contents.zip';

async function logsZip(request: any) {
  const response = await request.get('/api/files/zip/Logs', { timeout: 60_000 });
  expect(response.ok()).toBe(true);
  putFile(ZIP, await response.body());
}

function zipText(name: string): string {
  return inPlayer('python3', '-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', ZIP, name);
}

function zipNames(): string[] {
  return JSON.parse(inPlayer('python3', '-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', ZIP));
}

test.afterEach(() => {
  inPlayer('rm', '-rf', ZIP, '/opt/fpp/.git', ...STALE.map((f) => `${LOGS}/${f}`), `${LOGS}/${KEEP}`);
});

test('the logs zip leaves out the logs fppd.log replaced and keeps the others', async ({ request }) => {
  // Regression: 45e01fec8.  git_branch.log, git_checkout_version.log and
  // git_fetch.log (no longer generated, but left behind by older versions)
  // went into every logs zip.  The control: any other log still does.
  inPlayer('mkdir', '-p', LOGS);
  for (const f of [...STALE, KEEP]) putFile(`${LOGS}/${f}`, `fpp-tests ${f}\n`);
  await logsZip(request);
  const names = zipNames();
  expect(names).toContain(`logs/${KEEP}`);
  for (const f of STALE) expect(names, f).not.toContain(`logs/${f}`);
});

test('the logs zip carries the git status of the FPP tree, not of a folder under it', async ({ request }) => {
  // Regression: 66022a078.  The work tree handed to git for git_status.txt
  // and fpp_git.diff was worked out from files.php's own folder
  // (/opt/fpp/www/api) instead of FPP's root, so the status listed every
  // file outside that folder as deleted.
  inPlayer('sh', '-c', 'cd /opt/fpp && git init -q && git -c user.name=fpp-tests -c user.email=fpp-tests@invalid commit -q --allow-empty -m fpp-tests');
  await logsZip(request);
  const names = zipNames();
  expect(names).toContain('logs/git_status.txt');
  expect(names).toContain('logs/fpp_git.diff');
  const status = zipText('logs/git_status.txt');
  // The repository has no files, the tree has all of FPP's: all untracked.
  expect(status).toContain('Untracked files');
  expect(status).toMatch(/^\s+(\.\.\/)*LICENSE\.external$/m);
  expect(status).not.toContain('deleted:');
});
