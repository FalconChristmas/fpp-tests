import { execFileSync } from 'child_process';
import { container, docker, inPlayer, playerAddress } from './container';

// Stand-in web servers inside the player, for the API calls the PHP makes to
// other hosts: a MultiSync peer or an Upgrade Source mirror on an address the
// player can reach (::1 on port 80 is free: Apache listens on IPv4 only), and
// GitHub itself.  Each answers from a routes file the test can rewrite between
// requests, and logs every request it gets.
//
// FakeGitHub puts api.github.com and github.com on 127.0.0.1 in /etc/hosts and
// a test CA in the system trust store, and answers HTTPS there, so a test
// stubbing GitHub can never reach the real one: with the server down the
// names still point at loopback and the request just fails.  Both files are
// put back by stop().  It answers for fppstats.falconchristmas.com as well
// (which run-web.sh already points at 127.0.0.1), since the update check asks
// it which branches exist.

const SERVER = `
import http.server, json, socket, ssl, sys
bind, port, routes, log = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
cert = sys.argv[5] if len(sys.argv) > 5 else ''
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def answer(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode('utf-8', 'replace') if n else ''
        with open(log, 'a') as f:
            f.write(json.dumps({'method': self.command, 'host': self.headers.get('Host', ''), 'path': self.path, 'body': body}) + '\\n')
        try:
            with open(routes) as f:
                table = json.load(f)
        except Exception:
            table = {}
        r = table.get(self.path) or table.get(self.path.split('?')[0])
        if r is None:
            r = {'status': 404, 'json': {'message': 'Not Found'}}
        if 'json' in r:
            data, ctype = json.dumps(r['json']).encode(), 'application/json'
        else:
            data, ctype = r.get('body', '').encode(), r.get('contentType', 'text/plain')
        self.send_response(r.get('status', 200))
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    do_GET = do_POST = do_PUT = do_DELETE = answer
    def log_message(self, *a):
        pass
class S(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6 if ':' in bind else socket.AF_INET
srv = S((bind, port), H)
if cert:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert + '.crt', cert + '.key')
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
`;

export type Route = { status?: number; json?: unknown; body?: string; contentType?: string };
export type Logged = { method: string; host: string; path: string; body: string };

function writeIn(where: string, path: string, content: string) {
  execFileSync('docker', ['exec', '-i', where, 'sh', '-c', `cat > '${path}'`], { input: content });
}

export class StandIn {
  readonly dir: string;
  // The container the server runs in: the player, or a sibling of its own.
  private where = container;
  // A sibling() made for it alone, removed with it.
  private ownsHost = false;

  // bind is an address in the player ("::1", "127.0.0.1"); cert, a path
  // prefix of a .crt/.key pair to serve HTTPS with.  StandIn.sibling() makes
  // one on another host instead.
  constructor(readonly name: string, readonly bind: string, readonly port: number, routes: Record<string, Route> = {}, private cert = '', where = '') {
    if (where) this.where = where;
    this.dir = `/tmp/fpp-tests-standin-${name}`;
    this.sh(`rm -rf ${this.dir} && mkdir -p ${this.dir} && : > ${this.dir}/requests.log`);
    writeIn(this.where, `${this.dir}/server.py`, SERVER);
    this.routes(routes);
  }

  // A stand-in on a host of its own next to the player, on its Docker network
  // (a MultiSync peer at an IPv4 address the player reaches on port 80).  Its
  // address is .address.
  static sibling(name: string, routes: Record<string, Route> = {}): StandIn & { address: string } {
    const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
    const sib = `fpp-tests-standin-${name}-${process.pid}`;
    try {
      docker('rm', '-f', sib);
    } catch {
      // none left over
    }
    docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', sib, image, 'sleep', 'infinity');
    const s = new StandIn(name, '0.0.0.0', 80, routes, '', sib) as StandIn & { address: string };
    s.ownsHost = true;
    s.address = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', sib).trim();
    return s;
  }

  protected sh(script: string): string {
    return docker('exec', this.where, 'sh', '-c', script);
  }

  routes(routes: Record<string, Route>) {
    writeIn(this.where, `${this.dir}/routes.json`, JSON.stringify(routes));
  }

  start() {
    const args = ['python3', `${this.dir}/server.py`, this.bind, String(this.port), `${this.dir}/routes.json`, `${this.dir}/requests.log`];
    if (this.cert) args.push(this.cert);
    docker('exec', '-d', this.where, ...args);
    const bind = this.bind === '0.0.0.0' ? '127.0.0.1' : this.bind;
    const host = bind.includes(':') ? `[${bind}]` : bind;
    const scheme = this.cert ? 'https' : 'http';
    for (let i = 0; i < 50; i++) {
      const rc = this.sh(`python3 -c "import ssl,sys,urllib.request as u
try: u.urlopen('${scheme}://${host}:${this.port}/fpp-tests-ping', timeout=1, context=ssl._create_unverified_context())
except u.HTTPError: pass
except Exception: sys.exit(1)" && echo up || echo down`).trim();
      if (rc === 'up') {
        this.clearLog();
        return;
      }
      execFileSync('sleep', ['0.1']);
    }
    throw new Error(`stand-in ${this.name} did not come up on ${host}:${this.port}`);
  }

