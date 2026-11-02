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

test('the RTC choices include the PCF85363, as piRTC 5', async ({ request }) => {
  // Feature: 98d0d78ac (its options half; scenarios/test_fpprtc_pcf8563.py
  // checks that fpprtc sets piRTC 5 up as a pcf85363 at 0x51).
  const r = await request.get('/api/options/RTC');
  expect(r.ok()).toBe(true);
  const options = await r.json();
  expect(options['pcf85363 (Kulp)']).toBe('5');
  expect(Object.values(options).filter((v) => v === '5')).toHaveLength(1);
});
