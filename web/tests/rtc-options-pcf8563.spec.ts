import { test, expect } from './fixtures';

// The RTC choices the Time settings offer (api/options/RTC): the PCF8563 is
// one, stored as piRTC "6" -- the value fpprtc sets a pcf8563 up at 0x51
// for (scenarios/test_fpprtc_pcf8563.py checks that end).

test('the RTC choices include the PCF8563, as piRTC 6', async ({ request }) => {
  // Feature: c590b0be7 (its options half).
  const r = await request.get('/api/options/RTC');
  expect(r.ok()).toBe(true);
  const options = await r.json();
  expect(options['pcf8563']).toBe('6');
  expect(Object.values(options).filter((v) => v === '6')).toHaveLength(1);
});
