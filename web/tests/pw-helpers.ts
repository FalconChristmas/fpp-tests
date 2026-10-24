import { inPlayer } from './container';

// Helpers for the pw-*.spec.ts PipeWire API specs: config files written as
// saved config, a stand-in pw-dump, and cleanup.  The web container runs no
// PipeWire daemon, so everything here checks what the PHP side generates and
// stores, not what PipeWire does with it.

export const CONFIG = '/home/fpp/media/config';
const PW_DUMP = '/usr/local/bin/pw-dump';

// A file in the player, written from a string or JSON-able value.
export function writeFile(path: string, content: unknown) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const b64 = Buffer.from(text).toString('base64');
  inPlayer('sh', '-c', `mkdir -p "$(dirname '${path}')" && echo ${b64} | base64 -d > '${path}'`);
}

export function readFile(path: string): string {
  return inPlayer('sh', '-c', `cat '${path}' 2>/dev/null || true`);
}

export function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo y || echo n`).trim() === 'y';
}

// A sink node as pw-dump lists it.
export function sinkNode(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, type: 'PipeWire:Interface:Node',
    info: { state: 'idle', props: { 'node.name': name, 'media.class': 'Audio/Sink', 'audio.channels': 2, ...extra } },
  };
}

// Make the pw-dump the PHP runs (through sudo, whose secure_path puts
// /usr/local/bin first) print `objects`.  Returns what that sudo pw-dump
// printed, so a test can check the stand-in really is the one found.
export function standInPwDump(objects: unknown[]): string {
  writeFile('/tmp/fpp-tests-pw-dump.json', objects);
  writeFile(PW_DUMP, '#!/bin/sh\ncat /tmp/fpp-tests-pw-dump.json\n');
  inPlayer('chmod', '755', PW_DUMP);
  return inPlayer('sh', '-c', 'sudo PIPEWIRE_RUNTIME_DIR=/run/pipewire-fpp pw-dump 2>/dev/null || true');
}

export function cleanupPipeWire() {
  undoStandIns();
  inPlayer('sh', '-c', `cd ${CONFIG} && rm -f pipewire-audio-groups.json pipewire-audio-groups.conf ` +
    `pipewire-input-groups.json pipewire-input-groups.conf pipewire-vban-instances.json pipewire-vban.conf ` +
    `pipewire-stream-slots.json pipewire-video-input-sources.json; ` +
    `rm -f /etc/pipewire/pipewire.conf.d/9*-fpp-*.conf ${PW_DUMP} /tmp/fpp-tests-pw-dump.json`);
}

// Stand-ins for the sound hardware the container does not have: a stub
// command in /usr/local/bin (found first on PATH and by sudo's secure_path)
// that logs how it was called to /tmp/fpp-tests-<name>.log.
export function standInCommand(name: string, script: string) {
  const path = `/usr/local/bin/${name}`;
  writeFile(path, `#!/bin/sh\necho "$*" >> /tmp/fpp-tests-${name}.log\n${script}`);
  inPlayer('chmod', '755', path);
}

export function commandLog(name: string): string[] {
  return readFile(`/tmp/fpp-tests-${name}.log`).split('\n').filter((l) => l);
}

// An aplay whose `-D <device> --dump-hw-params` prints the HW params given
// for that device (and exits 1, as aplay does on /dev/zero); a device not
// given cannot be opened.  A playback probe of a given device succeeds.
export function standInAplay(devices: Record<string, string>) {
  for (const [dev, params] of Object.entries(devices)) {
    writeFile(`/tmp/fpp-tests-aplay/${dev.replace(/:/g, '_')}`, `HW Params of device "${dev}":\n` +
      `--------------------\n${params}\n--------------------\n`);
  }
  standInCommand('aplay', [
    'dev=; dump=',
    'while [ $# -gt 0 ]; do case "$1" in -D) dev="$2"; shift ;; --dump-hw-params) dump=1 ;; esac; shift; done',
    'f=/tmp/fpp-tests-aplay/$(echo "$dev" | tr : _)',
    'if [ ! -f "$f" ]; then echo "aplay: main:831: audio open error: No such file or directory"; exit 1; fi',
    'if [ -n "$dump" ]; then cat "$f"; exit 1; fi',
    'cat > /dev/null; exit 0',
  ].join('\n') + '\n');
}

