import { test, expect } from './fixtures';
import { container } from './container';
import { usesPipewireConfig } from './pw-config-files';

// GET /api/pipewire/control/routing: every input group against every output
// group, from the config.  A path with nothing stored is at full, unmuted.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const OUTPUT = 'pipewire-audio-groups.json', INPUT = 'pipewire-input-groups.json';
const write = usesPipewireConfig(OUTPUT, INPUT);

test('the matrix has each path, with what is stored or the defaults', async ({ request }) => {
  write(OUTPUT, { groups: [{ id: 1, name: 'Front' }, { id: 2 }] });
  write(INPUT, { inputGroups: [
    { id: 5, name: 'Mic', enabled: true, outputs: [1], routing: { 1: { volume: 40, mute: true } } },
    { id: 6 },
  ] });
  const body = await (await request.get('/api/pipewire/control/routing')).json();
  expect(body.status).toBe('OK');
  const defaults = { connected: false, volume: 100, mute: false };
  expect(body.matrix).toEqual([
    { inputGroupId: 5, inputGroupName: 'Mic', enabled: true, paths: [
      { outputGroupId: 1, outputGroupName: 'Front', connected: true, volume: 40, mute: true },
      { outputGroupId: 2, outputGroupName: 'Group 2', ...defaults },
    ] },
    { inputGroupId: 6, inputGroupName: 'Input 6', enabled: false, paths: [
      { outputGroupId: 1, outputGroupName: 'Front', ...defaults },
      { outputGroupId: 2, outputGroupName: 'Group 2', ...defaults },
    ] },
  ]);
});
