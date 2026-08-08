/**
 * A placeholder, and deliberately a trivial one. **Phase 7 deletes this file.**
 *
 * `money/**` is held at 100% statements and branches (`testing.md` §9,
 * `definition-of-done.md` §3), and P0-24 arms that gate now against this file for the same
 * reason it arms `recurrence/**`: a threshold added after the code is a threshold fitted to
 * the code.
 *
 * The one real thing it asserts is the rule that outranks it — **money is integer cents**
 * (`CLAUDE.md`, `coding-standards.md` §3). No float, anywhere, ever.
 *
 * Nothing imports this, and `./money` joins the `exports` map in Phase 7 with the splitters
 * that earn it.
 */

/** Whether a value is usable as an amount in minor units: a safe, non-negative integer. */
export function isNonNegativeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
