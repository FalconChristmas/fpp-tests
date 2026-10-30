import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';
import { answerUpdateCheck } from './standin-http';
import { readFile, writeFile } from './pw-helpers';

// Every MultiSync action ("Run" under the systems table) first asks the
// player to regenerate its Content-Security-Policy (CSP_regeneration_script.php
// runs ManageApacheContentPolicy.sh regenerate), so whatever the policy is
// built from now is what Apache serves before the action talks to anything.
// The receiving end is Apache: the header it serves afterwards.  The player
// has no systemd, so a systemctl stand-in turns the script's
// `systemctl reload apache2` into a real graceful reload.
//
// The generated policy and the override file are put back, and Apache
// reloaded, so later specs see the policy run-web.sh generated.

test.skip(!container, 'changes the player\'s own CSP files and reloads its Apache');

const CSP_FILE = '/opt/fpp/etc/apache2.csp';
const OVERRIDES = '/home/fpp/media/config/csp_allowed_domains.json';
// sudo's secure_path is what the script's systemctl is looked up in, so the
// stand-in takes the real one's place (as in csp-generator.spec.ts).
const SYSTEMCTL = '/usr/bin/systemctl';
const REAL = '/tmp/fpp-tests-csp-regen-systemctl.real';

async function connectSrc(request: APIRequestContext): Promise<string[]> {
  const header = (await request.get('/index.php')).headers()['content-security-policy'] ?? '';
  const part = header.split(';').map((p) => p.trim().split(/\s+/)).find((p) => p[0] === 'connect-src');
  return part ? part.slice(1) : [];
}

test('a MultiSync action regenerates the CSP Apache serves', async ({ page, request }) => {
  // Feature: 3143b98ef.  Before it nothing on the MultiSync page touched the
  // policy: a source added to the override file stayed out of the served
  // header until something else regenerated it.
  const added = 'https://multisync-action.fpp-tests.invalid';
  const before = (await request.get('/index.php')).headers()['content-security-policy'] ?? '';
  expect(before, 'run-web.sh\'s player serves a generated CSP').toContain('connect-src');
  try {
    await keepingFile(CSP_FILE, () => keepingFile(OVERRIDES, async () => {
      inPlayer('cp', '-a', SYSTEMCTL, REAL);
      writeFile(SYSTEMCTL, `#!/bin/sh
case "$*" in
  "is-active --quiet apache2") exit 0 ;;
  "reload apache2") exec apache2ctl graceful ;;
esac
exec ${REAL} "$@"
`);
      inPlayer('chmod', '755', SYSTEMCTL);
      // The override is written as the file is, without regenerating: only
      // a regeneration puts it into the header.
      const raw = readFile(OVERRIDES).trim();
      const overrides = raw ? JSON.parse(raw) : {};
      overrides['connect-src'] = [...(overrides['connect-src'] ?? []), added];
      writeFile(OVERRIDES, JSON.stringify(overrides));
      expect(await connectSrc(request)).not.toContain(added);

      await page.setViewportSize({ width: 1600, height: 1000 });
      await answerUpdateCheck(page);
      await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
      await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [] } }));
      await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
      await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
      await page.goto('/multisync.php');
      // No action picked: the page only alerts, after asking for the
      // regeneration.
      page.on('dialog', (d) => d.accept());
      const asked: number[] = [];
      page.on('response', (r) => {
        if (r.url().includes('CSP_regeneration_script.php')) asked.push(r.status());
      });
      await page.evaluate('performMultiAction()');
      await expect.poll(() => connectSrc(request), {
        message: 'Apache serves the regenerated policy', timeout: 15_000,
      }).toContain(added);
      expect(asked).toEqual([200]);
    }));
  } finally {
    inPlayer('sh', '-c', `if [ -e ${REAL} ]; then cp -a ${REAL} ${SYSTEMCTL} && rm -f ${REAL}; fi`);
    inPlayer('apache2ctl', 'graceful');
    await expect.poll(async () => (await request.get('/index.php')).headers()['content-security-policy'] ?? '',
      { message: 'the original policy is served again', timeout: 15_000 }).toBe(before);
  }
});
