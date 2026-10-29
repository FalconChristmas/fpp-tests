import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { container, inPlayer } from './container';
import { writeFile } from './pw-helpers';

// /git/ serves the player's own fpp checkout (/opt/fpp/.git) over git's smart
// HTTP, through scripts/git-http-backend-wrapper.  The receiving end is a real
// git client here cloning from the player's Apache.
//
// The tree under test is an export with no .git, so the test makes one,
// root-owned as on a player.  On a player Apache runs as fpp, which may sudo
// anything; here it runs as www-data, so www-data is given the same for the
// test (the wrapper's "sudo -E" needs it).

test.skip(!container, 'makes a repository inside the run-web.sh container');

const SUDOERS = '/etc/sudoers.d/fpp-tests-git';

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -rf /opt/fpp/.git ${SUDOERS}`);
});

test('the player\'s fpp checkout can be cloned from /git/', async () => {
  // Regression: b9abdc255 ("Get the /git URL working").  /git/ ran
  // git-http-backend as the web server's user, and git refuses a repository
  // owned by someone else ("dubious ownership"), so nothing could be fetched.
  inPlayer('sh', '-c', 'set -e; git init -q /opt/fpp; cd /opt/fpp; ' +
    'git -c user.name=fpp-tests -c user.email=fpp-tests@example.invalid commit -q --allow-empty -m fpp-tests-commit; ' +
    'git -C /opt/fpp rev-parse HEAD');
  writeFile(SUDOERS, 'www-data ALL=(ALL) NOPASSWD:SETENV: ALL\n');
  inPlayer('chmod', '440', SUDOERS);
  const head = inPlayer('git', '-C', '/opt/fpp', 'rev-parse', 'HEAD').trim();
  const url = new URL('/git/', test.info().project.use.baseURL!).toString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpp-tests-git-'));
  try {
    let out = '';
    try {
      out = execFileSync('git', ['clone', '-q', url, path.join(dir, 'clone')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e: any) {
      out = String(e.stderr || e.message);
    }
    const cloned = fs.existsSync(path.join(dir, 'clone', '.git'))
      ? execFileSync('git', ['-C', path.join(dir, 'clone'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : `clone failed: ${out}`;
    expect(cloned).toBe(head);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
