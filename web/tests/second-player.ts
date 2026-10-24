import { execFileSync } from 'child_process';
import { container, docker, playerAddress } from './container';

// A second real player next to the one run-web.sh serves: the same image and
// the same built tree, started the same way (scripts/web_serve.py: fppd, then
// Apache and php-fpm in front of it), on the player's Docker network.  For
// the tests whose other end is another FPP -- a MultiSync remote, an Upgrade
// Source, a backup host -- so what this player sends is checked against what
// a real one does with it, not against a stand-in that answers anything.
//
// Its GitHub names point at loopback, like the fppstats and crash-report names
// run-web.sh already points there, so nothing it does reaches GitHub.  Its
// fppd is held to web_serve.py's standard: stop() fails if it died, wedged or
// wrote a sanitizer report while the test drove it.

export class SecondPlayer {
  readonly name: string;
  address = '';

  constructor(tag: string) {
    this.name = `fpp-tests-peer-${tag}-${process.pid}`;
  }

  start(timeoutMs = 180_000) {
    const env = JSON.parse(docker('inspect', '-f', '{{json .Config.Env}}', container)) as string[];
    const tree = env.find((e) => e.startsWith('FPP_TREE='))!;
    const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', container)) as any[];
    // The suite checkout, as the Docker client names it.
    const tests = mounts.find((m) => m.Destination === '/tests').Source.replace(/^\/host_mnt/, '');
    const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
    try {
      docker('rm', '-f', this.name);
    } catch {
      // none left over
    }
    docker('run', '-d', '--init', '--name', this.name, '--network', playerAddress().network,
      '--ulimit', 'nofile=1048576:1048576', '-v', 'fpp-tests-work:/work', '-v', `${tests}:/tests:ro`,
      '-e', tree, '-e', 'FPP_TESTS_ARTIFACTS=/tmp/fpp-tests-peer-artifacts',
      '--add-host', 'fppstats.falconchristmas.com:127.0.0.1', '--add-host', 'crashes.falconplayer.com:127.0.0.1',
      '--add-host', 'api.github.com:127.0.0.1', '--add-host', 'github.com:127.0.0.1',
      '--cap-add', 'SYS_PTRACE', '--cap-add', 'SYS_NICE', '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
      image, 'python3', '/tests/scripts/web_serve.py');
    const until = Date.now() + timeoutMs;
    while (!docker('logs', this.name).includes('READY')) {
      if (docker('inspect', '-f', '{{.State.Running}}', this.name).trim() !== 'true') {
        throw new Error(`the second player exited before it was ready:\n${docker('logs', '--tail', '40', this.name)}`);
      }
      if (Date.now() > until) throw new Error('the second player was not ready in time');
      execFileSync('sleep', ['1']);
    }
    this.address = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', this.name).trim();
    return this;
  }

  // A command run inside it, as root; its stdout.
  sh(script: string): string {
    return docker('exec', this.name, 'sh', '-c', script);
  }

  // A GET of its own API from inside it, parsed.
  get(path: string): any {
    return JSON.parse(this.sh(`curl -s --max-time 20 'http://127.0.0.1${path}'`));
  }

  writeFile(path: string, content: string) {
    execFileSync('docker', ['exec', '-i', this.name, 'sh', '-c', `mkdir -p "$(dirname '${path}')" && cat > '${path}'`], { input: content });
  }

  // Stops it and returns web_serve.py's verdict on its fppd.
  stop(): { ok: boolean; detail: string } {
    let rc = '';
    let detail = '';
    try {
      docker('stop', '-t', '120', this.name);
      rc = docker('wait', this.name).trim();
      detail = docker('logs', '--tail', '60', this.name);
    } finally {
      try {
        docker('rm', '-f', this.name);
      } catch {
        // already gone
      }
    }
    return { ok: rc === '0', detail };
  }
}
