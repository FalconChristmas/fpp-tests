import { test, expect } from './fixtures';

// The cape licence signing packet is asked for with a key and an order
// number, both of which the UI takes from text boxes
// (GET /api/cape/eeprom/signingData/<key>/<order> and .../signingFile/...,
// www/api/controllers/cape.php GetSigningDataHelper).  They go on into the
// packet sent to the licence server, so what is not a key or an order number
// is refused before the EEPROM is read.  Also the regime code of
// /api/cape/defaults.

const BAD_KEY = 'Invalid Key.  Key must contain only letters, numbers, and hyphens.';
const BAD_ORDER = 'Invalid Order ID.  Order ID must contain only numbers.';

for (const route of ['signingData', 'signingFile']) {
  test(`${route}: a key with anything but letters, digits and hyphens is refused`, async ({ request }) => {
    for (const key of ['ABCD_1234', 'ABCD%201234', 'AB.CD', 'ABCD%3B1234', 'ABCD%271234', '%C3%A9ABCD']) {
      const r = await request.get(`/api/cape/eeprom/${route}/${key}/12345`);
      expect(r.headers()['content-disposition'] ?? '', key).toBe('');
      expect(await r.json(), key).toEqual({ Status: 'ERROR', Message: BAD_KEY });
    }
  });

  test(`${route}: an order that is not a whole number above zero is refused`, async ({ request }) => {
    for (const order of ['0', '0123', '12a', '-5', '1.5', '12%2034', '%2B12']) {
      const r = await request.get(`/api/cape/eeprom/${route}/abcd-1234/${order}`);
      expect(r.headers()['content-disposition'] ?? '', order).toBe('');
      expect(await r.json(), order).toEqual({ Status: 'ERROR', Message: BAD_ORDER });
    }
  });
}

test('the control: a key in lower case with a good order gets past both checks', async ({ request }) => {
  // Whatever comes next (the packet, or no EEPROM to read on this player), it
  // is not one of the two refusals.
  const r = await request.get('/api/cape/eeprom/signingData/abcd-1234/12345');
  const text = await r.text();
  expect(text).not.toContain(BAD_KEY);
  expect(text).not.toContain(BAD_ORDER);
});

test('cape/defaults refuses a regime that is not a code', async ({ request }) => {
  for (const regime of ['EU%20x', 'a%3Bb', '..%2F..', 'x'.repeat(33)]) {
    const r = await request.get(`/api/cape/defaults?regime=${regime}`);
    expect(r.status(), regime).toBe(400);
    expect(await r.json(), regime).toEqual({ Status: 'Error', Message: 'Invalid regime' });
  }
});
