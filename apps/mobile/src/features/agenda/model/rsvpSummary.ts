/**
 * The needs-a-date RSVP summary line (P3-36, `plans-and-lists.md` §1.3.1).
 *
 * Pure — a total function of the response's grouped `rsvpSummary`, with no React and no
 * store, so `CLAUDE.md`'s "always rendered, never empty" second line can be asserted without
 * rendering anything.
 *
 * The words are the **undated** vocabulary — `interested`, `maybe`, `passed`,
 * `hasn't replied` — because the plan has no date; the stored RSVP values are unchanged and
 * the full mapping is `sharing-and-people.md` §3.5's (owned by P6-40). In this phase every
 * group arrives `{ count: 0, names: [] }`, so every row renders `Just you`; the other cases
 * ship now so the client is written once.
 */

export interface RsvpGroup {
  readonly count: number;
  readonly names: readonly string[];
}

export interface RsvpSummaryGroups {
  readonly interested: RsvpGroup;
  readonly maybe: RsvpGroup;
  readonly pass: RsvpGroup;
  readonly pending: RsvpGroup;
}

/** `Alice interested`, `Alice and Ben maybe`, `Alice and 2 others interested`. */
function phrase(group: RsvpGroup, verb: string, pluralVerb = verb): string | undefined {
  if (group.count === 0) return undefined;
  const [first, second] = group.names;
  if (group.count === 1 && first !== undefined) return `${first} ${verb}`;
  if (group.count === 2 && first !== undefined && second !== undefined) {
    return `${first} and ${second} ${pluralVerb}`;
  }
  if (first !== undefined) {
    return `${first} and ${group.count - 1} ${group.count === 2 ? 'other' : 'others'} ${pluralVerb}`;
  }
  // A counts-only group has no names to speak; the count still renders honestly.
  return `${group.count} ${pluralVerb}`;
}

export function rsvpSummaryLine(summary: RsvpSummaryGroups): string {
  const total =
    summary.interested.count +
    summary.maybe.count +
    summary.pass.count +
    summary.pending.count;
  if (total === 0) return 'Just you';

  const responded =
    summary.interested.count + summary.maybe.count + summary.pass.count > 0;
  // The one case that collapses to a single phrase (§1.3.1).
  if (!responded) return 'Nobody has replied';

  const parts = [
    phrase(summary.interested, 'interested'),
    phrase(summary.maybe, 'maybe'),
    phrase(summary.pass, 'passed'),
    pendingPhrase(summary.pending),
  ].filter((part): part is string => part !== undefined);

  return parts.join(' · ');
}

/**
 * §1.3.1 names the no-reply group differently: one person by name (`Ben hasn't replied`), any
 * more as the bare count (`2 haven't replied`) — its own examples, not the responded grammar.
 */
function pendingPhrase(group: RsvpGroup): string | undefined {
  if (group.count === 0) return undefined;
  const [first] = group.names;
  if (group.count === 1) {
    return first === undefined ? "1 hasn't replied" : `${first} hasn't replied`;
  }
  return `${group.count} haven't replied`;
}
