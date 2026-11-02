import { test, expect } from './fixtures';

// The FPP Commands Help page (commandhelp.php), split off the REST API help
// page: its own page with the command tester and the table of every command
// fppd offers, filled in from api/commands.

test('FPP Commands Help is its own page, with the command tester and every command', async ({ page, request }) => {
  // Regression: 149f2ea55 ("Split REST API Help and Command help to 2
  // seperate pages").  Linked from Get Help (help-pages.spec.ts checks the
  // link); the page itself has the command tester and the command listing.
  const commands = await (await request.get('/api/commands')).json();
  expect(commands.length).toBeGreaterThan(5);

  const res = await page.goto('/commandhelp.php');
  expect(res!.status()).toBe(200);
  await expect(page.locator('h1.title')).toHaveText('FPP Commands Help');
  await expect(page.locator('#commands')).toBeAttached({ timeout: 15_000 });
  // The listing is drawn from api/commands, one row per command.
  const names: string[] = commands.map((c: any) => c.name);
  await expect(page.locator('#commands .commandRow')).toHaveCount(commands.length, { timeout: 15_000 });
  await expect(page.locator('#commands')).toContainText(names[0]);
  await expect(page.locator('a[name="command_tester"]')).toBeAttached();
});
