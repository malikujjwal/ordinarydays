import type { AgendaQuery } from '../../schemas/agenda.js';
import { activityAgendaData, agendaData } from '../../schemas/agenda.js';
import { envelope } from '../../schemas/envelope.js';
import type { ActivityAgendaData, AgendaData } from '../../types/agenda.js';
import type { HttpClient } from '../http.js';

export const agendaResponse = envelope(agendaData);
export const activityAgendaResponse = envelope(activityAgendaData);

/** Fetches one complete agenda window; P2-18 adds conditional transport caching. */
export function getAgenda(
  client: HttpClient,
  query: AgendaQuery,
  signal?: AbortSignal,
  bypassCache = false,
) {
  return client
    .request({
      method: 'GET',
      path: `/v1/agenda?${agendaSearchParams(query)}`,
      schema: agendaResponse,
      ...(bypassCache ? { headers: { 'Cache-Control': 'no-cache' } } : {}),
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as AgendaData);
}

/**
 * Bypasses agenda discovery and reads one activity's canonical partition strongly.
 * This is the reconciliation path after a recurrence PATCH, not the ordinary list refresh.
 */
export function getActivityAgenda(
  client: HttpClient,
  activityId: string,
  query: AgendaQuery,
  signal?: AbortSignal,
) {
  return client
    .request({
      method: 'GET',
      path: `/v1/agenda/activities/${encodeURIComponent(activityId)}?${agendaSearchParams(query)}`,
      schema: activityAgendaResponse,
      headers: { 'Cache-Control': 'no-cache' },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as ActivityAgendaData);
}

function agendaSearchParams(query: AgendaQuery): string {
  const params = new URLSearchParams({ from: query.from, to: query.to, tz: query.tz });
  if (query.include !== undefined) params.set('include', query.include);
  return params.toString();
}
