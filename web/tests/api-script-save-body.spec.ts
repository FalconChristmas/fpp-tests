import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// POST /api/scripts/<name> used to json_decode() every request body.  The
// bundled editor sends JSON.stringify(contents), so it worked, but the
// endpoint's docs say it writes the raw POST body.  A client doing that sent
// plain script text, json_decode() returned null, and file_put_contents()
// truncated the script to zero bytes.  These tests pin both contracts: the
// documented raw body and the editor's JSON string.

test.skip(!container, 'seeds and checks scripts inside the run-web.sh container');

const SCRIPTS = '/home/fpp/media/scripts';

function seed(name: string, content: string) {
  inPlayer('sh', '-c', `mkdir -p '${SCRIPTS}' && printf %s '${content}' > '${SCRIPTS}/${name}'`);
}
function remove(name: string) {
  inPlayer('rm', '-f', `${SCRIPTS}/${name}`);
}
function readText(name: string): string {
  return inPlayer('cat', `${SCRIPTS}/${name}`);
}
function readBytes(name: string): Buffer {
  return Buffer.from(inPlayer('sh', '-c', `base64 -w0 '${SCRIPTS}/${name}'`).trim(), 'base64');
}

test('a raw POST body is written to the script', async ({ request }) => {
  const name = 'fpp-tests-raw-body.sh';
  const original = '#!/bin/sh\necho "before"\n';
  const body = '#!/bin/sh\n# raw & + % and spaces\necho "raw body"\n';
  seed(name, original);
  try {
    const r = await request.post(`/api/scripts/${name}`, {
      headers: { 'Content-Type': 'text/plain' },
      data: body,
    });
    const text = await r.text();
    expect(r.ok(), text).toBe(true);
    expect(JSON.parse(text).status).toBe('OK');
    // The old code wrote an empty file here.
    expect(readText(name)).toBe(body);
  } finally {
    remove(name);
  }
});

test("the editor's JSON-string body is still decoded", async ({ request }) => {
  const name = 'fpp-tests-json-body.sh';
  const body = '#!/bin/sh\necho "json body"\n';
  seed(name, '#!/bin/sh\necho "before"\n');
  try {
    const r = await request.post(`/api/scripts/${name}`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
    });
    const text = await r.text();
    expect(r.ok(), text).toBe(true);
    expect(JSON.parse(text).status).toBe('OK');
    // The editor's body is a JSON string, not the script itself.
    expect(readText(name)).toBe(body);
  } finally {
    remove(name);
  }
});

test('a non-UTF-8 raw body is saved byte for byte and still gets a JSON reply', async ({ request }) => {
  const name = 'fpp-tests-latin1-body.sh';
  // 0xE9 is "é" in Latin-1 and invalid on its own in UTF-8.
  const body = Buffer.from('#!/bin/sh\n# caf\xe9\n', 'latin1');
  seed(name, '#!/bin/sh\necho "before"\n');
  try {
    const r = await request.post(`/api/scripts/${name}`, {
      headers: { 'Content-Type': 'text/plain' },
      data: body,
    });
    const text = await r.text();
    expect(r.ok(), text).toBe(true);
    // json_encode() of the echoed scriptBody must not fail the whole reply.
    expect(JSON.parse(text).status).toBe('OK');
    expect(readBytes(name).equals(body)).toBe(true);
  } finally {
    remove(name);
  }
});
