import type { TimeZone } from '@od/shared/time';
import type { User } from '@od/shared/types';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The viewer timezone every product-owned window resolves against.
 *
 * Observe the already-cached profile without starting a request; before it loads, the device
 * zone is the documented fallback. Every caller uses this same resolver so their query keys
 * cannot drift from each other when an activity is scheduled in another timezone.
 *
 * ## Why it is in `lib/` rather than in `features/agenda/`
 *
 * Moved there in P3-25, when the Lists index became its second feature. `repo-structure.md`
 * §3.2 is the rule — "if two features need the same thing, it moves up" — and
 * `dependency-cruiser`'s `no-cross-feature-imports` enforces it rather than suggesting it.
 * `lib/agendaCache.ts` was already reaching for it from outside the slice, so the module was
 * shared in practice before it was shared in position.
 */
export function resolveViewerTimezone(client: QueryClient): TimeZone {
  return (client.getQueryData<User>(['me'])?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone;
}
