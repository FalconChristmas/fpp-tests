import { execFileSync } from 'child_process';
import { container, docker, inPlayer } from './container';

// A spy on fppd's local command socket (/run/fppd/FPPD), which the PHP's
// SendCommand() writes to: fppd's bound socket is moved aside and a relay
// takes its name, passing each datagram on to fppd and fppd's reply back to
// the sender, and logging both.  stop() puts fppd's socket back.

const SOCK = '/run/fppd/FPPD';
const REAL = '/run/fppd/FPPD.fpp-tests-real';
const DIR = '/tmp/fpp-tests-socket-spy';

const RELAY = `
import json, os, socket, sys
sock, real, log = sys.argv[1], sys.argv[2], sys.argv[3]
srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
srv.bind(sock)
os.chmod(sock, 0o777)
up = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
up.bind(sock + '.fpp-tests-relay')
up.settimeout(5)
while True:
    data, sender = srv.recvfrom(65536)
    up.sendto(data, real)
    try:
        reply = up.recv(65536)
    except socket.timeout:
        reply = None
    with open(log, 'a') as f:
        f.write(json.dumps({'command': data.decode('utf-8', 'replace'),
                            'reply': None if reply is None else reply.decode('utf-8', 'replace')}) + '\\n')
    if reply is not None and sender:
        try:
            srv.sendto(reply, sender)
        except OSError:
            pass
`;

export type Exchange = { command: string; reply: string | null };

export class CommandSocketSpy {
  start() {
    execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `rm -rf ${DIR} && mkdir -p ${DIR} && cat > ${DIR}/relay.py`], { input: RELAY });
    inPlayer('sh', '-c', `set -e; [ -S ${SOCK} ]; rm -f ${REAL} ${SOCK}.fpp-tests-relay; mv ${SOCK} ${REAL}; : > ${DIR}/log`);
    docker('exec', '-d', container, 'python3', `${DIR}/relay.py`, SOCK, REAL, `${DIR}/log`);
    for (let i = 0; i < 50; i++) {
      if (inPlayer('sh', '-c', `[ -S ${SOCK} ] && echo up || true`).trim() === 'up') return;
      execFileSync('sleep', ['0.1']);
    }
    this.stop();
    throw new Error('the command socket relay did not come up');
  }

  exchanges(): Exchange[] {
    return inPlayer('sh', '-c', `cat ${DIR}/log 2>/dev/null || true`).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  stop() {
    // The bracket keeps pkill's pattern from matching this very shell.
    inPlayer('sh', '-c', `pkill -f '${DIR}/relay[.]py'; sleep 0.2
      if [ -S ${REAL} ]; then rm -f ${SOCK} ${SOCK}.fpp-tests-relay; mv ${REAL} ${SOCK}; fi
      rm -rf ${DIR}`);
  }
}
