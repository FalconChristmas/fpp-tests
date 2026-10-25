import { test, expect } from './fixtures';

import http from 'http';
import type { AddressInfo } from 'net';
import type { APIRequestContext, Page } from '@playwright/test';

// A browser on another website reading the API with a request that needs a
// CORS preflight: the receiving end of the CORS headers Apache sends for /api.
// The other website is a page served by the test itself on another loopback
// port, so it is a different origin in the same address space (Chromium
// refuses a public page's requests to loopback outright), and no request
// interception is on (with it, Chromium does not make the preflight a real
// request).  Chromium itself sends the preflight and decides whether the
// request goes.

type Read = (path: string, headers: Record<string, string>) => Promise<string>;

// Runs `body` with other websites allowed to read the API and a `read` that
// fetches a path of it from the other website's page: "<status> <body>", or
// "refused: ..." when the browser did not send the request.
async function fromElsewhere(page: Page, request: APIRequestContext, baseURL: string, body: (read: Read) => Promise<void>) {
  const server = http.createServer((_, res) => res.end('<html><body>elsewhere</body></html>'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    expect((await request.put('/api/settings/AllowCrossOriginAPI', { data: '1' })).ok()).toBe(true);
    const base = new URL(baseURL).origin;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await body((path, headers) => page.evaluate(async ([url, h]) => {
      try {
        const r = await fetch(url, { headers: h });
        return `${r.status} ${await r.text()}`;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    }, [`${base}${path}`, headers] as const));
  } finally {
    server.close();
    await request.put('/api/settings/AllowCrossOriginAPI', { data: '0' });
  }
}

test('another website may send the API a Content-Type header and read the answer', async ({ page, request, baseURL }) => {
  // Regression: f4e282bb2 (the receiving end of api-docs.spec.ts's header
  // check).  Access-Control-Allow-Headers did not allow Content-Type, so the
  // browser's preflight for any cross-origin request carrying one (every
  // fetch with a JSON body) failed and the request was never sent.
  // Regression: fpp 482e1662d.  With the header allowed, the preflight itself
  // still failed: its OPTIONS was answered 404 by fppd (/api/fppd/...) and
  // 501 by limonade (PHP routes), and a browser takes only a 2xx preflight.
  // A GET of an fppd route stands in for the request: from 74eb6743f on, PHP
  // refuses a state-changing request from another origin anyway.
  await fromElsewhere(page, request, baseURL!, async (read) => {
    expect(await read('/api/fppd/version', { 'Content-Type': 'application/json' })).toMatch(/^200 .*"version"/);
    // The control: a header the API does not allow is refused at the preflight.
    expect(await read('/api/fppd/version', { 'X-Fpp-Tests': '1' })).toMatch(/^refused/);
  });
});

test('another website may read a PHP route with a Content-Type header', async ({ page, request, baseURL }) => {
  // Regression: fpp 8cf550dc0.  limonade replaced a GET's query string -- the
  // route (uri) with it -- with the JSON body the header announced, so once
  // the preflight went through, every PHP route answered it 404.
  await fromElsewhere(page, request, baseURL!, async (read) => {
    // The control: the same read with no header, which needs no preflight.
    const plain = await read('/api/settings/HostName', {});
    expect(plain).toMatch(/^200 /);
    expect(await read('/api/settings/HostName', { 'Content-Type': 'application/json' })).toBe(plain);
  });
});
