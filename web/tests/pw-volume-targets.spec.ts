import { test, expect } from './fixtures';
import { container } from './container';
import { usesPipewireConfig } from './pw-config-files';

// GET /api/pipewire/audio/targets: what a volume command can be aimed at, for
// its picker.  Five media slots always, then what the group config names.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const OUTPUT = 'pipewire-audio-groups.json', INPUT = 'pipewire-input-groups.json';
const write = usesPipewireConfig(OUTPUT, INPUT);

test('the targets name the slots, output groups and their cards, input members and routes', async ({ request }) => {
  write(OUTPUT, { groups: [{ id: 1, name: 'Front Yard', members: [{ cardId: 'USB-1' }, { cardId: '' }] }] });
  write(INPUT, { inputGroups: [{ id: 5, name: 'Mic', members: [{ name: 'Left' }, {}], outputs: [1, 9] }] });
  const targets = await (await request.get('/api/pipewire/audio/targets')).json();
  for (let slot = 1; slot <= 5; slot++) expect(targets[`slot:${slot}`]).toBe(`Media Stream Slot ${slot}`);
  expect(targets).toMatchObject({
    'sink:fpp_group_front_yard': 'Output Group: Front Yard',
    'sink:fpp_fx_g1_usb_1': '  Front Yard / USB-1',
    'input:5:0': 'Mic / Left',
    'input:5:1': 'Mic / Member 1',
    'route:5:1': 'Mic → Front Yard',
    'route:5:9': 'Mic → Group 9',
  });
  // A member with no card is no target of its own.
  expect(Object.keys(targets).filter((k) => k.startsWith('sink:fpp_fx_'))).toEqual(['sink:fpp_fx_g1_usb_1']);
});
