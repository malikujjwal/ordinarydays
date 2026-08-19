import { type AgendaQuery, agendaQuery } from '@od/shared/schemas';

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

export function agendaQueryKey(request: AgendaQuery): string {
  return `${request.from}\u0000${request.to}\u0000${request.tz}\u0000${request.include ?? ''}`;
}
