/**
 * A placeholder, and deliberately a trivial one. **P2-01 deletes this file.**
 *
 * `recurrence/**` is held at 100% statements and branches (`testing.md` §9,
 * `definition-of-done.md` §3). P0-24 arms that gate now, against this file, so that it is
 * live before the first real line is written — rather than being added after the engine
 * exists and quietly tuned down to whatever the engine happened to reach. The risk register
 * names that failure mode explicitly (R1: "the coverage threshold on `recurrence/**` is
 * lowered, even to 99%").
 *
 * Nothing imports this. It is not in the package's `exports` map, and `./recurrence` joins
 * that map in Phase 2 with the code that earns it (`tech-stack.md` §3.3).
 */

/** The frequencies the Repeat sheet will offer. Mode `after_completion` is Phase 9. */
export function isSupportedFrequency(value: string): boolean {
  return (
    value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly'
  );
}
