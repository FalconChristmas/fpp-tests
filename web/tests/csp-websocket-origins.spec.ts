import { test, expect } from './fixtures';
import { container, playerAddress } from './container';

// The CSP the player generates for itself (ManageApacheContentPolicy.sh,
// which run-web.sh's container runs as a fresh player does) and what the
// browser then lets a page connect to.

test.skip(!container, 'needs the run-web.sh player\'s own address');

function connectSrc(csp: string): string[] {
  const d = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
  return (d ?? '').split(/\s+/).slice(1);
}

test('connect-src lets a page open a WebSocket to any port of the player\'s own addresses', async ({ page, request }) => {
  // Feature: 4daa252e5.  A plugin or FPP service with a WebSocket on a port
  // of its own needed a CSP entry per port; connect-src now has ws://<each
  // local IPv4>:*, ws://localhost:* and ws://127.0.0.1:*.  The receiving end
  // is the browser: a socket to a port nothing names is not blocked.
  const csp = (await request.get('/index.php')).headers()['content-security-policy'] ?? '';
  const src = connectSrc(csp);
  expect(src).toEqual(expect.arrayContaining([`ws://${playerAddress().ip}:*`, 'ws://localhost:*', 'ws://127.0.0.1:*']));

  await page.goto('/about.php');
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    const tryOpen = (url: string) => new Promise<string>((resolve) => {
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => { ws.close(); resolve('open'); };
        ws.onerror = () => resolve('error');
      } catch (e) {
        resolve(`threw ${(e as Error).name}`);
      }
    });
    // Ports nothing listens on: the socket fails to connect, which is not a
    // CSP block.  The control is a host no directive names.
    const local = await tryOpen('ws://127.0.0.1:38999/fpp-tests');
    const named = await tryOpen('ws://localhost:38998/fpp-tests');
    const other = await tryOpen('ws://192.0.2.77:38997/fpp-tests');
    await new Promise((r) => setTimeout(r, 300));
    return { local, named, other, violations };
  });
  const blocked = (host: string) => result.violations.some((v) => v.includes(host));
  expect(blocked('192.0.2.77'), `the control: ${JSON.stringify(result)}`).toBe(true);
  expect(blocked('127.0.0.1'), JSON.stringify(result)).toBe(false);
  expect(blocked('localhost'), JSON.stringify(result)).toBe(false);
});
