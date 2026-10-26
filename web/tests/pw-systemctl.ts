import { inPlayer } from './container';
import { writeFile } from './pw-helpers';

// A systemctl for the PipeWire specs: the player has no systemd, so this
// stand-in's three PipeWire units are the test's own PipeWire daemons
// (pw-live.ts) -- a restart really stops and starts that daemon, is-active
// says whether it runs -- and every other unit goes to the real systemctl.
// Each call is recorded, as `systemctl <verb> <unit>` takes it.  The same
// stand-in as pw-services-restart.spec.ts's.

const STATE = '/tmp/fpp-tests-systemctl';
const DAEMON = { 'fpp-pipewire.service': 'pipewire', 'fpp-wireplumber.service': 'wireplumber', 'fpp-pipewire-pulse.service': 'pipewire-pulse' };
const STUB = `#!/bin/sh
# fpp-tests stand-in: the PipeWire units are the test's own daemons.
echo "$*" >> ${STATE}/calls
case "$2" in
  ${Object.entries(DAEMON).map(([u, p]) => `${u}) p=${p} ;;`).join('\n  ')}
  *) exec ${STATE}/systemctl.real "$@" ;;
esac
export PIPEWIRE_RUNTIME_DIR=/run/pipewire-fpp XDG_RUNTIME_DIR=/run/pipewire-fpp XDG_CONFIG_HOME=/tmp/fpp-tests-pw XDG_STATE_HOME=/tmp/fpp-tests-pw/state
case "$1" in
  is-active) if pgrep -x "$p" > /dev/null; then echo active; else echo inactive; exit 3; fi ;;
  restart) pkill -x "$p"; while pgrep -x "$p" > /dev/null; do sleep 0.1; done
           setsid nohup "$p" >> /tmp/fpp-tests-pw/$p.log 2>&1 < /dev/null & ;;
  stop) pkill -x "$p" ;;
  *) exit 1 ;;
esac
`;

export function standInSystemctl() {
  inPlayer('sh', '-c', `rm -rf ${STATE} && mkdir -p ${STATE} && cp -a /usr/bin/systemctl ${STATE}/systemctl.real && : > ${STATE}/calls`);
  writeFile('/usr/bin/systemctl', STUB);
  inPlayer('chmod', '755', '/usr/bin/systemctl');
}

export function realSystemctl() {
  inPlayer('sh', '-c', `[ -e ${STATE}/systemctl.real ] && cp -a ${STATE}/systemctl.real /usr/bin/systemctl; rm -rf ${STATE}`);
}

// The calls since standInSystemctl() or the last clearSystemctlCalls().
export function systemctlCalls(): string[] {
  return inPlayer('sh', '-c', `cat ${STATE}/calls 2>/dev/null || true`).split('\n').filter((l) => l);
}

export function clearSystemctlCalls() {
  inPlayer('sh', '-c', `: > ${STATE}/calls`);
}
