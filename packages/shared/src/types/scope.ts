/**
 * What a write targets: the Activity itself, or one occurrence of a recurring one.
 *
 * ## Why this type exists
 *
 * Scope used to travel as an optional `occurrenceDate?: string` — 184 references across 30
 * files, hand-threaded through every layer. The field carried **two** meanings that nothing
 * distinguished:
 *
 * - on a one-off, absent means "not applicable", which is correct;
 * - on a series, absent means "operate on the whole series", which retires every future
 *   occurrence.
 *
 * Telling them apart required knowing whether the activity recurs, which most call sites do
 * not have to hand — so every one was a coin flip whose losing side was the destructive one.
 * Twelve of the fifteen recurrence defects found on 2026-08-13 were that exact shape: the
 * Today checkbox, `applyCreate`, the detail screen's anchor fallback, the occurrence
 * reschedule, `complete` and `skip` on the API, and the rest.
 *
 * A discriminated union has no absent case. A caller states which it means or does not
 * compile, and `{ kind: 'activity' }` becomes a decision rather than an omission.
 *
 * ## What this deliberately does not change
 *
 * **The wire keeps `occurrenceDate?`.** It appears eleven times in `docs/generated/openapi.json`
 * across the five inputs, `AgendaItem` and `ActivityCompletionResult`; changing it is a
 * breaking API change for no benefit, since the ambiguity is a code problem rather than a
 * protocol one. `scopeToWire`/`scopeFromWire` convert at the boundary.
 *
 * **Persisted mutation variables keep their shape too.** `persister.ts` dehydrates paused
 * mutations on iOS with their variables, gated by one `CACHE_BUSTER`. A changed variable shape
 * would make a restored mutation replay a body it never meant, and the only alternative —
 * bumping the buster — discards every queued offline write.
 *
 * ## What it does not solve on its own
 *
 * `{ kind: 'activity' }` stays valid: every one-off uses it, and `uncomplete` accepts it even
 * on a series because that is the only route back for one this bug already completed. The rule
 * is therefore per-operation, and lives in `assertOccurrenceScoped` beside its callers rather
 * than in this type.
 */
export type ActivityScope =
  | { readonly kind: 'activity' }
  | { readonly kind: 'occurrence'; readonly date: string };

/** The Activity itself. Correct for every one-off, and a decision on a series. */
export const activityScope = (): ActivityScope => ({ kind: 'activity' });

/** One nominal occurrence of a recurring Activity, identified by the day it falls on. */
export const occurrenceScope = (date: string): ActivityScope => ({
  kind: 'occurrence',
  date,
});

/**
 * The scope a thing carrying an optional occurrence date means.
 *
 * The single place the old representation is interpreted, so the two meanings are separated
 * once rather than at each of the call sites that used to get it wrong.
 */
export function scopeFromWire(input: {
  readonly occurrenceDate?: string | undefined;
}): ActivityScope {
  return input.occurrenceDate === undefined
    ? activityScope()
    : occurrenceScope(input.occurrenceDate);
}

/** The wire form, spreadable into a request body under `exactOptionalPropertyTypes`. */
export function scopeToWire(scope: ActivityScope): { occurrenceDate?: string } {
  return scope.kind === 'occurrence' ? { occurrenceDate: scope.date } : {};
}

/** The occurrence date, or `undefined` for an activity-scoped write. */
export function scopeDate(scope: ActivityScope): string | undefined {
  return scope.kind === 'occurrence' ? scope.date : undefined;
}

/**
 * Whether this write would land on a series rather than on one of its days.
 *
 * The condition every guard in the codebase was missing, stated once. `recurs` is passed
 * rather than the Activity so an agenda row — which knows `isRecurring` but is not an
 * Activity — can ask the same question.
 */
export function targetsWholeSeries(recurs: boolean, scope: ActivityScope): boolean {
  return recurs && scope.kind === 'activity';
}
