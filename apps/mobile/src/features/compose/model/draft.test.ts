import { describe, expect, it, vi } from 'vitest';
import {
  centsToDraft,
  draftCents,
  draftInteger,
  EMPTY_DETAILS,
  fromActivityDetails,
  newIngredient,
  toActivityDetails,
} from './draft';

/**
 * `expo-crypto` is a native module with no jsdom implementation, and P3-17 puts a real `ing_`
 * ULID behind every new ingredient row ({@link newIngredient}). Deterministic bytes keep the
 * minted ids stable so a test can assert identity rather than merely non-emptiness.
 */
vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) =>
    Uint8Array.from({ length: count }, (_, index) => index),
  randomUUID: () => 'idem-test-key',
}));

/**
 * The draft ↔ `ActivityDetails` conversions (P1-25).
 *
 * The draft holds strings because that is what a field being typed into is; this is the one
 * boundary where they become the model's own types, so it is the one place a `'12.'` or a
 * `'2 people'` can turn into something the schema would reject.
 */
describe('draftInteger', () => {
  it.each([
    ['4', 4],
    ['04', 4],
    ['0', 0],
  ])('%s → %s', (value, expected) => {
    expect(draftInteger(value)).toBe(expected);
  });

  it.each(['', '   ', 'two', '1.5', '-3', '4a'])('%s is not a number yet', (value) => {
    expect(draftInteger(value)).toBeUndefined();
  });
});

/**
 * **Integer minor units, never a float** (`coding-standards.md` §3, §11 smell 5). The whole
 * and fractional parts are parsed separately and combined with integer arithmetic, so no
 * value in this path is ever the result of a division.
 */
describe('draftCents', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['0.07', 7],
    ['0', 0],
    ['$18.00', 1800],
  ])('%s → %s cents', (value, expected) => {
    expect(draftCents(value)).toBe(expected);
  });

  /** Three decimals is not a price. Rounding it would drop a digit the user typed. */
  it.each(['', '12.567', '1,200', 'free', '-5'])('%s is not a price', (value) => {
    expect(draftCents(value)).toBeUndefined();
  });

  it('round-trips through the field without arithmetic', () => {
    expect(centsToDraft(1250)).toBe('12.50');
    expect(centsToDraft(7)).toBe('0.07');
    expect(centsToDraft(0)).toBe('0.00');
    expect(draftCents(centsToDraft(1234))).toBe(1234);
  });
});

describe('toActivityDetails', () => {
  it('gives a Task and a General details with nothing in them', () => {
    expect(toActivityDetails('task', EMPTY_DETAILS, 'x')).toEqual({ kind: 'task' });
    expect(toActivityDetails('custom', EMPTY_DETAILS, 'x')).toEqual({ kind: 'custom' });
  });

  /** §4.3: Watch mirrors the title into its required media title. */
  it('mirrors the title into mediaTitle', () => {
    expect(toActivityDetails('watch', EMPTY_DETAILS, 'Severance')).toEqual({
      kind: 'watch',
      mediaTitle: 'Severance',
    });
  });

  it('drops ingredient rows with no name, and trims the rest', () => {
    const details = {
      ...EMPTY_DETAILS,
      ingredients: [
        { id: 'a', name: '  Chicken ', quantity: ' 1 kg ', selected: true },
        { id: 'b', name: '   ', quantity: '2', selected: false },
        { id: 'c', name: 'Salt', quantity: '', selected: false },
      ],
    };

    expect(toActivityDetails('meal', details, 'Tacos')).toEqual({
      kind: 'meal',
      ingredients: [
        { ingredientId: 'a', name: 'Chicken', quantity: '1 kg' },
        { ingredientId: 'c', name: 'Salt' },
      ],
    });
  });

  /**
   * The row's draft id **is** its `ing_` identity (P3-17), so a round trip through the
   * server shape must return the same ids — a re-mint on open would make every stored id
   * stale the moment a meal was edited, and an offline add-to-list would then resolve to
   * nothing.
   */
  it('carries stored ingredient ids back into the draft rather than re-minting', () => {
    const stored = {
      kind: 'meal',
      ingredients: [
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2', name: 'Chicken' },
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X3', name: 'Salt' },
      ],
    } as const;

    const draft = fromActivityDetails(stored);

    expect(draft.ingredients.map((row) => row.id)).toEqual([
      'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      'ing_01J8XKQ2M4N5P6R7S8T9V0W1X3',
    ]);
    expect(toActivityDetails('meal', draft, 'Tacos')).toEqual(stored);
  });

  it('mints a real ing_ id for a genuinely new row', () => {
    expect(newIngredient().id).toMatch(/^ing_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('sends numeric Watch fields as numbers, and omits the ones still empty', () => {
    const details = { ...EMPTY_DETAILS, season: '2', episode: '', service: 'Apple TV' };

    expect(toActivityDetails('watch', details, 'Severance')).toEqual({
      kind: 'watch',
      mediaTitle: 'Severance',
      season: 2,
      service: 'Apple TV',
    });
  });

  it('sends a price as integer cents with the profile currency', () => {
    const details = {
      ...EMPTY_DETAILS,
      price: '18.50',
      currency: 'usd',
      organiser: 'Dr Patel',
    };

    expect(toActivityDetails('event', details, 'Gig')).toEqual({
      kind: 'event',
      priceCents: 1850,
      currency: 'USD',
      organiser: 'Dr Patel',
    });
  });

  it('omits an untouched reservation rather than sending an empty one', () => {
    expect(toActivityDetails('event', EMPTY_DETAILS, 'Zahav')).not.toHaveProperty(
      'reservation',
    );
  });

  it('sends the reservation fields that were filled', () => {
    const details = {
      ...EMPTY_DETAILS,
      reservation: { name: 'Ujjwal', time: '19:30', partySize: '4', reference: '' },
    };

    expect(toActivityDetails('event', details, 'Zahav')).toEqual({
      kind: 'event',
      reservation: { name: 'Ujjwal', time: '19:30', partySize: 4 },
    });
  });

  /**
   * The union is the filter. A Watch draft that carried an organiser cannot leak it into an
   * Meal's body, because the Meal arm never reads those keys.
   */
  it('reads only the keys the chosen type has', () => {
    const messy = { ...EMPTY_DETAILS, organiser: 'Dr Patel', service: 'Netflix' };

    expect(toActivityDetails('meal', messy, 'Zahav')).toEqual({ kind: 'meal' });
  });
});

describe('fromActivityDetails', () => {
  it('brings a mapped Watch back onto the draft as strings', () => {
    expect(
      fromActivityDetails({
        kind: 'watch',
        mediaTitle: 'Severance',
        season: 2,
        episode: 4,
        service: 'Apple TV',
      }),
    ).toMatchObject({ season: '2', episode: '4', service: 'Apple TV' });
  });

  /** Whatever the mapping did not keep comes back empty — which is what makes it visible. */
  it('empties everything the mapping dropped', () => {
    const back = fromActivityDetails({ kind: 'custom' });

    expect(back.season).toBe('');
    expect(back.service).toBe('');
    expect(back.organiser).toBe('');
    expect(back.ingredients).toEqual([]);
  });

  it('brings a price back as the digits the field shows', () => {
    expect(
      fromActivityDetails({ kind: 'event', priceCents: 1850, currency: 'USD' }),
    ).toMatchObject({ price: '18.50', currency: 'USD' });
  });
});
