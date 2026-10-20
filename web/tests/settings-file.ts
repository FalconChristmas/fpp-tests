import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';

// The player's settings file and backups directory, read and written from
// inside the player: for the tests that need to see exactly what PHP wrote, or
// to seed a file PHP has to read the way a hand edit or an older FPP left it.

export const MEDIA = '/home/fpp/media';
export const SETTINGS = `${MEDIA}/settings`;
export const BACKUPS = `${MEDIA}/config/backups`;

// Write a file inside the player, any bytes, without shell quoting.
export function putFile(path: string, content: string | Buffer) {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}'`], { input: content, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function readFile(path: string): string {
  return inPlayer('cat', path);
}

export function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}

// A setting's value as the settings file holds it, outer quotes removed;
// undefined when the file has no such key.
export function settingInFile(name: string): string | undefined {
  for (const line of readFile(SETTINGS).split('\n')) {
    const m = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name) {
      const v = m[2].trim();
      return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
    }
  }
  return undefined;
}

// Set (or with undefined, drop) one key in the settings file directly, as a
// hand edit would: no validation, no apply step.
export function setSettingInFile(name: string, value: string | undefined, quoted = true) {
  const lines = readFile(SETTINGS).split('\n').filter((l) => l !== '' && !new RegExp(`^\\s*${name}\\s*=`).test(l));
  if (value !== undefined) {
    lines.push(`${name} = ${quoted ? `"${value}"` : value}`);
  }
  putFile(SETTINGS, lines.join('\n') + '\n');
}

// Keep the settings file as it is now and put it back afterwards (in place,
// so its owner and mode stay), for a test that restores a backup over it.
export function snapshotSettings(): () => void {
  const saved = readFile(SETTINGS);
  return () => putFile(SETTINGS, saved);
}

// This player's own identity, as getSystemUUID() reports it.
export function deviceUUID(): string {
  return inPlayer('/opt/fpp/scripts/get_uuid').trim();
}
