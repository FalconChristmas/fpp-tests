import { inPlayer } from './container';
import { dump, pw, record, startPipeWire } from './pw-live';

// The receiving end of the pw-*-conf specs: the config the PHP wrote under
// /etc/pipewire/pipewire.conf.d, loaded by a real PipeWire (pw-live.ts) and
// read back with the real pw-dump.  Null sinks stand in for what the config
// expects to find there -- the cards' sinks, the output groups' sinks a mix
// bus feeds -- and FPP's own ALSA adapters, which need a sound card to open,
// are loaded as null sinks with the config's own properties
// (loadGeneratedConf({ nullAdapters: true })).

// A null node standing in for a card, a group sink or a capture device.
export function standInNode(name: string, o: { positions?: string[]; mediaClass?: string; props?: Record<string, string | number> } = {}) {
  const pos = o.positions ?? ['FL', 'FR'];
  const extra = Object.entries(o.props ?? {}).map(([k, v]) => `${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}`).join(' ');
  return `{ factory = adapter args = { factory.name = support.null-audio-sink node.name = ${JSON.stringify(name)} ` +
    `node.description = ${JSON.stringify(name)} media.class = ${JSON.stringify(o.mediaClass ?? 'Audio/Sink')} ` +
    `audio.channels = ${pos.length} audio.position = [ ${pos.join(' ')} ] monitor.channel-volumes = true ${extra} } }`;
}

// Start a real PipeWire on the generated config with `standIns` next to it,
// once every node in `waitFor` is up.  The stand-in pw-dump, pw-cli and pactl
// the PHP side used are removed first, so from here on the real ones answer.
export function loadGeneratedConf(standIns: string[], waitFor: string[], o: { nullAdapters?: boolean } = {}) {
  inPlayer('rm', '-f', '/usr/local/bin/pw-dump', '/usr/local/bin/pw-cli', '/usr/local/bin/pactl', '/tmp/fpp-tests-pw-dump.json');
  if (o.nullAdapters) {
    inPlayer('sh', '-c', "sed -i 's/factory.name = api.alsa.pcm.sink/factory.name = support.null-audio-sink/' " +
      '/etc/pipewire/pipewire.conf.d/9*-fpp-*.conf');
  }
  startPipeWire({ objects: standIns, waitFor });
}

export type Graph = {
  nodes: Map<string, any>;
  ports: { node: string; dir: string; channel: string }[];
  links: [string, string][];
};

export function graph(): Graph {
  const all = dump();
  const byId = new Map<number, string>();
  const nodes = new Map<string, any>();
  for (const o of all) {
    if (o.type !== 'PipeWire:Interface:Node') continue;
    const name = o.info?.props?.['node.name'];
    if (!name) continue;
    byId.set(o.id, name);
    nodes.set(name, o);
  }
  const ports = all.filter((o) => o.type === 'PipeWire:Interface:Port').map((o) => ({
    node: byId.get(o.info?.props?.['node.id']) ?? '', dir: o.info?.direction, channel: o.info?.props?.['audio.channel'] ?? '',
  }));
  const links = all.filter((o) => o.type === 'PipeWire:Interface:Link')
    .map((o) => [byId.get(o.info['output-node-id']) ?? '', byId.get(o.info['input-node-id']) ?? ''] as [string, string]);
  return { nodes, ports, links };
}

export function props(g: Graph, name: string): Record<string, any> {
  return g.nodes.get(name)?.info?.props ?? {};
}

// The channels of a node's ports in one direction, in port order.
export function channels(g: Graph, name: string, dir: 'input' | 'output'): string[] {
  return g.ports.filter((p) => p.node === name && p.dir === dir).map((p) => p.channel);
}

export function linked(g: Graph, from: string, to: string): boolean {
  return g.links.some(([a, b]) => a === from && b === to);
}

// Whether audio played into `from` gets to `to`: along links, and across the
// two halves PipeWire makes of each FPP module -- a combine-stream sink to its
// output.<sink>_<target> streams, a filter chain's sink to its <name>_out, a
// loopback's input.<name> to output.<name>.
export function reaches(g: Graph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const next = (n: string) => [
    ...g.links.filter(([a]) => a === n).map(([, b]) => b),
    ...[...g.nodes.keys()].filter((m) => m.startsWith(`output.${n}_`) || m === `${n}_out` ||
      (n.startsWith('input.') && m === `output.${n.slice(6)}`)),
  ];
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    queue.push(...next(n));
  }
  return false;
}

// For an assertion message: every link in the graph.
export function describe(g: Graph): string {
  return `nodes: ${[...g.nodes.keys()].join(', ')}\nlinks:\n${[...new Set(g.links.map(([a, b]) => `  ${a} -> ${b}`))].join('\n')}`;
}

// A half-scale 440 Hz tone played into `sink` while `target`'s monitor is
// recorded: the recording's peak, as a fraction of full scale.
export function peakThrough(sink: string, target: string): number {
  pw(`python3 -c "import math,struct,wave; w=wave.open('/tmp/fpp-tests-tone.wav','wb'); w.setnchannels(2); ` +
    `w.setsampwidth(2); w.setframerate(48000); w.writeframes(b''.join(struct.pack('<hh', *(2*[int(16384*math.sin(` +
    `2*math.pi*440*i/48000))])) for i in range(48000*4)))"`);
  pw(`setsid nohup pw-cat -p --target ${sink} /tmp/fpp-tests-tone.wav > /dev/null 2>&1 < /dev/null &`);
  try {
    inPlayer('sleep', '0.7');
    const samples = record(target, 1.5);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    return peak / 32768;
  } finally {
    pw('pkill -x pw-cat; rm -f /tmp/fpp-tests-tone.wav; true');
  }
}

// Run a command in the player against the real PipeWire.
export { pw };
