import type { AgendaQuery } from '../../schemas/agenda.js';
import { agendaData } from '../../schemas/agenda.js';
import { envelope } from '../../schemas/envelope.js';
import type { AgendaData } from '../../types/agenda.js';
import type { HttpClient } from '../http.js';

export const agendaResponse = envelope(agendaData);

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

function agendaSearchParams(query: AgendaQuery): string {
  const params = new URLSearchParams({ from: query.from, to: query.to, tz: query.tz });
  if (query.include !== undefined) params.set('include', query.include);
  return params.toString();
}
