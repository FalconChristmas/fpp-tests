import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { cleanupPipeWire } from './pw-helpers';
import { CARDS, callApi, cleanupAsound, fakeCards, standInAplay } from './fake-asound';
import { nullSink, startPipeWire, stopPipeWire } from './pw-live';

// The sound card lists: the card aliases screen, the audio output choices
// and the PipeWire card list, from the cards in /proc/asound -- here a Pi's
// headphone jack, a USB sound card and a USB MIDI keyboard (fake-asound.ts,
// which runs the controller functions under PHP's CLI to give them those
// cards).

test.skip(!container, 'stands in sound cards inside the run-web.sh container');

const ALIASES = '/home/fpp/media/config/audio-card-aliases.json';

test.afterEach(() => {
  cleanupAsound();
  stopPipeWire();
  cleanupPipeWire();
  inPlayer('rm', '-f', ALIASES);
});

const ids = (r: any) => r.cards.filter((c: any) => c.cardNum >= 0).map((c: any) => c.cardId);

test('the card aliases screen lists the sound cards, not a MIDI keyboard', () => {
  // Regression: c04cb6e89. The list came from /proc/asound/cards, where a
  // USB MIDI device is a card too; it was offered an alias as if it played.
  fakeCards();
  standInAplay();
  expect(ids(callApi('GetAudioCardAliases'))).toEqual(['Headphones', 'S3']);
});

test('the cards are found on a system whose aplay speaks French', () => {
  // Regression: b108bb968. aplay -l is translated -- "carte 0: ..." under
  // fr_FR -- and the lists grepped it for "^card": on a French system the
  // aliases screen and the audio output choices had no cards at all.  (Since
  // 086fd576d they read /proc/asound and run no aplay.)
  fakeCards();
  standInAplay(CARDS, 'fr');
  expect(ids(callApi('GetAudioCardAliases'))).toEqual(['Headphones', 'S3']);
  expect(callApi('GetOptions_AudioOutputDevice', false)).toMatchObject({ 'bcm2835 Headphones': 'Headphones', 'Sound Blaster Play! 3': 'S3' });
});

test("a sound card's alias is saved, listed, and named in the audio output choices", async ({ request, page }) => {
  // Feature: 22d7ca5fd. A user's name for a card, keyed by its stable ALSA
  // card id, kept in config/audio-card-aliases.json and shown wherever a
  // card is picked: "<alias> (<card name>)".  An alias for a card that is not
  // plugged in stays listed so it can be cleaned up.
  const save = await request.post('/api/audio/cardaliases', { data: { aliases: { S3: 'Stage Left', Gone: 'Old Card', Blank: '' } } });
  expect(save.ok(), await save.text()).toBe(true);
  expect(await save.json()).toMatchObject({ status: 'ok', count: 2 });
  const got = await (await request.get('/api/audio/cardaliases')).json();
  expect(got.aliases).toEqual({ S3: 'Stage Left', Gone: 'Old Card' });

  fakeCards();
  standInAplay();
  const list = callApi('GetAudioCardAliases');
  expect(list.cards).toEqual(expect.arrayContaining([
    expect.objectContaining({ cardId: 'S3', cardName: 'Sound Blaster Play! 3', alias: 'Stage Left' }),
    expect.objectContaining({ cardId: 'Gone', cardNum: -1, cardName: '(not currently connected)', alias: 'Old Card' }),
  ]));
  // The label only: the value was the card number until it became the card id.
  expect(Object.keys(callApi('GetOptions_AudioOutputDevice', false))).toContain('Stage Left (Sound Blaster Play! 3)');

  await page.goto('/audio-card-aliases.php');
  await expect(page.locator('.alias-input[data-card-id="Gone"]')).toHaveValue('Old Card', { timeout: 15_000 });
});

test("a card FPP drives through its own ALSA adapter is matched to that adapter's sink", () => {
  // Feature: 9a92433ea. Once fppinit takes a card over, its sink is FPP's
  // fpp_alsa_<card> adapter (api.alsa.path "hw:<card id>"), not a WirePlumber
  // alsa_output node; the card list found no sink for it, so its output
  // volume and EQ had nothing to act on.
  fakeCards();
  standInAplay();
  startPipeWire({ objects: [nullSink('fpp_alsa_s3', { 'api.alsa.path': 'hw:S3' })] });
  const cards = callApi('GetPipeWireAudioCards');
  const s3 = cards.find((c: any) => c.cardId === 'S3');
  expect(s3, JSON.stringify(cards)).toBeTruthy();
  expect(s3.pwNodeName).toBe('fpp_alsa_s3');
  expect(cards.find((c: any) => c.cardId === 'Headphones').pwNodeName).toBe('');
});
