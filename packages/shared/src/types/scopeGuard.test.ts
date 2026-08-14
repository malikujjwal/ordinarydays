import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The ratchet behind ADR-053.
 *
 * `ActivityScope` only protects the call sites that use it. Nothing stops a future task from
 * typing `occurrenceDate:` into a request body again, and the failure mode is silent: an
 * optional key whose omitted case retires a whole series. Twelve of the fifteen recurrence
 * defects of 2026-08-13 were exactly that, and the suite was green through all of them —
 * so the guard has to be structural, in the spirit of P2-46's `mutationOptions` check.
 *
 * **It runs as `test:guards`, uncached, and must stay that way.** This file reads source from
 * every package at runtime, which turbo cannot see as an input: `@od/shared` does not depend
 * on `apps/mobile`, so a mobile-only edit left a cached pass in place and the guard reported
 * green while it was red. That is how `RepeatSheet` reintroduced the wire key unnoticed.
 *
 * **This is deliberately not "the wire key appears only in `scope.ts`".** That invariant is
 * unreachable and would be dishonest to assert: the Zod schemas *define* the wire and must
 * name it, `AgendaItem` declares it as a response field, the API keys the `Occurrence` entity
 * by date, and the agenda models read it as row identity rather than as a write scope. The two
 * things that are true and worth holding:
 *
 * 1. no **new** file may start naming the wire key, and
 * 2. the client **write layer** may not construct one by hand — scope reaches a request body
 *    through `scopeToWire` or not at all.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WIRE_KEY = 'occurrenceDate';

/**
 * Every non-test file allowed to name the wire key today, by reason.
 *
 * Shrinking this list is the point; ADR-053 names the two groups still to convert. Adding to
 * it is a decision, not a formality — say in the PR which of the reasons below the new file
 * falls under.
 */
const ALLOWED = new Set(
  [
    // Defines the wire. These are where `occurrenceDate` is supposed to be spelled.
    'packages/shared/src/schemas/activity.ts',
    'packages/shared/src/schemas/agenda.ts',
    'packages/shared/src/schemas/occurrence.ts',
    'packages/shared/src/schemas/schedule.ts',
    'packages/shared/src/openapi.ts',
    'packages/shared/src/types/activity.ts',
    'packages/shared/src/types/agenda.ts',
    'packages/shared/src/table/definition.ts',
    // Converts between the wire and `ActivityScope`. The boundary itself.
    'packages/shared/src/types/scope.ts',
    'packages/shared/src/client/endpoints/activities.ts',
    'apps/mobile/src/features/agenda/model/rowScope.ts',
    // Server: reads parsed input, and keys the Occurrence entity by its date.
    'services/api/src/handlers/getActivity.ts',
    'services/api/src/repositories/activityRepository.ts',
    'services/api/src/services/agendaProjection.ts',
    'services/api/src/services/agendaService.ts',
    'services/api/src/services/completionService.ts',
    'services/api/src/services/activityService.ts',
    'services/api/src/services/scheduleService.ts',
    // Client: row identity in cached agenda windows, not a write scope. ADR-053 converts these.
    'apps/mobile/src/features/agenda/model/applyCompletion.ts',
    'apps/mobile/src/features/agenda/model/applyCreate.ts',
    'apps/mobile/src/features/agenda/model/applyDelete.ts',
    'apps/mobile/src/features/agenda/model/applySkip.ts',
    'apps/mobile/src/features/agenda/model/partition.ts',
    'apps/mobile/src/features/agenda/model/plansWindow.ts',
    'apps/mobile/src/features/agenda/model/upNext.ts',
    'apps/mobile/src/features/agenda/components/AgendaSection.tsx',
    'apps/mobile/src/features/agenda/components/PlansScreen.tsx',
    'apps/mobile/src/features/reminders/localSchedule.ts',
    'apps/mobile/src/lib/agendaCache.ts',
    // Client write/props surface. ADR-053 converts these next.
    'apps/mobile/src/components/AgendaRescheduleCoordinator.tsx',
    'apps/mobile/src/features/activity/components/ActivityDetailScreen.tsx',
    'apps/mobile/src/features/activity/components/RescheduleSheet.tsx',
    'apps/mobile/src/features/activity/hooks/useActivityActions.ts',
    'apps/mobile/src/features/agenda/hooks/useAgendaActivityActions.ts',
  ].map((path) => path.split('/').join(sep)),
);

const SEARCH_ROOTS = ['apps/mobile/src', 'packages/shared/src', 'services/api/src'].map(
  (path) => path.split('/').join(sep),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const named = SEARCH_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
  .filter((file) => readFileSync(file, 'utf8').includes(WIRE_KEY))
  .map((file) => relative(ROOT, file));

describe('ADR-053 — the wire key does not spread', () => {
  it('is named only by files already accounted for', () => {
    expect(named.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  /** A stale entry means someone did the conversion work; take the credit and shrink it. */
  it('has no allowlist entry that no longer names it', () => {
    expect([...ALLOWED].filter((file) => !named.includes(file))).toEqual([]);
  });
});

/**
 * The sharper rule, on the layer where the defects actually landed.
 *
 * These hooks build mutation variables. A literal `occurrenceDate:` key here is a request body
 * assembled by hand, which is what produced an unscoped complete from the Today checkbox.
 * `scopeToWire` is the only way scope may reach a body.
 */
describe('ADR-053 — the client write layer never builds the key by hand', () => {
  const writeLayer = [
    'apps/mobile/src/features/agenda/hooks/useAgendaActivityActions.ts',
    'apps/mobile/src/features/activity/hooks/useActivityActions.ts',
  ];

  it.each(writeLayer)('%s reaches the wire through scopeToWire', (relativePath) => {
    const source = readFileSync(join(ROOT, relativePath.split('/').join(sep)), 'utf8');
    // Strip block comments: this file's own rationale names the key it forbids.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(code).toMatch(/scopeToWire/);
    expect(code).not.toMatch(/occurrenceDate\s*:/);
  });
});
