import { execFileSync } from 'child_process';
import { container, docker, inPlayer } from './container';

// Helpers for the privacy specs: they change the player's own files (the
// settings file, www/ data files, /tmp caches) from inside it, and put every
// one back afterwards, since every later test shares the player.

export const MEDIA = '/home/fpp/media';
export const SETTINGS = `${MEDIA}/settings`;

// Run fn with the settings file saved first and put back after, whatever fn
// does to it.  cp onto the file keeps its inode and owner.
export async function keepingSettings<T>(fn: () => Promise<T>): Promise<T> {
  const saved = `/tmp/fpp-tests-settings-${process.pid}.bak`;
  inPlayer('cp', SETTINGS, saved);
  try {
    return await fn();
  } finally {
    inPlayer('sh', '-c', `cp ${saved} ${SETTINGS} && rm -f ${saved}`);
  }
}

// The same for any file in the player; one that did not exist is removed again.
export async function keepingFile<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const saved = `/tmp/fpp-tests-keep-${process.pid}-${path.replace(/[^A-Za-z0-9]/g, '_')}`;
  inPlayer('sh', '-c', `if [ -e '${path}' ]; then cp -a '${path}' '${saved}'; else rm -f '${saved}'; fi`);
  try {
    return await fn();
  } finally {
    inPlayer('sh', '-c', `if [ -e '${saved}' ]; then cp -a '${saved}' '${path}' && rm -f '${saved}'; else rm -f '${path}'; fi`);
  }
}

// Drop every line for these keys from the settings file.
export function dropSettings(...keys: string[]) {
  const expr = keys.map((k) => `-e '/^${k} *=/d'`).join(' ');
  inPlayer('sh', '-c', `sed -i ${expr} ${SETTINGS}`);
}

// Set key = "value" in the settings file, replacing any line for it.
export function setSettingInFile(key: string, value: string) {
  dropSettings(key);
  inPlayer('sh', '-c', `printf '%s = "%s"\\n' '${key}' '${value}' >> ${SETTINGS}`);
}

export function readSettingsFile(): string {
  return inPlayer('cat', SETTINGS);
}

export function writeFile(path: string, content: string | Buffer) {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}'`], { input: content });
}

// Run a PHP snippet in the player with FPP's config and common code loaded,
// as the API sees them; its stdout.  `stdin` is passed to the script.
export function php(code: string, stdin = ''): string {
  const script = `<?php
$skipJSsettings = 1;
chdir('/opt/fpp/www');
require_once '/opt/fpp/www/config.php';
require_once '/opt/fpp/www/common.php';
${code}
`;
  const path = `/tmp/fpp-tests-${process.pid}.php`;
  writeFile(path, script);
  try {
    return execFileSync('docker', ['exec', '-i', container, 'php', path], { input: stdin, encoding: 'utf8' });
  } finally {
    inPlayer('rm', '-f', path);
  }
}

// A stand-in HTTP endpoint in the player that answers every request 200 with
// {"status":"OK"} and records each one (method, path, body length) to a file.
export class Sink {
  readonly url: string;
  private log: string;
  private constructor(readonly port: number) {
    this.url = `http://127.0.0.1:${port}/upload`;
    this.log = `/tmp/fpp-tests-sink-${port}.log`;
  }

  static start(port: number): Sink {
    const s = new Sink(port);
    const server = `
import http.server, sys
log = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_any(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b''
        with open(log, 'ab') as f:
            f.write(('%s %s %d\\n' % (self.command, self.path, len(body))).encode())
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"OK"}')
    do_POST = do_any
    do_GET = do_any
    def log_message(self, *a):
        pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
`;
      writeFile('/tmp/fpp-tests-sink.py', server);
    inPlayer('sh', '-c', `rm -f ${s.log}; touch ${s.log}`);
    docker('exec', '-d', container, 'python3', '/tmp/fpp-tests-sink.py', String(port), s.log);
    // Up when it answers
    for (let i = 0; i < 50; i++) {
      try {
        inPlayer('curl', '-sf', '-o', '/dev/null', `http://127.0.0.1:${port}/ready`);
        inPlayer('sh', '-c', `: > ${s.log}`);
        return s;
      } catch {
        execFileSync('sleep', ['0.1']);
      }
    }
    throw new Error('the stand-in endpoint did not start');
  }

  requests(): string[] {
    return inPlayer('cat', this.log).split('\n').filter((l) => l !== '');
  }

  stop() {
    inPlayer('sh', '-c', `pkill -f "[f]pp-tests-sink.py ${this.port}" || true; rm -f ${this.log}`);
  }
}
