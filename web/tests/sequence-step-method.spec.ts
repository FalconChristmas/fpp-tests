import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Testing page's sequence Pause/Resume and Step buttons (fpp.js
// ToggleSequencePause / SingleStepSequence).  Both change what fppd is
// playing.  fpp 77efc7561 moved FPP's own state-changing calls to POST and
// registered a POST for each route (state-changing-posts.spec.ts);
// sequence/current/step was not among them.  With nothing playing, both
// commands are no-ops in fppd.

async function sent(page: Page, fn: string, path: string) {
  const methods: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === path) methods.push(r.method()); });
  await page.goto('/index.php');
  await page.evaluate((f) => (window as any)[f](), fn);
  await expect.poll(() => methods.length).toBe(1);
  return methods[0];
}

test('Pause/Resume is a POST, and the route takes one', async ({ page, request }) => {
  expect(await sent(page, 'ToggleSequencePause', '/api/sequence/current/togglePause')).toBe('POST');
  const r = await request.post('/api/sequence/current/togglePause');
  expect(r.status()).toBe(200);
  expect(r.headers()['deprecation']).toBeUndefined();
});

test('Step is a POST, and the route takes one', async ({ page, request }) => {
  test.fail(true, 'sequence/current/step is GET-only and SingleStepSequence uses $.get (FUTURE.md)');
  const r = await request.post('/api/sequence/current/step');
  expect(r.status(), 'POST /api/sequence/current/step is not routed').toBe(200);
  expect(await sent(page, 'SingleStepSequence', '/api/sequence/current/step')).toBe('POST');
});