// HW params as aplay --dump-hw-params prints them.
export function hwParams(p: { format?: string; channels?: string; rate?: string } = {}) {
  return `ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED\nFORMAT:  ${p.format ?? 'S16_LE'}\n` +
    `SUBFORMAT:  STD\nSAMPLE_BITS: 16\nFRAME_BITS: 32\nCHANNELS: ${p.channels ?? '2'}\n` +
    `RATE: ${p.rate ?? '48000'}\nPERIOD_TIME: [1000 1000000]\n`;
}

// Sound cards for the PHP to find under /proc/asound.  Docker's kernel has
// no ALSA, and procfs takes no new directories, so php-fpm is restarted with
// fakeasound.so preloaded, which sends /proc/asound to a directory written
// here: the cards list, cardN/id, and the <id> -> cardN links.  Undone by
// cleanupPipeWire().
const ASOUND = '/tmp/fpp-tests-fakeasound';
const FAKE_ASOUND_SO = '/tmp/fpp-tests-fakeasound.so';

function restartPhpFpm(preload: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${preload ? `LD_PRELOAD=${preload} ` : ''}php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

export function fakeSoundCards(cards: { id: string; name?: string }[]) {
  const list = cards.map((c, i) =>
    `${String(i).padStart(2)} [${c.id.padEnd(15)}]: ${c.name ?? 'fpp-tests'} - ${c.name ?? 'fpp-tests'}\n` +
    `                      ${c.name ?? 'fpp-tests'} card ${i}\n`).join('');
  writeFile(`${ASOUND}/cards`, list);
  cards.forEach((c, i) => {
    writeFile(`${ASOUND}/card${i}/id`, `${c.id}\n`);
    inPlayer('ln', '-sfn', `card${i}`, `${ASOUND}/${c.id}`);
  });
  if (!exists(FAKE_ASOUND_SO)) {
    inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', FAKE_ASOUND_SO, '/tests/web/tests/fakeasound.c', '-ldl');
  }
  restartPhpFpm(FAKE_ASOUND_SO);
}

// A stand-in for a program the PHP runs by its full path (sudo
// /usr/bin/systemctl, $fppDir/src/fppinit), which no PATH order reaches: the
// real one is moved aside and put back by cleanupPipeWire().  Logs like
// standInCommand(), to /tmp/fpp-tests-<basename>.log.
const REPLACEABLE = ['/usr/bin/systemctl', '/opt/fpp/src/fppinit'];

export function standInAt(path: string, script: string) {
  if (!REPLACEABLE.includes(path)) throw new Error(`${path} is not one cleanupPipeWire() puts back`);
  const name = path.split('/').pop();
  inPlayer('sh', '-c', `[ -e '${path}.fpp-tests-real' ] || mv '${path}' '${path}.fpp-tests-real'`);
  writeFile(path, `#!/bin/sh\necho "$*" >> /tmp/fpp-tests-${name}.log\n${script}`);
  inPlayer('chmod', '755', path);
}

function undoStandIns() {
  for (const path of REPLACEABLE) {
    inPlayer('sh', '-c', `[ -e '${path}.fpp-tests-real' ] && mv -f '${path}.fpp-tests-real' '${path}' || true`);
  }
  inPlayer('sh', '-c', `rm -rf ${ASOUND} /tmp/fpp-tests-aplay /tmp/fpp-tests-*.log ` +
    '/usr/local/bin/aplay /usr/local/bin/amixer /usr/local/bin/pactl /usr/local/bin/pw-cli /tmp/fpp-tests-pw-cli.txt');
  // Only a php-fpm that was started with the shim is restarted again.
  const preloaded = inPlayer('sh', '-c',
    `grep -l fakeasound /proc/$(cat /run/php/php8.4-fpm.pid 2>/dev/null)/maps 2>/dev/null || true`).trim();
  if (preloaded) restartPhpFpm('');
}
