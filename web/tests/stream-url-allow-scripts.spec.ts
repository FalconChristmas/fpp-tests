import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';

// StreamURL()'s opt-in to running the <script class='streamScript'> blocks in
// a stream, and the escaping scripts/healthCheck gives the status strings it
// puts in those blocks.

const FILE = 'fpp-tests-stream-scripts.txt';
const CONTENT = "fpp-tests line\n<script class='streamScript'>window.__fppTestsStreamScript=(window.__fppTestsStreamScript||0)+1</script>\nfpp-tests end\n";

// Stream the file into a new div with StreamURL(..., allowScripts), wait for
// it to finish, and say how often its script ran.
async function streamWith(page: import('@playwright/test').Page, allowScripts: unknown) {
  return page.evaluate(([file, allow]) => new Promise<number>((resolve) => {
    (window as any).__fppTestsStreamScript = 0;
    const div = document.createElement('div');
    div.id = `fppTestsStream${Date.now()}`;
    document.body.appendChild(div);
    (window as any).fppTestsStreamDone = () => resolve((window as any).__fppTestsStreamScript);
    (window as any).StreamURL(`api/file/Uploads/${file}`, div.id, 'fppTestsStreamDone', 'fppTestsStreamDone',
      'GET', null, null, true, false, '', allow);
  }), [FILE, allowScripts] as const);
}

test('only allowScripts === true runs a stream\'s script blocks', async ({ page, request }) => {
  // Regression: d8ee2a1a8 ("Tidy the #3051 streamed-output follow-ups").  The
  // opt-in was tested with == true, so a caller passing 1 had the blocks in
  // its stream eval()'d, unlike raw, which takes only true itself.
  expect((await request.post(`/api/file/Uploads/${FILE}`, { data: CONTENT })).ok()).toBe(true);
  try {
    await page.goto('/index.php');
    await page.waitForFunction(() => typeof (window as any).StreamURL === 'function');
    // The control: the opt-in itself runs the block.
    expect(await streamWith(page, true)).toBeGreaterThan(0);
    for (const allow of [1, 'true', false]) {
      expect(await streamWith(page, allow), `allowScripts = ${JSON.stringify(allow)}`).toBe(0);
    }
  } finally {
    await request.delete(`/api/file/Uploads/${FILE}`);
  }
});

test('a Health Check status string comes out of its script block as the text it was', async ({ page }) => {
  // d8ee2a1a8 folded EscapeStatusStr's two seds into one, said to give the
  // same bytes (the JS quote pass never matched once " was &quot;): this
  // checks what the function makes of every character it escapes, run from
  // the tree's own scripts/healthCheck and put into .html("...") in the page
  // the way the Health Check's script blocks are.  It passes on the parent
  // too.
  test.skip(!container, 'runs scripts/healthCheck\'s function inside the run-web.sh container');
  const status = `a "quoted" it's <b>bold</b> & a \\back\\slash \\" </script> x\ny`;
  const fn = inPlayer('sed', '-n', '/^EscapeStatusStr()/,/^}/p', '/opt/fpp/scripts/healthCheck');
  expect(fn).toContain('EscapeStatusStr');
  const escaped = execFileSync('docker', ['exec', '-i', container, 'bash', '-c', `${fn}\nEscapeStatusStr "$(cat)"`],
    { input: status, encoding: 'utf8' });
  expect(escaped).not.toMatch(/[<>"'\n]/);
  await page.goto('/index.php');
  const shown = await page.evaluate((js) => {
    const div = document.createElement('div');
    div.id = 'fppTestsStatus';
    document.body.appendChild(div);
    // As a streamScript block's body runs it.
    // eslint-disable-next-line no-eval
    eval(`$('#fppTestsStatus').html("${js}");`);
    return [div.textContent, div.children.length];
  }, escaped);
  expect(shown).toEqual([status.replace('\n', ''), 0]);
});
