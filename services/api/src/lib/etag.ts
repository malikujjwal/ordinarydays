import { createHash } from 'node:crypto';

/**
 * HTTP entity tags and conditional-request matching, in one place.
 *
 * Extracted from `handlers/getAgenda.ts` in P3-06, which needed the same pieces for
 * `GET /v1/list-templates` and could not reach two of them: `matchesIfNoneMatch` and
 * `canonicalJson` were private to that handler. Copying them would have meant two
 * implementations of a cache-validation rule that must agree byte for byte — a second
 * `canonicalJson` that sorted keys differently would produce a tag one endpoint honoured and
 * the other did not, and nothing about that failure looks wrong in a log.
 */

/**
 * A **weak** validator over the canonical JSON of a payload — `W/"<digest>"`.
 *
 * ## Why weak, and why strong is not available here
 *
 * Every response in this API is `{ data, meta }` and `meta.requestId` differs on every
 * request (`api-contract.md` §1). So two responses that a tag says are equivalent are
 * **never byte-identical**, and RFC 9110 §8.8.1 requires a strong validator to change
 * whenever the representation changes in any way. Emitting `"<digest>"` would assert
 * byte-identity that the envelope makes impossible — a cache could hold a body carrying
 * request id A, revalidate against the unchanged tag, and serve it for request B.
 *
 * Hashing the whole envelope is not the alternative: `requestId` changes every time, so the
 * tag would never match and `304` would never fire. Weak is the honest and useful answer —
 * *these representations are semantically equivalent* — and `If-None-Match` uses the weak
 * comparison function anyway (§13.1.2), so `304` behaviour is unchanged.
 *
 * Corrected in P3-06's review: this function and both its callers previously emitted a
 * strong tag over `data` alone, which was a claim neither could keep. The name says weak so
 * the next caller cannot assume otherwise.
 *
 * Pass the `data` payload, never the envelope.
 */
export function weakEntityTag(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest('base64url');
  return `W/"${digest}"`;
}

/**
 * Strips one optional `W/` weakness prefix, leaving the opaque-tag.
 *
 * RFC 9110 §8.8.3.2's weak comparison compares opaque-tags and **ignores weakness on either
 * side**, so normalising both is the whole of the rule.
 */
function opaqueTag(value: string): string {
  return value.startsWith('W/') ? value.slice(2) : value;
}

/**
 * The opaque value an `If-Match` header carries, quoted or bare.
 *
 * RFC 9110 writes an entity tag as `"value"` and a well-behaved HTTP client sends it that
 * way; our own client sends the raw `updatedAt`. Accepting both costs two `replace`s and
 * removes a class of report — "it works in curl but not in the app" — that would otherwise be
 * diagnosed from a `409` that looks like a genuine conflict.
 *
 * Lifted out of `handlers/patchActivity.ts` in P3-09, which needed the identical rule on two
 * more routes. Three copies of a comparison that decides whether an edit is stale is three
 * chances for one of them to normalise differently, and a mismatch there looks exactly like
 * a real conflict.
 */
export function entityTag(header: string): string {
  return opaqueTag(header).replace(/^"(.*)"$/, '$1');
}

/**
 * Whether an `If-None-Match` header names the current tag (RFC 9110 §13.1.2).
 *
 * Accepts a comma-separated list and the wildcard `*`, and compares with the **weak**
 * comparison function — so a client that echoes back either `W/"abc"` or `"abc"` matches a
 * current tag in either form. That symmetry is what keeps `304` working across the P3-06
 * change from strong to weak tags, including for a client still holding a strong one it was
 * issued before the fix.
 */
export function matchesIfNoneMatch(value: string | undefined, current: string): boolean {
  if (value === undefined) return false;
  const target = opaqueTag(current);
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || opaqueTag(candidate) === target);
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
