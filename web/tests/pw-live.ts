import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { writeFile } from './pw-helpers';

// A real PipeWire of the test's own in the player, on the runtime directory
// FPP's PHP talks to (/run/pipewire-fpp): pipewire, wireplumber and
// pipewire-pulse, with null sinks standing in for sound cards, the way
// scenarios/audio.py runs one.  The PHP's own sudo pw-dump / pw-cli / pactl
// then reach it, so a test can check what PipeWire did with a call, not only
// what the PHP asked for.  /etc/pipewire/pipewire.conf.d is read as on a
// player, so a conf the PHP wrote there is loaded too.

const DIR = '/tmp/fpp-tests-pw';
const RUNTIME = '/run/pipewire-fpp';
export const PW_ENV = `PIPEWIRE_RUNTIME_DIR=${RUNTIME} XDG_RUNTIME_DIR=${RUNTIME} PULSE_RUNTIME_PATH=${RUNTIME}/pulse`;
const DAEMONS = ['pipewire', 'wireplumber', 'pipewire-pulse'];
const HELPERS = ['pw-record', 'pw-cat', 'gst-launch-1.0'];

type Value = string | number | boolean;

function spa(props: Record<string, Value>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join(' ');
}

// A null sink (a context.objects entry) named `name`, with any extra node
// properties: a description, an api.alsa.path, another media.class.
export function nullSink(name: string, props: Record<string, Value> = {}): string {
  return `{ factory = adapter args = { factory.name = support.null-audio-sink ${spa({
    'node.name': name, 'node.description': name, 'media.class': 'Audio/Sink',
    'monitor.channel-volumes': true, ...props })} audio.position = [ FL FR ] } }`;
}

// A loopback module (a context.modules entry): PipeWire names its two halves
// input.<name> and output.<name>; there is no node called <name> itself.
export function loopback(name: string, capture: Record<string, Value> = {}, playback: Record<string, Value> = {}): string {
  return `{ name = libpipewire-module-loopback args = { node.name = ${JSON.stringify(name)} ` +
    `audio.position = [ FL FR ] capture.props = { ${spa(capture)} } playback.props = { ${spa(playback)} } } }`;
}

// Run a command in the player against this PipeWire; its stdout.
export function pw(cmd: string): string {
  return inPlayer('sh', '-c', `export ${PW_ENV}; ${cmd}`);
}

export function stopPipeWire() {
  inPlayer('sh', '-c', `for p in ${[...HELPERS, ...DAEMONS].join(' ')}; do pkill -x "$p"; done; ` +
    `for i in $(seq 50); do pgrep -x pipewire >/dev/null || pgrep -x wireplumber >/dev/null || break; sleep 0.1; done; ` +
    `rm -rf ${DIR} ${RUNTIME}/pipewire-0* ${RUNTIME}/pulse/native ${RUNTIME}/pulse/pid; true`);
}

// Start the daemons with `objects` (nullSink()s) and `modules` (loopback()s,
// filter-chains) loaded, and wait until every node in `waitFor` is up --
// by default each null sink.
export function startPipeWire(o: { objects?: string[]; modules?: string[]; waitFor?: string[] } = {}) {
  stopPipeWire();
  const objects = o.objects ?? [];
  const modules = o.modules ?? [];
  writeFile(`${DIR}/pipewire/pipewire.conf.d/50-fpp-tests.conf`,
    `context.objects = [\n${objects.join('\n')}\n]\ncontext.modules = [\n${modules.join('\n')}\n]\n`);
  // WirePlumber restores a node's saved volume from XDG_STATE_HOME: a private
  // one, so no test starts at a level another left behind.
  const env = `${PW_ENV} XDG_CONFIG_HOME=${DIR} XDG_STATE_HOME=${DIR}/state`;
  inPlayer('sh', '-c', `mkdir -p ${DIR}/state ${RUNTIME}/pulse && for p in ${DAEMONS.join(' ')}; do ` +
    `${env} setsid nohup "$p" > ${DIR}/$p.log 2>&1 < /dev/null & sleep 0.5; done`);
  const want = o.waitFor ?? objects.map((s) => s.match(/node\.name = "([^"]+)"/)![1]);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const names = nodeNames();
    const pulse = inPlayer('sh', '-c', `test -S ${RUNTIME}/pulse/native && echo y || true`).trim() === 'y';
    if (pulse && want.every((n) => names.includes(n))) return;
    if (Date.now() > deadline) {
      throw new Error(`PipeWire never showed ${want.filter((n) => !names.includes(n)).join(', ') || 'its pulse socket'}; ` +
        `nodes: ${names.join(', ')}\n${inPlayer('sh', '-c', `tail -20 ${DIR}/pipewire.log ${DIR}/wireplumber.log 2>&1 || true`)}`);
    }
    inPlayer('sleep', '0.25');
  }
}

