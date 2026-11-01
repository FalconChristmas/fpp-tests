import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, fakeSoundCards, hwParams, readFile, sinkNode, standInAplay, standInPwDump, writeFile } from './pw-helpers';

// An audio output group member's cached nodeTarget names a live sink that
// plays out of a different sound card (WirePlumber's own node, whose name
// says nothing about the card).  The cards are fakes (/proc/asound, aplay);
// the graph is a stand-in pw-dump whose sinks carry alsa.card.

test.skip(!container, 'stubs sound cards and pw-dump and reads the generated config inside the run-web.sh container');

test.afterEach(cleanupPipeWire);

const OTHER = 'alsa_output.usb-fpp_tests_other-00.analog-stereo';
const DAC = 'alsa_output.usb-fpp_tests_dac-00.analog-stereo';

async function apply(request: APIRequestContext, member: Record<string, unknown>) {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [{ channels: 2, ...member }] }],
  });
  const r = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  await settleAfterApply(request);
  return {
    conf: readFile(`${CONFIG}/pipewire-audio-groups.conf`),
    member: JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups.json`)).groups[0].members[0],
  };
}

test("a cached WirePlumber sink that plays out of another card is not used for this one", async ({ request }) => {
  // Regression: b5d358e96. A member moved to card DAC kept the nodeTarget
  // resolved for its old card, a WirePlumber sink (no fpp_alsa_ name to tell
  // it by) that was still live; Priority 1 accepted it and cached it as DAC's
  // hardware, so the group kept playing out of the old card.
  fakeSoundCards([{ id: 'OTHER' }, { id: 'DAC' }]);
  standInAplay({ 'hw:OTHER': hwParams(), 'hw:DAC': hwParams() });
  const dump = standInPwDump([
    sinkNode(40, OTHER, { 'alsa.card': 0 }),
    sinkNode(41, DAC, { 'alsa.card': 1 }),
  ]);
  expect(dump, 'the stand-in pw-dump is not the one the API runs').toContain(DAC);

  const { conf, member } = await apply(request, { cardId: 'DAC', nodeTarget: OTHER });
  expect(member.nodeTarget).toBe(DAC);
  expect(conf).toContain(`"${DAC}"`);
  expect(conf, 'the group still targets the other card').not.toContain(OTHER);

  // The control: the same cached name for the card it plays out of is kept.
  const own = await apply(request, { cardId: 'OTHER', nodeTarget: OTHER });
  expect(own.member.nodeTarget).toBe(OTHER);
  expect(own.conf).toContain(`"${OTHER}"`);
});
