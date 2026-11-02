import { test, expect } from './fixtures';
import { container } from './container';
import { StandIn } from './standin-http';

// /api/system/status?ip[]=... polls remotes for the MultiSync page: for an
// FPP-type remote it asks the remote's own /api/system/status.  The remote is
// a stand-in on a host of its own next to the player.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const OLD = '/fppjson.php?command=getFPPstatus&advancedView=true';

test('a remote without /api/system/status is polled through fppjson.php', async ({ request }) => {
  // Regression: f0da77b3d.  An old FPP (or an ESPixelStick) answers 404 for
  // the API status URL; the poll showed it as unknown/stopped instead of
  // trying its fppjson.php status.
  const old = StandIn.sibling('oldfpp', {
    [OLD]: { json: { fppd: 'running', status_name: 'idle', mode_name: 'remote' } },
  });
  try {
    old.start();
    const r = await request.get(`/api/system/status?ip[]=${old.address}`);
    expect(r.ok(), await r.text()).toBe(true);
    const body = await r.json();
    expect(body[old.address], JSON.stringify(body)).toMatchObject({ fppd: 'running', status_name: 'idle', mode_name: 'remote' });
    // The receiving end saw the API URL first and then the fallback.
    expect(old.requests().map((q) => q.path)).toEqual(['/api/system/status', OLD]);
  } finally {
    old.stop();
  }
});

test('a password-protected remote shows as password, with no fallback', async ({ request }) => {
  // The control: a 401 is not an old FPP and must not be retried.
  const locked = StandIn.sibling('lockedfpp', {
    '/api/system/status': { status: 401, json: { message: 'Unauthorized' } },
    [OLD]: { json: { fppd: 'running', status_name: 'idle' } },
  });
  try {
    locked.start();
    const r = await request.get(`/api/system/status?ip[]=${locked.address}`);
    const body = await r.json();
    expect(body[locked.address], JSON.stringify(body)).toMatchObject({ status_name: 'password' });
    expect(locked.requests().map((q) => q.path)).toEqual(['/api/system/status']);
  } finally {
    locked.stop();
  }
});
