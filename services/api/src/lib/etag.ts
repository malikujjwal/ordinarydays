import { createHash } from 'node:crypto';

/**
 * HTTP entity tags and conditional-request matching, in one place.
 *
 * Extracted from `handlers/getAgenda.ts` in P3-06, which needed the same three pieces for
 * `GET /v1/list-templates` and could not reach two of them: `matchesIfNoneMatch` and
 * `canonicalJson` were private to that handler. Copying them would have meant two
 * implementations of a cache-validation rule that must agree byte for byte — a second
 * `canonicalJson` that sorted keys differently would produce a tag one endpoint honoured and
 * the other did not, and nothing about that failure looks wrong in a log.
 *
 * The behaviour is unchanged from the agenda's: same digest, same base64url encoding, same
 * quoting, same match semantics. `handlers/getAgenda.test.ts` and the agenda route tests
 * pin that.
 */

/**
 * A **strong** validator over the canonical JSON of a payload.
 *
 * Strong rather than weak (`W/`), because the digest covers the exact bytes a client would
 * receive: two payloads with this tag are byte-identical after canonicalisation, which is
 * what `304` promises.
 *
 * Envelope metadata must never enter this function. `meta.requestId` differs on every
 * request, so hashing the envelope rather than its `data` would produce a tag that never
 * matches and a `304` that never fires.
 */
export function entityTag(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest('base64url');
  return `"${digest}"`;
}

/**
 * Whether an `If-None-Match` header names the current tag (RFC 9110 §13.1.2).
 *
 * Accepts a comma-separated list, the wildcard `*`, and the weak form `W/"…"` of the
 * current tag — a weak validator matches under the `If-None-Match` comparison even when the
 * server issued a strong one.
 */
export function matchesIfNoneMatch(value: string | undefined, current: string): boolean {
  if (value === undefined) return false;
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === '*' || candidate === current || candidate === `W/${current}`,
    );
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical payloads
 * assembled by different code paths would otherwise hash differently and defeat the tag.
 */
export function canonicalJson(value: unknown): string {
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