export function dump(): any[] {
  const out = pw('pw-dump 2>/dev/null || true');
  return out.trim() ? JSON.parse(out) : [];
}

export function nodes(): any[] {
  return dump().filter((o) => o.type === 'PipeWire:Interface:Node');
}

export function nodeNames(): string[] {
  return nodes().map((n) => n.info?.props?.['node.name']).filter(Boolean);
}

export function node(name: string): any {
  return nodes().find((n) => n.info?.props?.['node.name'] === name);
}

// The node's current Props (channelVolumes, mute, a filter's params), its
// Props entries merged.
export function nodeProps(name: string): any {
  const n = node(name);
  return Object.assign({}, ...(n?.info?.params?.Props ?? []));
}

// A filter-chain's control values, from its Props params list
// ([ "eq_l_0:Gain", 6.0, ... ]), as { "eq_l_0:Gain": 6, ... }.
export function filterParams(name: string): Record<string, number> {
  const out: Record<string, number> = {};
  const list: unknown[] = nodeProps(name).params ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) out[String(list[i])] = Number(list[i + 1]);
  return out;
}

// Keep a sink running by recording its monitor into nowhere.  A suspended
// node takes a new volume but goes on reporting the old one until it runs.
export function listen(sink: string) {
  pw(`setsid nohup pw-record --target ${sink} -P stream.capture.sink=true /dev/null > /dev/null 2>&1 < /dev/null &`);
  inPlayer('sleep', '0.5');
}

// A sink's volume as pactl reports it, in percent (front-left).
export function sinkVolume(sink: string): number {
  const out = pw(`pactl get-sink-volume ${sink}`);
  const m = out.match(/(\d+)%/);
  if (!m) throw new Error(`no volume for ${sink}: ${out}`);
  return Number(m[1]);
}

export function sinkMuted(sink: string): boolean {
  return /yes/.test(pw(`pactl get-sink-mute ${sink}`));
}

// What plays into a sink over `seconds`, from its monitor: mono 16-bit
// samples at 48 kHz.
export function record(sink: string, seconds: number): Int16Array {
  const path = `/tmp/fpp-tests-pw-rec-${sink}.wav`;
  pw(`rm -f ${path}; timeout -s INT ${seconds} pw-record --target ${sink} -P stream.capture.sink=true ` +
    `--rate 48000 --channels 1 --format s16 ${path} > /dev/null 2>&1; true`);
  const wav = readBinary(path);
  inPlayer('rm', '-f', path);
  return wavSamples(wav);
}

// A file in the player, as bytes; a minute of audio is more than inPlayer's
// default buffer takes.
export function readBinary(path: string): Buffer {
  return execFileSync('docker', ['exec', container, 'cat', path], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The samples of a 16-bit PCM WAV (its data chunk, or what follows the
// header of one whose sizes were never filled in).
export function wavSamples(wav: Buffer): Int16Array {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') {
      const end = size && off + 8 + size <= wav.length ? off + 8 + size : wav.length;
      const bytes = wav.subarray(off + 8, end - ((end - off - 8) % 2));
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the WAV');
}

// Where sound starts in `samples`: the start (in seconds) of each run of
// 10 ms windows louder than `threshold` (of full scale), after silence.
export function bursts(samples: Int16Array, rate: number, threshold = 0.05): number[] {
  const win = Math.round(rate / 100);
  const starts: number[] = [];
  let loud = false;
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += (samples[j] / 32768) ** 2;
    const now = Math.sqrt(sum / win) > threshold;
    if (now && !loud) starts.push(i / rate);
    loud = now;
  }
  return starts;
}
