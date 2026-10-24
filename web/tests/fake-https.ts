import { execFileSync } from 'child_process';
import { container, docker, inPlayer } from './container';

// An HTTPS stand-in inside the player for the hosts the plugin manager's PHP
// (and the git it runs) talks to -- github.com, api.github.com,
// raw.githubusercontent.com, or any made-up host.  The names are put on
// 127.0.0.1 in /etc/hosts and a throwaway CA goes into the system trust
// store, so curl, PHP and git all reach this server for them and trust its
// certificate; stop() puts both files back.  With the server down the names
// still point at loopback, so nothing can reach the real hosts.
//
// Each request is answered from a routes file the test can rewrite, looked up
// by "host path?query", "path?query", "host path" and then "path".  A route
// may answer differently with and without an Authorization header ("auth" /
// "noAuth"), as GitHub does for a private repository.  A "git <host>" entry,
// {root, user}, serves the bare repositories under root to git over smart
// HTTP, behind Basic auth as user ("name:password") when given.  Every request is
// logged, Authorization header included, so a test can see exactly what was
// sent where.

const SERVER = `
import http.server, json, ssl, sys
port, routes, log, cert = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def answer(self):
        n = int(self.headers.get('Content-Length') or 0)
        self.raw_body = self.rfile.read(n) if n else b''
        body = self.raw_body.decode('utf-8', 'replace')
        host = (self.headers.get('Host') or '').split(':')[0]
        auth = self.headers.get('Authorization') or ''
        with open(log, 'a') as f:
            f.write(json.dumps({'method': self.command, 'host': host, 'path': self.path,
                                'authorization': auth, 'body': body}) + '\\n')
        try:
            with open(routes) as f:
                table = json.load(f)
        except Exception:
            table = {}
        bare = self.path.split('?')[0]
        git = table.get('git ' + host)
        if git and '.git/' in bare:
            return self.git(git, auth, bare, body)
        r = None
        for key in (host + ' ' + self.path, self.path, host + ' ' + bare, bare):
            if key in table:
                r = table[key]
                break
        if r is None:
            r = {'status': 404, 'json': {'message': 'Not Found'}}
        if 'auth' in r or 'noAuth' in r:
            r = r.get('auth' if auth else 'noAuth') or {'status': 404, 'json': {'message': 'Not Found'}}
        if 'json' in r:
            data, ctype = json.dumps(r['json']).encode(), 'application/json'
        elif 'b64' in r:
            import base64
            data, ctype = base64.b64decode(r['b64']), r.get('contentType', 'application/octet-stream')
        else:
            data, ctype = r.get('body', '').encode(), r.get('contentType', 'text/plain')
        self.send_response(r.get('status', 200))
        self.send_header('Content-Type', ctype)
        for k, v in (r.get('headers') or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def git(self, cfg, auth, path, body):
        # Smart HTTP through git http-backend, for repositories under
        # cfg['root'], behind Basic auth when cfg['user'] is set.
        import base64, subprocess
        want = cfg.get('user')
        given = base64.b64decode(auth[6:]).decode() if auth.startswith('Basic ') else ''
        if want and given != want:
            self.send_response(401)
            self.send_header('WWW-Authenticate', 'Basic realm="fpp-tests"')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        env = {'GIT_PROJECT_ROOT': cfg['root'], 'GIT_HTTP_EXPORT_ALL': '1', 'PATH_INFO': path,
               'QUERY_STRING': self.path.partition('?')[2], 'REQUEST_METHOD': self.command,
               'CONTENT_TYPE': self.headers.get('Content-Type') or '', 'REMOTE_USER': given.split(':')[0],
               'REMOTE_ADDR': '127.0.0.1', 'PATH': '/usr/bin:/bin',
               'HTTP_CONTENT_ENCODING': self.headers.get('Content-Encoding') or '',
               'HTTP_GIT_PROTOCOL': self.headers.get('Git-Protocol') or ''}
        out = subprocess.run(['/usr/lib/git-core/git-http-backend'], input=self.raw_body, env=env,
                             capture_output=True).stdout
        head, _, data = out.partition(b'\\r\\n\\r\\n')
        status, headers = 200, []
        for line in head.decode().split('\\r\\n'):
            k, _, v = line.partition(':')
            if k.lower() == 'status':
                status = int(v.split()[0])
            elif k:
                headers.append((k, v.strip()))
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    do_GET = do_POST = do_PUT = do_DELETE = answer
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert + '.crt', cert + '.key')
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
`;

