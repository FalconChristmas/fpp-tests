import { test, expect } from './fixtures';
import { container } from './container';
import { usesPipewireConfig } from './pw-config-files';

// GET /api/pipewire/control/input-groups, and one of them by id.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const INPUT = 'pipewire-input-groups.json';
const write = usesPipewireConfig(INPUT);

test('the list has the groups, one is found by id, and an unknown id is a 404', async ({ request }) => {
  write(INPUT, { inputGroups: [{ id: 5, name: 'Mic', enabled: true }, { id: 6, name: 'Line' }] });
  const list = await (await request.get('/api/pipewire/control/input-groups')).json();
  expect(list.inputGroups.map((g: any) => g.id)).toEqual([5, 6]);

  const one = await (await request.get('/api/pipewire/control/input-groups/6')).json();
  expect(one.inputGroup).toMatchObject({ id: 6, name: 'Line' });

  const missing = await request.get('/api/pipewire/control/input-groups/99');
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toMatchObject({ status: 'ERROR', message: 'Input group 99 not found' });
});
