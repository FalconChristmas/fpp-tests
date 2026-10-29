import { container, docker, inPlayer, playerAddress } from './container';
import { writeFile } from './pw-helpers';

// What the proxy specs put around the player: a controller, a host of its own
// on the player's Docker network (a private 172.16/12 address, as a
// controller on a show network has); DHCP leases the player "offered" it; and
// the systemd calls the proxies API makes to reload Apache.

// The controller answers HTTP on port 80 and on 8080 (another service on the
// same device, as shellinabox's 4200 is), each answer naming the port and
// path it got and carrying an X-Powered-By, as a controller's web server
// sends; /api/system/info answers as an FPP does; a WebSocket upgrade on
// either port is accepted and sends one message naming the port and path.
const SERVER = `
import base64, hashlib, http.server, json, threading
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
def handler(port):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def do_GET(self):
            if self.headers.get('Upgrade', '').lower() == 'websocket':
                key = self.headers['Sec-WebSocket-Key']
                accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
                self.send_response(101)
                self.send_header('Upgrade', 'websocket')
                self.send_header('Connection', 'Upgrade')
                self.send_header('Sec-WebSocket-Accept', accept)
                self.end_headers()
                msg = f'controller:{port}:{self.path}'.encode()
                self.wfile.write(bytes([0x81, len(msg)]) + msg)
                self.wfile.flush()
                try:
                    self.rfile.read(2)
                except Exception:
                    pass
                self.close_connection = True
                return
            if self.path == '/api/system/info':
                body, ctype = json.dumps({'HostName': 'fpp-tests-dhcp-host'}).encode(), 'application/json'
            else:
                body, ctype = f'controller:{port}:{self.path}'.encode(), 'text/plain'
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Powered-By', 'fpp-tests-controller')
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *a):
            pass
    return H
for port in (80, 8080):
    s = http.server.ThreadingHTTPServer(('0.0.0.0', port), handler(port))
    threading.Thread(target=s.serve_forever, daemon=True).start()
threading.Event().wait()
`;

let name = '';

// Starts the controller; its address.
export function startController(): string {
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  name = `fpp-tests-proxy-controller-${process.pid}`;
  try {
    docker('rm', '-f', name);
  } catch {
    // none left over
  }
  docker('run', '-d', '--rm', '--network', playerAddress().network, '--name', name, image, 'python3', '-c', SERVER);
  return docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
}

export function stopController() {
  if (name) docker('rm', '-f', name);
}

export const MEDIA = '/home/fpp/media';
export const PROXY_CONF = `${MEDIA}/config/proxy-config.conf`;

// DHCP leases this player offered, as networkctl lists them for the
// player's eth0 (getDHCPLeases() in www/api/controllers/proxies.php reads
// "Offered DHCP leases:" from `networkctl status <iface>`).  The real
// networkctl is moved aside; any other call goes to it.
const NETWORKCTL = '/usr/bin/networkctl';
export function offerLeases(ips: string[]) {
  const lines = ips.map((ip, i) => `${i ? '                       ' : '    Offered DHCP leases: '}${ip} (to 02:42:ac:00:00:0${i + 1})`);
  inPlayer('sh', '-c', `[ -e ${NETWORKCTL}.fpp-tests-real ] || mv ${NETWORKCTL} ${NETWORKCTL}.fpp-tests-real`);
  writeFile(NETWORKCTL, `#!/bin/sh
# fpp-tests stand-in: leases offered on eth0
case "$*" in
  *status\\ eth0)
    echo "* 2: eth0"
    echo "             Link File: n/a"
    echo "          Network File: /etc/systemd/network/10-eth0.network"
${lines.map((l) => `    echo '${l}'`).join('\n')}
    echo "              Activation Policy: up"
    ;;
  *) exec ${NETWORKCTL}.fpp-tests-real "$@" ;;
esac
`);
  inPlayer('chmod', '755', NETWORKCTL);
}

export function noLeases() {
  inPlayer('sh', '-c', `[ -e ${NETWORKCTL}.fpp-tests-real ] && mv -f ${NETWORKCTL}.fpp-tests-real ${NETWORKCTL} || true`);
}

// The player has no systemd: gracefullyReloadApacheConf (scripts/common)
// asks `systemctl is-active apache2` and then `systemctl reload apache2`
// (fppinit's setupNetwork: reload-or-restart).
// This stand-in answers those two the way systemd would with Apache running,
// doing the reload with apache2ctl graceful, and hands every other call to
// the real systemctl.
const SYSTEMCTL = '/usr/bin/systemctl';
export function apacheSystemctl() {
  inPlayer('sh', '-c', `[ -e ${SYSTEMCTL}.fpp-tests-real ] || cp -a ${SYSTEMCTL} ${SYSTEMCTL}.fpp-tests-real`);
  writeFile(SYSTEMCTL, `#!/bin/sh
# fpp-tests stand-in: Apache is running and reloads
case "$*" in
  "is-active --quiet apache2") exit 0 ;;
  "is-active apache2") echo active ;;
  "reload apache2"|"reload-or-restart apache2") exec apache2ctl graceful ;;
  *) exec ${SYSTEMCTL}.fpp-tests-real "$@" ;;
esac
`);
  inPlayer('chmod', '755', SYSTEMCTL);
}

export function realSystemctl() {
  inPlayer('sh', '-c', `[ -e ${SYSTEMCTL}.fpp-tests-real ] && mv -f ${SYSTEMCTL}.fpp-tests-real ${SYSTEMCTL} || true`);
}

// No proxies configured, and Apache running without them.
export function clearProxies() {
  inPlayer('sh', '-c', `rm -f ${PROXY_CONF} ${MEDIA}/config/proxies ${MEDIA}/config/proxies-safetodelete && apache2ctl graceful`);
}