  requests(): Logged[] {
    return this.sh(`cat ${this.dir}/requests.log`).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  clearLog() {
    this.sh(`: > ${this.dir}/requests.log`);
  }

  stop() {
    if (this.ownsHost) {
      docker('rm', '-f', this.where);
      return;
    }
    // The bracket keeps the pattern from matching this very shell.
    this.sh(`pkill -f '${this.dir}/server[.]py'; rm -rf ${this.dir}`);
  }
}

const HOSTS_LINE = '127.0.0.1 api.github.com github.com # fpp-tests-fake-github';
const CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
// The bundle as it was before any fake CA went in, kept until it is put back.
const CA_PRISTINE = '/tmp/fpp-tests-ca-bundle.pristine';

// The release-check caches the PHP keeps in /tmp: every test starts and ends
// with none, so no answer leaks from one test (or from the real GitHub) into
// another.
export function clearReleaseCaches(where = container) {
  docker('exec', where, 'sh', '-c', 'rm -f /tmp/cache_github_* /tmp/cache_fppstats_* /tmp/cache_*release* /tmp/cache_git_remote_version*');
}

export class FakeGitHub extends StandIn {
  // where: the container whose GitHub it is (the player, or a SecondPlayer's
  // name).
  constructor(routes: Record<string, Route> = {}, private readonly host = container) {
    super('github', '127.0.0.1', 443, routes, '/tmp/fpp-tests-standin-github/cert', host);
  }

  start() {
    const d = this.dir;
    // A throwaway CA and a certificate for the GitHub names, signed by it.
    this.sh(`set -e; cd ${d}
      openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=fpp-tests CA' -keyout ca.key -out ca.crt 2>/dev/null
      openssl req -newkey rsa:2048 -nodes -subj '/CN=api.github.com' -keyout cert.key -out cert.csr 2>/dev/null
      printf 'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:fppstats.falconchristmas.com\\n' > ext.cnf
      openssl x509 -req -in cert.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile ext.cnf -out cert.crt 2>/dev/null
      [ -f ${CA_PRISTINE} ] || cp ${CA_BUNDLE} ${CA_PRISTINE}
      cat ${CA_PRISTINE} ca.crt > ${CA_BUNDLE}
      grep -q fpp-tests-fake-github /etc/hosts || echo '${HOSTS_LINE}' >> /etc/hosts`);
    clearReleaseCaches(this.host);
    super.start();
    // The control: the player itself now gets this server for GitHub.
    const got = this.sh('curl -s -o /dev/null -w "%{http_code} %{remote_ip}" --max-time 3 https://api.github.com/fpp-tests-ping || true').trim();
    if (got !== '404 127.0.0.1') throw new Error(`the player does not reach the fake GitHub: ${got}`);
    this.clearLog();
  }

  stop() {
    const d = this.dir;
    // /etc/hosts is a bind mount: written in place, never replaced.
    this.sh(`pkill -f '${d}/server[.]py'
      if [ -f ${CA_PRISTINE} ]; then cat ${CA_PRISTINE} > ${CA_BUNDLE} && rm -f ${CA_PRISTINE}; fi
      grep -v fpp-tests-fake-github /etc/hosts > /tmp/fpp-tests-hosts; cat /tmp/fpp-tests-hosts > /etc/hosts; rm -f /tmp/fpp-tests-hosts`);
    clearReleaseCaches(this.host);
    super.stop();
  }
}

// A GitHub release as api.github.com lists it, with .fppos (or any) assets.
// Ids as large as real ones: MultiSync's OS list drops anything below a
// cutoff as too old.
let assetId = 300000000;
export function release(tag: string, assets: string[], extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, name: tag, prerelease: false, draft: false, body: `Notes for ${tag}`,
    html_url: `https://github.com/FalconChristmas/fpp/releases/tag/${tag}`,
    assets: assets.map((name) => ({
      id: ++assetId, name, size: 123456,
      browser_download_url: `https://github.com/FalconChristmas/fpp/releases/download/${tag}/${name}`,
    })),
    ...extra,
  };
}

// Every page's header asks api/system/updateStatus shortly after it loads,
// and the player answers that from GitHub's releases/latest.  A page test
// that is not about the update check answers it itself, so the player does
// not go out to the real GitHub on its behalf.
export async function answerUpdateCheck(page: import('@playwright/test').Page) {
  await page.route('**/api/system/updateStatus*', (route) => route.fulfill({
    json: {
      status: 'OK', branchUpgradeAvailable: false, branchUpgradeTarget: '', branchUpgradeVersion: '',
      isMajorVersionUpgrade: false, commitUpdateAvailable: false, remoteCommit: '', currentBranch: '',
      localCommit: '', versionUnknown: false, isEndOfLife: false, latestMajorVersion: 10, checked: true,
    },
  }));
}