export type Answer = {
  status?: number; json?: unknown; body?: string; b64?: string; contentType?: string;
  headers?: Record<string, string>;
};
export type Route = Answer | { auth?: Answer; noAuth?: Answer } | { root: string; user?: string };
export type Logged = { method: string; host: string; path: string; authorization: string; body: string };

const DIR = '/tmp/fpp-tests-fake-https';
const MARK = 'fpp-tests-fake-https';
const CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const CA_PRISTINE = '/tmp/fpp-tests-fake-https-ca.pristine';

function writeIn(path: string, content: string) {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}'`], { input: content });
}

export class FakeHttps {
  constructor(readonly hosts: string[], routes: Record<string, Route> = {}) {
    inPlayer('sh', '-c', `rm -rf ${DIR} && mkdir -p ${DIR} && : > ${DIR}/requests.log`);
    writeIn(`${DIR}/server.py`, SERVER);
    this.routes(routes);
  }

  routes(routes: Record<string, Route>) {
    writeIn(`${DIR}/routes.json`, JSON.stringify(routes));
  }

  start() {
    const san = this.hosts.map((h) => `DNS:${h}`).join(',');
    inPlayer('sh', '-c', `set -e; cd ${DIR}
      openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=fpp-tests fake CA' -keyout ca.key -out ca.crt 2>/dev/null
      openssl req -newkey rsa:2048 -nodes -subj '/CN=${this.hosts[0]}' -keyout cert.key -out cert.csr 2>/dev/null
      printf 'subjectAltName=${san}\\n' > ext.cnf
      openssl x509 -req -in cert.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile ext.cnf -out cert.crt 2>/dev/null
      [ -f ${CA_PRISTINE} ] || cp ${CA_BUNDLE} ${CA_PRISTINE}
      cat ${CA_PRISTINE} ca.crt > ${CA_BUNDLE}
      grep -v '${MARK}' /etc/hosts > ${DIR}/hosts
      echo '127.0.0.1 ${this.hosts.join(' ')} # ${MARK}' >> ${DIR}/hosts
      cat ${DIR}/hosts > /etc/hosts`);
    docker('exec', '-d', container, 'python3', `${DIR}/server.py`, '443', `${DIR}/routes.json`, `${DIR}/requests.log`, `${DIR}/cert`);
    for (let i = 0; i < 50; i++) {
      const rc = inPlayer('sh', '-c', `curl -s -o /dev/null --max-time 1 https://${this.hosts[0]}/fpp-tests-ping; echo $?`).trim();
      if (rc === '0') {
        this.clearLog();
        return;
      }
      execFileSync('sleep', ['0.1']);
    }
    throw new Error(`the fake HTTPS server for ${this.hosts.join(', ')} did not come up`);
  }

  requests(): Logged[] {
    return inPlayer('cat', `${DIR}/requests.log`).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  clearLog() {
    inPlayer('sh', '-c', `: > ${DIR}/requests.log`);
  }

  // The server goes away, the names stay on loopback: the hosts can't be
  // reached at all.
  down() {
    inPlayer('sh', '-c', `pkill -f '${DIR}/server[.]py' || true`);
  }

  stop() {
    // /etc/hosts is a bind mount: written in place, never replaced.  The
    // bracket keeps pkill's pattern from matching this very shell.
    inPlayer('sh', '-c', `pkill -f '${DIR}/server[.]py'
      if [ -f ${CA_PRISTINE} ]; then cat ${CA_PRISTINE} > ${CA_BUNDLE} && rm -f ${CA_PRISTINE}; fi
      grep -v '${MARK}' /etc/hosts > /tmp/fpp-tests-fake-https-hosts; cat /tmp/fpp-tests-fake-https-hosts > /etc/hosts
      rm -rf /tmp/fpp-tests-fake-https-hosts ${DIR}`);
  }
}

// "user:password" out of a Basic Authorization header, or the token of a
// "token ..." one; '' for none.
export function credentials(authorization: string): string {
  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  if (basic) return Buffer.from(basic[1], 'base64').toString();
  const token = /^(?:token|Bearer)\s+(.+)$/i.exec(authorization);
  return token ? token[1] : '';
}
