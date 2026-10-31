import { test, expect } from './fixtures';
import { container } from './container';
import { php } from './privacy-helpers';

// The Force HDMI Resolution choices (hdmi_table.json.php) by board: the
// Compute Modules 4 and 5 get the 4K modes their Pi 4/5 counterparts do.
// Run with the SubPlatform a board reports (the container has no device tree).

test.skip(!container, 'runs the tree\'s PHP inside the run-web.sh container');

const modes = (subPlatform: string): string[] => JSON.parse(php(
  `$settings['SubPlatform'] = '${subPlatform}';\ninclude '/opt/fpp/www/hdmi_table.json.php';`));

for (const [feature, board] of [
  ['e213bab8e', 'Raspberry Pi Compute Module 4 Rev 1.0'],
  ['b7c9cb7a4', 'Raspberry Pi Compute Module 5 Rev 1.0'],
]) {
  test(`a ${board} is offered the 4K modes (${feature})`, async () => {
    expect(modes(board).filter((m) => m.startsWith('3840')).length).toBe(5);
  });
}

test('a Pi 3 is not offered 4K modes', async () => {
  // The control: the table is by board.
  expect(modes('Raspberry Pi 3 Model B Plus Rev 1.3').filter((m) => m.startsWith('3840'))).toEqual([]);
});
