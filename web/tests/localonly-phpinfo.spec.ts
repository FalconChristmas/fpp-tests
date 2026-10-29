import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Troubleshooting page's Webserver tab shows the web server's phpinfo(),
// which lists the server's environment and paths.  It is fetched by the page's
// command from the player itself (curl http://localhost/localonly/...), and
// www/localonly answers only requests from the player's own loopback.
//
// Feature: e6389fc64 ("create locally locked down phpinfo for
// troubleshooter").  Its .htaccess has since moved into the site config
// (6785ba8c7), where the lock is checked here.

test.skip(!container, 'requests the pages from inside the run-web.sh container');

for (const page of ['phpinfo.php', 'cleanedphpinfo.php']) {
  test(`localonly/${page} is served to the player itself and refused to anyone else`, async ({ request }) => {
    const local = inPlayer('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://localhost/localonly/${page}`);
    expect(local, 'the troubleshooter could not fetch it').toBe('200');
    // The receiving end: what the local request gets is the web server's
    // phpinfo, which the Webserver tab frames.
    expect(inPlayer('curl', '-s', `http://localhost/localonly/${page}`)).toContain('FPM/FastCGI');

    const remote = await request.get(`/localonly/${page}`);
    expect(remote.status(), 'phpinfo was served to a remote browser').toBe(403);
    expect(await remote.text()).not.toContain('FPM/FastCGI');
  });
}
