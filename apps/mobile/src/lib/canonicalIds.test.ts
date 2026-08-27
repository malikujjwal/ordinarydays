import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The prefixed monotonic identity factory (ADR-055, §P3-05).
 *
 * `expo-crypto` is a native module with no jsdom implementation, so the CSPRNG is stubbed —
 * and stubbing it with a **constant** is what makes the monotonic rule observable: every id
 * minted in the same millisecond would otherwise be identical, so any ordering the test sees
 * comes from the increment rather than from luck.
 */
vi.mock('expo-crypto', () => ({
  getRandomBytes: () => new Uint8Array(10).fill(0),
}));

const { nextCanonicalId } = await import('./canonicalIds');

describe('client-minted canonical identities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints a prefixed 26-character ULID', () => {
    const id = nextCanonicalId('lst');

    expect(id).toMatch(/^lst_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts ids minted inside one millisecond in the order they were created', () => {
    const ids = [nextCanonicalId('act'), nextCanonicalId('act'), nextCanonicalId('act')];

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(3);
  });

  /**
   * The reason each prefix keeps its own witness. A shared one would make a list mint advance
   * the activity sequence's random component, which is a behaviour change to `act_` for no
   * benefit — and this is the assertion that would catch it.
   */
  it('keeps each prefix on its own sequence', () => {
    const first = nextCanonicalId('act');
    nextCanonicalId('lst');
    const second = nextCanonicalId('act');

    // One increment on from the first, not two: the list mint took nothing from this
    // sequence. Crockford's alphabet is spelled out here because the encoding is what is
    // under test — reading it from the module would assert the module against itself.
    const position = (id: string) =>
      '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(id.slice(-1));
    expect(position(second) - position(first)).toBe(1);
  });

  it('advances with the clock across milliseconds', () => {
    const earlier = nextCanonicalId('lst');
    vi.setSystemTime(new Date('2026-08-27T09:00:00.001Z'));
    const later = nextCanonicalId('lst');

    expect(later > earlier).toBe(true);
    expect(later.slice(4, 14)).not.toBe(earlier.slice(4, 14));
  });

  /**
   * A clock that moved backwards — a device time change, or an NTP correction — must not be
   * able to mint an id that sorts before one already handed out.
   */
  it('never regresses when the clock does', () => {
    vi.setSystemTime(new Date('2026-08-27T09:00:05.000Z'));
    const minted = nextCanonicalId('act');
    vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));

    expect(nextCanonicalId('act') > minted).toBe(true);
  });
});
