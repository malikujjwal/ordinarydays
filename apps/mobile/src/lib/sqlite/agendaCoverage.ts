import { type AgendaQuery, agendaQuery } from '@od/shared/schemas';

const NATIVE_VISIBLE_INCLUDE_ORDER = [
  'anytime_unscheduled',
  'overdue',
  'reminders',
] as const;

export interface AgendaCoverage {
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly include?: string;
}

/** Validates stored coverage before it crosses back into the typed API boundary. */
export function agendaQueryForCoverage(coverage: AgendaCoverage): AgendaQuery {
  return agendaQuery.parse({
    from: coverage.from,
    to: coverage.to,
    tz: coverage.timezone,
    ...(coverage.include === undefined ? {} : { include: coverage.include }),
  });
}

export function agendaCoverageForQuery(request: AgendaQuery): AgendaCoverage {
  return {
    from: request.from,
    to: request.to,
    timezone: request.tz,
    ...(request.include === undefined ? {} : { include: request.include }),
  };
}

/**
 * Native SQLite stores one materialized Agenda projection, so every native pull must describe
 * the same visible-state superset. A narrower Plans or reminder response must never erase
 * Anytime/overdue rows that a Today response would return.
 */
export function nativeVisibleAgendaQuery(request: AgendaQuery): AgendaQuery {
  const requested = new Set(request.include?.split(',') ?? []);
  requested.add('anytime_unscheduled');
  requested.add('overdue');
  return agendaQuery.parse({
    ...request,
    include: NATIVE_VISIBLE_INCLUDE_ORDER.filter((token) => requested.has(token)).join(
      ',',
    ),
  });
}

/**
 * Rolling coverage receipts are durable evidence, not an unbounded refresh/reconciliation
 * queue. Normalize receipts from older native builds, then keep the latest window in each
 * timezone/include domain.
 */
export function latestNativeAgendaCoverage(
  coverages: readonly AgendaCoverage[],
): readonly AgendaCoverage[] {
  const latest = new Map<string, AgendaCoverage>();
  for (const stored of coverages) {
    const coverage = agendaCoverageForQuery(
      nativeVisibleAgendaQuery(agendaQueryForCoverage(stored)),
    );
    const key = `${coverage.timezone}\u0000${coverage.include ?? ''}`;
    const current = latest.get(key);
    if (
      current === undefined ||
      coverage.from > current.from ||
      (coverage.from === current.from && coverage.to > current.to)
    ) {
      latest.set(key, coverage);
    }
  }
  return [...latest.values()];
}

export function agendaQueryKey(request: AgendaQuery): string {
  return `${request.from}\u0000${request.to}\u0000${request.tz}\u0000${request.include ?? ''}`;
}
