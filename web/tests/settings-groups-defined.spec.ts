import { test, expect } from './fixtures';

// www/settings.json lists the settings of each group, and the children of a
// setting such as MediaBackend, by name and defines each one under
// "settings".  A name listed that nothing defines has no control to draw.

test('every setting a group or a parent setting lists is defined', async ({ request }) => {
  // Regression: 385863de0, which dropped PipeWireStreams from the Advanced
  // MediaBackend's children; 0293ec9d2 had listed it, but no setting of that
  // name was ever defined, so the list named a row that could not be drawn.
  // Also 8850b428a: the Input Control group listed PresetControlChannel,
  // which nothing defines.
  const r = await request.get('/settings.json');
  expect(r.ok()).toBeTruthy();
  const doc = await r.json();
  const defined = new Set(Object.keys(doc.settings));
  expect(defined.size).toBeGreaterThan(100); // the control: the file was read
  const undefinedNames: string[] = [];
  for (const [group, g] of Object.entries<any>(doc.settingGroups)) {
    for (const name of g.settings ?? []) {
      if (!defined.has(name)) undefinedNames.push(`${group}: ${name}`);
    }
  }
  for (const [parent, s] of Object.entries<any>(doc.settings)) {
    for (const [value, names] of Object.entries<any>(s.children ?? {})) {
      for (const name of names) {
        if (!defined.has(name)) undefinedNames.push(`${parent}=${value}: ${name}`);
      }
    }
  }
  expect(undefinedNames).toEqual([]);
});
