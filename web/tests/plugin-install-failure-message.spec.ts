import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, installPluginStreamed } from './plugin-backfill';

// A plugin install whose repository cannot be fetched says so in the
// streamed output and points at the Internet-access check (Features:
// 139ee0303, 9afe200d2: "Failed to fetch <name> using <url> -- aborting",
// then the hint about functioning Internet access and the System Health
// Check).

test.skip(!container, 'installs plugins inside the run-web.sh container');

test('a plugin whose repository cannot be reached is reported with the Internet-access hint', async ({ request }) => {
  const repo = new PluginRepo('fpp-tests-unreachable');
  const out = await installPluginStreamed(request, repo.info({ srcURL: 'http://127.0.0.1:1/no/such/repo.git' }));
  try {
    expect(out).toContain('Failed to fetch fpp-tests-unreachable using');
    expect(out).toContain('-- aborting');
    expect(out).toContain('The most common reason plugin installs fail is the lack of functioning Internet Access');
    expect(out).toContain("'Help' menu and selecting 'System Heath Check'");
  } finally {
    repo.remove();
  }
});
