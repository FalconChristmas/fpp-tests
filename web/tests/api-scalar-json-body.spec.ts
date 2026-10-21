import { test, expect } from './fixtures';

// A POST whose JSON body is valid but not an object or array is answered by
// its route. Regression: fd990df6b ("a JSON request body that is not an
// object or array no longer kills the request"). limonade decoded the body
// into $_POST, and request_method() then called array_key_exists() on the
// scalar: a PHP fatal before any route ran, answered 200 with the fatal's HTML.

test('a POST whose JSON body is a string, number or true is answered by its route', async ({ request }) => {
  for (const body of ['"just a string"', '42', 'true']) {
    const r = await request.post('/api/channel/output/processors', {
      headers: { 'Content-Type': 'application/json' }, data: Buffer.from(body),
    });
    const text = await r.text();
    expect(text, `${body}: limonade died on the body`).not.toContain('Fatal error');
    // The route's own refusal: not a JSON object.
    expect(r.status(), `${body}: ${text.slice(0, 200)}`).toBe(400);
    expect(text).toContain('not a JSON object');
  }
});
