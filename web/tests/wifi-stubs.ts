import { execFileSync } from 'child_process';
import { container, docker, inPlayer } from './container';

// A wireless adapter for the network API specs, which the player doesn't have.
// The interface is a dummy one named like a wireless adapter ("wl..."), added
// to the player's network namespace by a sibling container that has
// NET_ADMIN (the player itself does not); the wireless tools (iw, iwlist,
// iwconfig, ifconfig, wpa_cli) are stand-in scripts at the paths the PHP runs
// them from, which answer from canned output and log every call.  Only
// ifconfig is installed in the player; it is wrapped, not replaced.

export const WLAN = 'wlan9';
export const WLAN_ADDR = '10.254.0.5';
const DIR = '/tmp/fpp-tests-wifi';
const LOG = `${DIR}/calls.log`;
const MARK = 'fpp-tests-wifi-stub';

// Where each tool is looked for: /sbin is /usr/sbin in the player, and sudo's
// secure_path puts /usr/local/bin first for the ones run by bare name.
const PATHS: Record<string, string> = {
  iw: '/usr/sbin/iw',
  iwlist: '/usr/sbin/iwlist',
  iwconfig: '/usr/sbin/iwconfig',
  ifconfig: '/usr/sbin/ifconfig',
  wpa_cli: '/usr/local/bin/wpa_cli',
};

// [shell case pattern over the arguments, output] -- the first match answers.
export type Answers = Array<[string, string]>;

function writeIn(path: string, content: string, mode = '644') {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}' && chmod ${mode} '${path}'`], { input: content });
}

export function netAdmin(script: string) {
  const image = docker('inspect', '-f', '{{.Config.Image}}', container).trim();
  docker('run', '--rm', '--cap-add', 'NET_ADMIN', '--network', `container:${container}`, image, 'sh', '-c', script);
}

export const WLAN_ADDR6 = 'fd00:fee::5';

export function addWlan() {
  netAdmin(`ip link del ${WLAN} 2>/dev/null; ip link add ${WLAN} type dummy && ip addr add ${WLAN_ADDR}/24 dev ${WLAN} && ` +
    `ip -6 addr add ${WLAN_ADDR6}/64 dev ${WLAN} && ip link set ${WLAN} up`);
}

export function removeWlan() {
  netAdmin(`ip link del ${WLAN} 2>/dev/null || true`);
}

// Install (or replace) the stand-in for one tool.
export function stub(tool: keyof typeof PATHS | string, answers: Answers = []) {
  const path = PATHS[tool];
  const existing = inPlayer('sh', '-c', `test -e ${path} && ! grep -q ${MARK} ${path} && echo real || true`).trim();
  if (existing === 'real') throw new Error(`${path} is a real program in the player; not replacing it`);
  inPlayer('sh', '-c', `mkdir -p ${DIR} && touch ${LOG} && chmod 666 ${LOG}`);
  const cases = answers.map(([pattern, out], i) => {
    writeIn(`${DIR}/${tool}.${i}`, out);
    // Spaces escaped, so a pattern is one case word with its globs intact.
    return `  ${pattern.replace(/ /g, '\\ ')}) cat ${DIR}/${tool}.${i} ;;`;
  }).join('\n');
  writeIn(path, `#!/bin/sh\n# ${MARK}\necho "${tool} $*" >> ${LOG}\ncase "$*" in\n${cases}\n  *) ;;\nesac\nexit 0\n`, '755');
}

// A tool the player does have (ifconfig): the real one is moved aside and the
// stand-in logs each call and hands it on.  removeStubs() puts it back.
export function wrap(tool: keyof typeof PATHS | string) {
  const path = PATHS[tool];
  inPlayer('sh', '-c', `mkdir -p ${DIR} && touch ${LOG} && chmod 666 ${LOG}
    if ! grep -q ${MARK} ${path} 2>/dev/null; then mv ${path} ${path}.fpp-tests-real; fi`);
  writeIn(path, `#!/bin/sh\n# ${MARK}\necho "${tool} $*" >> ${LOG}\nexec ${path}.fpp-tests-real "$@"\n`, '755');
}

// What the real tools accept, for the stand-ins' recorded calls: a stand-in
// answers anything, so a call the real tool would refuse has to be caught
// here.  From the tools' own usage: iw 6.9's `iw help` ("dev <devname> scan
// [-u] [freq <freq>*] ... [lowpri,flush,ap-force,duration-mandatory] ...",
// "dev <devname> scan dump [-u]", "dev <devname> link", "dev <devname> info",
// "dev <devname> station dump [-v]"); wireless-tools 30's iwlist ("iwlist
// [interface] scanning [essid NNN] [last]", which takes "scan" for it, as a
// real iwlist run showed); wpa_cli 2.10's -i <ifname> with its status,
// scan and scan_results commands; ifconfig and iwconfig with an interface.
const IW_SCAN_FLAG = '(-u|lowpri|flush|ap-force|duration-mandatory|coloc|passive|randomi[sz]e\\S*)';
const REAL_SYNTAX = [
  new RegExp(`^iw dev \\S+ (info|link|station dump( -v)?|scan dump( -u)?|scan( ${IW_SCAN_FLAG})*)$`),
  /^iw dev$/,
  /^iwlist \S+ scan(ning)?( essid \S+)?( last)?$/,
  /^wpa_cli -i \S+ (status|scan|scan_results)$/,
  /^(ifconfig|iwconfig) \S+$/,
];

// Fails on any recorded call the real tool would refuse.
export function realSyntaxErrors(recorded = calls()): string[] {
  return recorded.filter((c) => !REAL_SYNTAX.some((re) => re.test(c)));
}

// Every stand-in call since the last clearCalls(), as "tool args".
export function calls(): string[] {
  return inPlayer('sh', '-c', `cat ${LOG} 2>/dev/null || true`).split('\n').filter((l) => l.trim());
}

export function clearCalls() {
  inPlayer('sh', '-c', `: > ${LOG} 2>/dev/null || true`);
}

export function removeStubs() {
  const paths = Object.values(PATHS).join(' ');
  inPlayer('sh', '-c', `for f in ${paths}; do grep -q ${MARK} $f 2>/dev/null && rm -f $f; ` +
    `if [ -e $f.fpp-tests-real ]; then mv $f.fpp-tests-real $f; fi; done; rm -rf ${DIR}; true`);
}

// `iw dev <if> link` for an associated station.
export function iwLink(ssid: string, signal = -52) {
  return `Connected to 02:11:22:33:44:55 (on ${WLAN})
\tSSID: ${ssid}
\tfreq: 2437
\tRX: 123456 bytes (789 packets)
\tTX: 23456 bytes (123 packets)
\tsignal: ${signal} dBm
\trx bitrate: 65.0 MBit/s MCS 7
\ttx bitrate: 72.2 MBit/s MCS 7 short GI
`;
}
