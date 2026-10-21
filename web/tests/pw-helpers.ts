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
  inPlayer('sh', '-c', `cd ${CONFIG} && rm -f pipewire-audio-groups.json pipewire-audio-groups.conf ` +
    `pipewire-input-groups.json pipewire-input-groups.conf pipewire-vban-instances.json pipewire-vban.conf ` +
    `pipewire-stream-slots.json pipewire-video-input-sources.json; ` +
    `rm -f /etc/pipewire/pipewire.conf.d/9*-fpp-*.conf ${PW_DUMP} /tmp/fpp-tests-pw-dump.json`);
}
