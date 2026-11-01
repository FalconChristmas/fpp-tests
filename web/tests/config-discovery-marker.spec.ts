import { test, expect } from './fixtures';

// Another player finds this one by fetching its front page and looking for
// "Falcon Player - FPP" in the HTML (NetworkController::DetectFPP in fppd),
// before it asks /api/system/info for the rest.

// Regression: bf2c213ff.  The text was only in the <title>, which names the
// host ("FPP - <host name>") for any player not called FPP, so discovery over
// HTTP skipped it.  config.php puts the text in a comment on every page.
test('every page carries the text HTTP discovery looks for, whatever the host is called', async ({ request }) => {
  const host = (await (await request.get('/api/settings/HostName')).json()).value;
  for (const page of ['/', '/index.php', '/about.php']) {
    const html = await (await request.get(page)).text();
    expect(html.includes('Falcon Player - FPP'), `${page} (host ${host}) lacks the discovery text`).toBe(true);
  }
  // The title is not what carries it: it names the host unless that is "FPP".
  const html = await (await request.get('/')).text();
  expect(html.replace(/<title>[\s\S]*?<\/title>/i, '').includes('Falcon Player - FPP'), 'only the title carries it').toBe(true);
});
