import { createHash } from 'node:crypto';
import type { AgendaQuery } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { getAgenda } from '../services/agendaQueryService.js';

export const GET_AGENDA_PATH = '/';
export const AGENDA_CACHE_CONTROL = 'private, max-age=60';

/** Serves the complete window and hashes only its stable `data` payload. */
export async function getAgendaHandler(
  c: Context<AppEnv>,
  query: AgendaQuery,
  now: string,
): Promise<Response> {
  const data = await getAgenda(requireUserId(c), query, now);
  const etag = agendaEtag(data);

  c.header('ETag', etag);
  c.header('Cache-Control', AGENDA_CACHE_CONTROL);

  if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
    return c.body(null, 304);
  }

  return c.json({ data, meta: { requestId: c.get('requestId') } });
}

/** A strong validator over canonical JSON; envelope metadata never enters this function. */
export function agendaEtag(data: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(data)).digest('base64url');
  return `"${digest}"`;
}

function matchesIfNoneMatch(value: string | undefined, current: string): boolean {
  if (value === undefined) return false;
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === '*' || candidate === current || candidate === `W/${current}`,
    );
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
