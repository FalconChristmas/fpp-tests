import { test } from './fixtures';
import { inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// The PipeWire config files a test writes in the player, put back after it, so
// the API's reading of them can be checked without a live PipeWire graph.
export function usesPipewireConfig(...names: string[]) {
  const path = (n: string) => `${MEDIA}/config/${n}`;
  const before = new Map<string, string | undefined>();
  test.beforeEach(() => {
    for (const n of names) before.set(n, exists(path(n)) ? readFile(path(n)) : undefined);
  });
  test.afterEach(() => {
    for (const n of names) {
      const old = before.get(n);
      if (old === undefined) inPlayer('rm', '-f', path(n));
      else putFile(path(n), old);
    }
  });
  return (name: string, content: unknown) => putFile(path(name), JSON.stringify(content));
}
