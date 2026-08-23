import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_LEXO_RANK_LENGTH } from '../constants.js';
import {
  compareListItems,
  FIRST_RANK,
  type LexoRank,
  LexoRankError,
  LexoRankOverflowError,
  lexoRankBetween,
} from './lexoRank.js';

/**
 * Ranks are compared with `<` / `>` — code-unit order, which is DynamoDB's byte order for
 * the base62 alphabet. Never `localeCompare`: that is the whole point of the module.
 */
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function isSortedStrictly(ranks: readonly string[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    if (!((ranks[i - 1] ?? '') < (ranks[i] ?? ''))) return false;
  }
  return true;
}

/** A list held in intended order; every insert goes through the generator with real neighbours. */
function insertAt(ranks: string[], index: number): LexoRank {
  const prev = index > 0 ? ranks[index - 1] : null;
  const next = index < ranks.length ? ranks[index] : null;
  const rank = lexoRankBetween(prev ?? null, next ?? null);
  ranks.splice(index, 0, rank);
  return rank;
}

describe('lexoRankBetween — the §9 algorithm', () => {
  it('FIRST_RANK is the stable midpoint of the alphabet', () => {
    expect(FIRST_RANK).toBe('V');
    expect(lexoRankBetween(null, null)).toBe(FIRST_RANK);
  });

  it('emits the midpoint at the first position more than one apart', () => {
    expect(lexoRankBetween('A', 'Z')).toBe('M');
    expect(lexoRankBetween('1', 'z')).toBe('V');
  });

  it('descends a place when the characters are adjacent or equal', () => {
    expect(lexoRankBetween('V', 'W')).toBe('VV');
    expect(lexoRankBetween('V', 'V1')).toBe('V0V');
    expect(lexoRankBetween('V', 'VV')).toBe('VF');
    expect(lexoRankBetween('VV', 'W')).toBe('Vk');
  });

  it('appends and prepends by stepping one place, not by bisecting the open side', () => {
    expect(lexoRankBetween('V', null)).toBe('W');
    expect(lexoRankBetween(null, 'V')).toBe('U');
    expect(lexoRankBetween('Vk', null)).toBe('Vl');
    expect(lexoRankBetween(null, 'Vk')).toBe('Vj');
  });

  it('rolls over at the edge of the alphabet without ever ending in 0', () => {
    expect(lexoRankBetween('z', null)).toBe('z1');
    expect(lexoRankBetween('Vz', null)).toBe('Vz1');
    expect(lexoRankBetween(null, '1')).toBe('0z');
    expect(lexoRankBetween(null, 'V1')).toBe('V0z');
    expect(lexoRankBetween(null, '2')).toBe('1');
  });

  it('treats an omitted or undefined bound exactly like null', () => {
    expect(lexoRankBetween()).toBe(FIRST_RANK);
    expect(lexoRankBetween(undefined, undefined)).toBe(FIRST_RANK);
    expect(lexoRankBetween('V')).toBe(lexoRankBetween('V', null));
    expect(lexoRankBetween('V', undefined)).toBe('W');
    expect(lexoRankBetween(undefined, 'V')).toBe(lexoRankBetween(null, 'V'));
    expect(lexoRankBetween(undefined, 'V')).toBe('U');
    // A JavaScript caller passing `undefined` explicitly reaches the same path — no raw
    // TypeError from the validator.
    expect(() => lexoRankBetween(undefined, 'V-')).toThrow(LexoRankError);
  });

  it('is deterministic: same inputs, same output, twice', () => {
    for (const [a, b] of [
      [null, null],
      ['V', null],
      [null, 'V'],
      ['V', 'VV'],
      ['ab', 'ac'],
    ] as const) {
      expect(lexoRankBetween(a, b)).toBe(lexoRankBetween(a, b));
    }
  });

  it('reads no clock and no randomness — the module is pure by inspection', () => {
    // Comments stripped first: the module's own doc comment names `localeCompare` as the
    // thing it must never use, and prose citing a rule is not a violation of it.
    const source = readFileSync(join(import.meta.dirname, 'lexoRank.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now/);
    expect(source).not.toMatch(/localeCompare|Intl\./);
    expect(source).toMatch(/charAt/); // sanity: the stripped source still contains the code
  });
});

describe('throws', () => {
  it('rejects prev >= next, including equal bounds, as a LexoRankError', () => {
    expect(() => lexoRankBetween('V', 'V')).toThrow(LexoRankError);
    expect(() => lexoRankBetween('W', 'V')).toThrow(LexoRankError);
    expect(() => lexoRankBetween('VV', 'V')).toThrow(LexoRankError);
    expect(() => lexoRankBetween('V', 'V')).toThrow(/prev must sort before next/);
  });

  it('rejects a character outside base62 in either bound', () => {
    expect(() => lexoRankBetween('V-', null)).toThrow(LexoRankError);
    expect(() => lexoRankBetween(null, 'é')).toThrow(LexoRankError);
    expect(() => lexoRankBetween('V ', 'W')).toThrow(/prev has an invalid character/);
    expect(() => lexoRankBetween('V', 'W_')).toThrow(/next has an invalid character/);
  });

  it('rejects an explicitly supplied empty string — null is the only spelling of "no neighbour"', () => {
    expect(() => lexoRankBetween('', null)).toThrow(LexoRankError);
    expect(() => lexoRankBetween(null, '')).toThrow(LexoRankError);
    expect(() => lexoRankBetween('', 'V')).toThrow(/prev is an empty string/);
    expect(() => lexoRankBetween('V', '')).toThrow(/next is an empty string/);
  });

  it('rejects a supplied rank ending in 0 — otherwise betweenness can be violated', () => {
    // 'V0' sorts between 'V' and 'V1'; if it were accepted as a bound, the walk pads a short
    // prev with '0' and lexoRankBetween('V', 'V0') would have no strictly-between answer.
    // The invariant is enforced on what comes in, not only on what goes out.
    expect(() => lexoRankBetween('V', 'V0')).toThrow(LexoRankError);
    expect(() => lexoRankBetween('V', 'V0')).toThrow(/next ends in '0'/);
    expect(() => lexoRankBetween('V0', 'W')).toThrow(/prev ends in '0'/);
    expect(() => lexoRankBetween('0', null)).toThrow(LexoRankError);
    expect(() => lexoRankBetween(null, 'V0')).toThrow(LexoRankError);
  });

  it('a pathological bounded gap overflows the cap as a distinct LexoRankOverflowError', () => {
    // Insert repeatedly just after a fixed `prev`, with the previous result as `next`. Each
    // step halves the bounded gap until the string hits the cap. This is the one pattern
    // that can invoke repair inside the 500-item list limit; it is exceptional, not
    // mathematically unreachable, and the typed error is how the repository knows.
    let next: string = lexoRankBetween('V', 'W');
    let thrown: unknown;
    for (let i = 0; i < 10_000; i++) {
      try {
        next = lexoRankBetween('V', next);
        expect(next.length).toBeLessThanOrEqual(MAX_LEXO_RANK_LENGTH);
      } catch (error) {
        thrown = error;
        break;
      }
    }
    expect(thrown).toBeInstanceOf(LexoRankOverflowError);
    expect(thrown).not.toBeInstanceOf(LexoRankError);
    expect((thrown as Error).message).toMatch(/fits in 64 characters/);
    // The last successful rank is exactly at the cap, so overflow is "longer than", not "at".
    expect(next.length).toBe(MAX_LEXO_RANK_LENGTH);
  });

  it('open-end stepping also overflows as LexoRankOverflowError once the string is at the cap', () => {
    // Reachable only after ~3,874 consecutive appends — far beyond the 500-item list cap —
    // but the guard exists and needs a test that reaches it (definition-of-done §4).
    const atCap = 'z'.repeat(MAX_LEXO_RANK_LENGTH);
    expect(() => lexoRankBetween(atCap, null)).toThrow(LexoRankOverflowError);
    const atCapLow = `${'0'.repeat(MAX_LEXO_RANK_LENGTH - 1)}1`;
    expect(() => lexoRankBetween(null, atCapLow)).toThrow(LexoRankOverflowError);
    // One short of the cap still answers, at exactly the cap.
    expect(lexoRankBetween('z'.repeat(MAX_LEXO_RANK_LENGTH - 1), null)).toHaveLength(
      MAX_LEXO_RANK_LENGTH,
    );
  });

  /**
   * Overflow is reserved for "no rank of at most 64 characters exists", not for "the first
   * strategy ran out of room". Each case here has a 64-character bound with prefix space
   * still available, and a short valid answer the greedy walk alone would never find.
   */
  describe('finds a short rank when a 64-character bound still has prefix room', () => {
    const AZ = `A${'z'.repeat(MAX_LEXO_RANK_LENGTH - 1)}`; // 64 chars, only 'A' can go up
    const B0 = `B${'0'.repeat(MAX_LEXO_RANK_LENGTH - 2)}1`; // 64 chars, only 'B' can go down

    it('append carries into an earlier position: A + z×63 → B', () => {
      expect(lexoRankBetween(AZ, null)).toBe('B');
      expect(lexoRankBetween(`Vk${'z'.repeat(62)}`, null)).toBe('Vl');
    });

    it('prepend borrows from an earlier position: B + 0×62 + 1 → A', () => {
      expect(lexoRankBetween(null, B0)).toBe('A');
      // A '1' at the borrow position becomes '0z' rather than a terminal '0'.
      expect(lexoRankBetween(null, `V1${'0'.repeat(61)}1`)).toBe('V0z');
    });

    it('a bounded gap diverges upward when descending from prev cannot fit: A + z×63, B1 → B', () => {
      const out = lexoRankBetween(AZ, 'B1');
      expect(out).toBe('B');
      expect(AZ < out && out < 'B1').toBe(true);
    });

    it('a bounded gap diverges downward from next when that is the only room: A, A + 1×63 → A + 1×61 + 0z', () => {
      const next = `A${'1'.repeat(MAX_LEXO_RANK_LENGTH - 1)}`;
      const out = lexoRankBetween('A', next);
      expect('A' < out && out < next).toBe(true);
      expect(out.length).toBeLessThanOrEqual(MAX_LEXO_RANK_LENGTH);
      expect(out.endsWith('0')).toBe(false);
    });

    it('still overflows when genuinely nothing fits: A + z×63, B and z×64, null', () => {
      // Anything between A+z×63 and B must start with A+z×63 and be longer than the cap.
      expect(() => lexoRankBetween(AZ, 'B')).toThrow(LexoRankOverflowError);
      expect(() => lexoRankBetween('z'.repeat(MAX_LEXO_RANK_LENGTH), null)).toThrow(
        LexoRankOverflowError,
      );
      expect(() =>
        lexoRankBetween(null, `${'0'.repeat(MAX_LEXO_RANK_LENGTH - 1)}1`),
      ).toThrow(LexoRankOverflowError);
    });

    it('property: a 64-character prev never overflows an append while any character can still go up', () => {
      const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      const capped = fc
        .tuple(
          fc.integer({ min: 0, max: MAX_LEXO_RANK_LENGTH - 2 }),
          fc.constantFrom(...alphabet.slice(0, -1)),
        )
        .map(
          ([k, c]) => `${'z'.repeat(k)}${c}${'z'.repeat(MAX_LEXO_RANK_LENGTH - k - 1)}`,
        );
      fc.assert(
        fc.property(capped, (prev) => {
          const out = lexoRankBetween(prev, null);
          return prev < out && out.length <= MAX_LEXO_RANK_LENGTH && !out.endsWith('0');
        }),
        { numRuns: 1_000 },
      );
    });

    it('property: a 64-character next never overflows a prepend while any character can still go down', () => {
      const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      const capped = fc
        .tuple(
          fc.integer({ min: 0, max: MAX_LEXO_RANK_LENGTH - 2 }),
          fc.constantFrom(...alphabet.slice(1)),
        )
        .map(
          ([k, c]) => `${'0'.repeat(k)}${c}${'0'.repeat(MAX_LEXO_RANK_LENGTH - k - 2)}1`,
        );
      fc.assert(
        fc.property(capped, (next) => {
          const out = lexoRankBetween(null, next);
          return out < next && out.length <= MAX_LEXO_RANK_LENGTH && !out.endsWith('0');
        }),
        { numRuns: 1_000 },
      );
    });

    it('property: a bounded gap whose only room is above a 64-character prev is found, never overflowed', () => {
      // prev is at the cap with exactly one character that can go up; next sits one step
      // above that carry with a character to spare, so the carried rank is a valid answer
      // and the greedy descend cannot fit.
      const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      const cases = fc
        .tuple(
          fc.integer({ min: 0, max: MAX_LEXO_RANK_LENGTH - 2 }),
          fc.constantFrom(...alphabet.slice(0, -1)),
        )
        .map(([k, c]) => {
          const prev = `${'z'.repeat(k)}${c}${'z'.repeat(MAX_LEXO_RANK_LENGTH - k - 1)}`;
          const carried = `${'z'.repeat(k)}${alphabet.charAt(alphabet.indexOf(c) + 1)}`;
          return { prev, next: `${carried}1` };
        });
      fc.assert(
        fc.property(cases, ({ prev, next }) => {
          const out = lexoRankBetween(prev, next);
          return prev < out && out < next && out.length <= MAX_LEXO_RANK_LENGTH;
        }),
        { numRuns: 1_000 },
      );
    });
  });

  it('a directly constructed 64-character bound still produces a 64-character answer when the gap allows', () => {
    const prev = `${'V'.repeat(63)}1`;
    const next = `${'V'.repeat(63)}z`;
    const out = lexoRankBetween(prev, next);
    expect(out.length).toBe(MAX_LEXO_RANK_LENGTH);
    expect(prev < out && out < next).toBe(true);
  });
});

describe('the §9 properties table', () => {
  const rankArb = fc
    .stringOf(
      fc.constantFrom(
        ...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
      ),
      {
        minLength: 1,
        maxLength: 8,
      },
    )
    .filter((s) => !s.endsWith('0'));

  it('betweenness: prev < result < next for every valid pair', () => {
    fc.assert(
      fc.property(rankArb, rankArb, (x, y) => {
        fc.pre(x !== y);
        const [prev, next] = x < y ? [x, y] : [y, x];
        const out = lexoRankBetween(prev, next);
        return prev < out && out < next && !out.endsWith('0');
      }),
      { numRuns: 2_000 },
    );
  });

  it('betweenness with one or both bounds missing', () => {
    fc.assert(
      fc.property(rankArb, (x) => {
        const after = lexoRankBetween(x, null);
        const before = lexoRankBetween(null, x);
        return before < x && x < after;
      }),
      { numRuns: 1_000 },
    );
  });

  it('idempotent ordering: inserting between the same pair repeatedly always lands strictly between', () => {
    const prev = 'V';
    let next: string = 'W';
    for (let i = 0; i < 200; i++) {
      const out = lexoRankBetween(prev, next);
      expect(prev < out && out < next).toBe(true);
      next = out;
    }
  });

  /**
   * Two separate growth guarantees (`coding-standards.md` §9):
   *
   * - **Open ends step by one**, so a character buys ~61 inserts. Sequential head or tail
   *   creation must never reach repair inside the 500-item list cap — 500 appends is 9
   *   characters, and the cap is not hit until 3,874.
   * - **A bounded gap bisects**, so a character buys ~6 inserts. The specified 200 same-gap
   *   inserts hold with room to spare; pathological repeated insertion into *one* gap
   *   overflows at ~315 and is the exceptional repair case.
   */
  it('bounded growth, open ends: 500 sequential appends and 500 prepends stay far under the cap', () => {
    let tail: string | null = null;
    let head: string | null = null;
    for (let i = 0; i < 500; i++) {
      const nextTail = lexoRankBetween(tail, null);
      const nextHead = lexoRankBetween(null, head);
      if (tail !== null) expect(tail < nextTail).toBe(true);
      if (head !== null) expect(nextHead < head).toBe(true);
      tail = nextTail;
      head = nextHead;
      expect(tail.length).toBeLessThan(MAX_LEXO_RANK_LENGTH);
      expect(head.length).toBeLessThan(MAX_LEXO_RANK_LENGTH);
    }
    expect(tail?.length).toBe(9);
    expect(head?.length).toBe(9);
  });

  it('pins the measured open-end capacity: append and prepend overflow only after 3,874 inserts', () => {
    const countUntilOverflow = (step: (r: string) => [string | null, string | null]) => {
      let [prev, next]: [string | null, string | null] = [null, null];
      for (let n = 0; ; n++) {
        try {
          [prev, next] = step(lexoRankBetween(prev, next));
        } catch (error) {
          expect(error).toBeInstanceOf(LexoRankOverflowError);
          return n;
        }
      }
    };
    expect(countUntilOverflow((r) => [r, null])).toBe(3_874);
    expect(countUntilOverflow((r) => [null, r])).toBe(3_874);
  });

  it('bounded growth, one gap: 200 sequential inserts into the same bounded gap stay under the cap', () => {
    let inGap: string = lexoRankBetween('V', 'W');
    for (let i = 0; i < 200; i++) {
      const out = lexoRankBetween('V', inGap);
      expect('V' < out && out < inGap).toBe(true);
      inGap = out;
      expect(inGap.length).toBeLessThan(MAX_LEXO_RANK_LENGTH);
    }
    expect(inGap.length).toBe(42);
  });

  it('ends: head, tail and 200 inserts into one gap, order held and length under the cap', () => {
    const ranks: string[] = [];
    insertAt(ranks, 0); // head of an empty list
    insertAt(ranks, ranks.length); // tail
    insertAt(ranks, 0); // new head
    expect(isSortedStrictly(ranks)).toBe(true);

    // Keep inserting into the same gap — between index 0 and 1 — 200 times.
    for (let i = 0; i < 200; i++) {
      const rank = insertAt(ranks, 1);
      expect(rank.length).toBeLessThan(MAX_LEXO_RANK_LENGTH);
    }
    expect(ranks).toHaveLength(203);
    expect(isSortedStrictly(ranks)).toBe(true);
  });

  it('order-preserving: a shuffled insert sequence, sorted by rank, matches the intended order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 500 }), { minLength: 1, maxLength: 300 }),
        (positions) => {
          // Build the intended order by inserting labels at the given positions, allocating
          // a rank for each with its real neighbours at that moment.
          const items: { label: number; rank: string }[] = [];
          positions.forEach((p, label) => {
            const index = Math.min(p, items.length);
            const prev = index > 0 ? (items[index - 1]?.rank ?? null) : null;
            const next = index < items.length ? (items[index]?.rank ?? null) : null;
            items.splice(index, 0, { label, rank: lexoRankBetween(prev, next) });
          });
          const intended = items.map((i) => i.label);
          const shuffled = [...items].sort(() => 0); // identity — then a real sort by rank
          const sorted = [...shuffled]
            .sort((x, y) => byteOrder(x.rank, y.rank))
            .map((i) => i.label);
          return sorted.join(',') === intended.join(',');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property: 10,000 random insertions at random positions', () => {
  it('leave the list in the intended order at every step', () => {
    // One long deterministic run rather than many short ones: the interesting failures are
    // accumulated-gap failures, which need depth. fast-check supplies the positions; the
    // seed is fixed so a failure reproduces.
    const positions = fc.sample(fc.nat({ max: 100_000 }), {
      numRuns: 10_000,
      seed: 20260823,
    });
    const ranks: string[] = [];
    for (const p of positions) {
      const index = p % (ranks.length + 1);
      const rank = insertAt(ranks, index);
      expect(rank.length).toBeLessThanOrEqual(MAX_LEXO_RANK_LENGTH);
      // Check the neighbourhood every step and the whole list periodically — a full scan on
      // every step is O(n²) for no extra assurance.
      if (index > 0) expect((ranks[index - 1] ?? '') < rank).toBe(true);
      if (index < ranks.length - 1) expect(rank < (ranks[index + 1] ?? '')).toBe(true);
      if (ranks.length % 500 === 0) expect(isSortedStrictly(ranks)).toBe(true);
    }
    expect(ranks).toHaveLength(10_000);
    expect(isSortedStrictly(ranks)).toBe(true);
    expect(new Set(ranks).size).toBe(10_000);
  });
});

describe('compareListItems — the (rank, itemId) total order', () => {
  const A = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2';
  const B = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';

  it('orders by rank first', () => {
    expect(compareListItems({ rank: 'V', itemId: B }, { rank: 'W', itemId: A })).toBe(-1);
    expect(compareListItems({ rank: 'W', itemId: A }, { rank: 'V', itemId: B })).toBe(1);
  });

  it('two items with an identical rank and different ids order the same for both input orderings', () => {
    const x = { rank: 'V', itemId: A };
    const y = { rank: 'V', itemId: B };
    expect(compareListItems(x, y)).toBe(-1);
    expect(compareListItems(y, x)).toBe(1);
    expect([x, y].sort(compareListItems)).toEqual([x, y]);
    expect([y, x].sort(compareListItems)).toEqual([x, y]);
  });

  it('returns 0 only for the same (rank, itemId)', () => {
    expect(compareListItems({ rank: 'V', itemId: A }, { rank: 'V', itemId: A })).toBe(0);
  });

  it('uses code-unit order, never locale order — uppercase before lowercase, digits first', () => {
    // `localeCompare` would put 'a' before 'B'; byte order puts 'B' first, as DynamoDB does.
    expect(compareListItems({ rank: 'B', itemId: A }, { rank: 'a', itemId: A })).toBe(-1);
    expect(compareListItems({ rank: '9', itemId: A }, { rank: 'A', itemId: A })).toBe(-1);
    expect(
      compareListItems({ rank: 'V', itemId: 'itm_a' }, { rank: 'V', itemId: 'itm_B' }),
    ).toBe(1);
  });

  it('1,000 randomly shuffled arrays with three groups of equal-ranked items sort to one identical array', () => {
    const groups = ['F', 'V', 'k'];
    const items = groups.flatMap((rank) =>
      Array.from({ length: 4 }, (_, i) => ({
        rank,
        itemId: `itm_${rank}${i}`,
        payload: `${rank}-${i}`,
      })),
    );
    const expected = [...items].sort(compareListItems);
    fc.assert(
      fc.property(fc.shuffledSubarray(items, { minLength: items.length }), (shuffled) => {
        const sorted = [...shuffled].sort(compareListItems);
        return JSON.stringify(sorted) === JSON.stringify(expected);
      }),
      { numRuns: 1_000 },
    );
    // And the groups are contiguous and internally ordered by id, not by arrival.
    expect(expected.map((i) => i.rank).join('')).toBe('FFFFVVVVkkkk');
  });

  it('is a strict total order: antisymmetric and transitive over random triples', () => {
    const itemArb = fc.record({
      rank: fc.constantFrom('F', 'V', 'VV', 'k'),
      itemId: fc.constantFrom(A, B, 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X1'),
    });
    fc.assert(
      fc.property(itemArb, itemArb, itemArb, (x, y, z) => {
        const xy = compareListItems(x, y);
        const yx = compareListItems(y, x);
        if (xy !== -yx) return false;
        const yz = compareListItems(y, z);
        const xz = compareListItems(x, z);
        if (xy <= 0 && yz <= 0 && xz > 0) return false;
        return true;
      }),
      { numRuns: 2_000 },
    );
  });
});
