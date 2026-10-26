import { inPlayer } from './container';
import { putFile } from './settings-file';

// Files the web user can't open, for the tests of what the PHP does then.  On
// a player PHP runs as fpp, and a file a stray root write left root's can't
// be written (or, at 0600, read) by it.  Here php-fpm runs as root, which no
// chmod stops, so it is restarted with fakedeny.so preloaded (see
// fakedeny.c), and deny() names the paths it refuses.  sudo drops the
// preload, so a command PHP runs through sudo opens them as root would.

const SO = '/tmp/fpp-tests-fakedeny.so';
const CONTROL = '/tmp/fpp-tests-deny';

function restartPhpFpm(preload: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${preload ? `LD_PRELOAD=${preload} ` : ''}php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

// For a beforeAll: php-fpm with the shim in, refusing nothing yet.
export function preloadDeny() {
  inPlayer('rm', '-f', CONTROL);
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/web/tests/fakedeny.c', '-ldl');
  restartPhpFpm(SO);
}

// For an afterAll: php-fpm as it was.
export function unpreloadDeny() {
  inPlayer('rm', '-f', CONTROL);
  restartPhpFpm('');
}

// Run fn with these paths refused: write opens of `write`, every open of `read`.
export async function denying<T>(paths: { write?: string[]; read?: string[] }, fn: () => Promise<T>): Promise<T> {
  const lines = [...(paths.write ?? []).map((p) => `write ${p}`), ...(paths.read ?? []).map((p) => `read ${p}`)];
  putFile(CONTROL, lines.join('\n') + '\n');
  try {
    return await fn();
  } finally {
    inPlayer('rm', '-f', CONTROL);
  }
}
