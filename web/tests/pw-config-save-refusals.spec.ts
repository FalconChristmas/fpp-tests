import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, readFile } from './settings-file';
import { usesPipewireConfig } from './pw-config-files';

// The PipeWire pages' list saves, each "POST a JSON object holding one list":
// audio output groups, input groups, video input sources, Opus RTP instances
// and VBAN instances (www/api/controllers/pipewire.php).  Each writes a config
// file that the audio and video graph is later built from; none applies it.
// What each does with a body that is not such an object, and with an element
// that brings no id.  The config file is read back after every request.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const SAVES = [
  { what: 'audio output groups', url: '/api/pipewire/audio/groups', file: 'pipewire-audio-groups.json', key: 'groups', missing: "Missing 'groups' array" },
  { what: 'input groups', url: '/api/pipewire/audio/input-groups', file: 'pipewire-input-groups.json', key: 'inputGroups', missing: "Missing 'inputGroups' array" },
  { what: 'video input sources', url: '/api/pipewire/video/input-sources', file: 'pipewire-video-input-sources.json', key: 'videoInputSources', missing: "Missing 'videoInputSources' array" },
  { what: 'Opus RTP instances', url: '/api/pipewire/opusrtp/instances', file: 'pipewire-opus-rtp-instances.json', key: 'instances', missing: 'Missing instances array' },
  { what: 'VBAN instances', url: '/api/pipewire/vban/instances', file: 'pipewire-vban-instances.json', key: 'instances', missing: 'Missing instances array' },
] as const;

const write = usesPipewireConfig(...SAVES.map((s) => s.file));
const path = (name: string) => `${MEDIA}/config/${name}`;
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });
const kept = (key: string) => ({ [key]: [{ id: 4, name: 'fpp-tests kept', enabled: false }] });

for (const s of SAVES) {
  test.describe(s.what, () => {
    test('a body that is not JSON, or has no list, is refused and the saved list stays', async ({ request }) => {
      write(s.file, kept(s.key));
      const before = readFile(path(s.file));
      for (const [body, message] of [
        [`{"${s.key}": [`, 'Invalid JSON'],
        ['', 'Invalid JSON'],
        ['{"other": []}', s.missing],
        [`{"${s.key}": "all"}`, s.missing],
        ['[]', s.missing],
      ]) {
        const r = await request.post(s.url, raw(body));
        expect(r.status(), body).toBe(400);
        expect(await r.json(), body).toEqual({ status: 'ERROR', message });
        expect(readFile(path(s.file)), body).toBe(before);
      }
    });

    test('an element with no id is given one that no other element has', async ({ request }) => {
      inPlayer('rm', '-f', path(s.file));
      const r = await request.post(s.url, { data: { [s.key]: [
        { id: 6, name: 'fpp-tests six', enabled: false }, { name: 'fpp-tests new', enabled: false }, { name: 'fpp-tests newer', enabled: false },
      ] } });
      expect(r.status(), await r.text()).toBe(200);
      expect(exists(path(s.file))).toBe(true);
      const list = JSON.parse(readFile(path(s.file)))[s.key];
      expect(list.map((e: any) => e.name)).toEqual(['fpp-tests six', 'fpp-tests new', 'fpp-tests newer']);
      const ids = list.map((e: any) => e.id);
      expect(ids[0]).toBe(6);
      expect(new Set(ids).size, `ids ${ids}`).toBe(3);
      for (const id of ids) expect(Number.isInteger(id) && id > 0, `ids ${ids}`).toBe(true);
    });

    test('an element that is not an object is refused, and the saved list stays', async ({ request }) => {
      test.fail(true, 'elements are indexed unchecked: a PHP fatal with a 200, or the element is stored as it came (FUTURE.md)');
      write(s.file, kept(s.key));
      const before = readFile(path(s.file));
      const r = await request.post(s.url, { data: { [s.key]: [{ id: 1, name: 'fpp-tests ok', enabled: false }, 'a string', 5] } });
      const text = await r.text();
      expect(text).not.toContain('Fatal error');
      expect(readFile(path(s.file)), `stored (answer ${r.status()})`).toBe(before);
      expect(r.status()).toBe(400);
    });
  });
}
