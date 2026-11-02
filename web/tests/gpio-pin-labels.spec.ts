import { test, expect } from './fixtures';
import { container } from './container';

// The GPIO Inputs page's pin choices name the gpiochip and line a Raspberry Pi
// header pin drives.

test.skip(!container, 'drives the GPIO page of the run-web.sh player');

test('a Pi header pin is offered with the gpiochip and line it drives', async ({ page }) => {
  // Feature: daccbaeea.  The pin choice read "P1-11"; the GPIO it maps to was
  // only shown after the trigger was saved.  It reads "P1-11 (0/17)" while
  // choosing; pins that are not on the Pi header stay bare.
  await page.goto('/gpio.php');
  await page.waitForFunction(() => typeof (window as any).openAddModal === 'function');
  await page.evaluate(() => {
    const w = window as any;
    // This player is no Pi: give the page the Pi header's pin data.
    w.fppShowPinGpioNumbers = true;
    w.gpioPinData.push({ pin: 'P1-11', gpioChip: 0, gpioLine: 17 }, { pin: 'P1-13', gpioChip: 0, gpioLine: 27 });
    w.availablePins = ['P1-11', 'P1-13', w.availablePins[0]];
    w.openAddModal();
  });
  const options = page.locator('#gpioModalPin option');
  await expect(options.first()).toHaveText('P1-11 (0/17)');
  const texts = await options.allInnerTexts();
  expect(texts[1]).toBe('P1-13 (0/27)');
  // The control: a pin that is not on the header is listed by its name alone.
  expect(texts[2]).toMatch(/^[A-Z]+-\d+$/);
  // The value saved is the pin's name, not the label.
  await expect(options.first()).toHaveAttribute('value', 'P1-11');
});
