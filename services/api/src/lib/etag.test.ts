import { describe, expect, it } from 'vitest';
import { canonicalJson, matchesIfNoneMatch, weakEntityTag } from './etag.js';

/**
 * The cache-validation contract, tested at the shared home P3-06 moved it to. The agenda
 * route tests still exercise the same functions end to end; these pin the properties two
 * endpoints now depend on agreeing about.
 */

describe('weakEntityTag', () => {
  /**
   * **Weak, and the syntax is the assertion.** Every response here is `{ data, meta }` with
   * a per-request `meta.requestId`, so two responses sharing a tag are never byte-identical
   * and a strong validator would assert something untrue (RFC 9110 §8.8.1). This test is
   * what P3-06's review added; a regression to `"…"` fails here first.
   */
  it('is a weak validator over a quoted base64url sha256 digest', () => {
    expect(weakEntityTag({ a: 1 })).toMatch(/^W\/"[A-Za-z0-9_-]{43}"$/);
  });

  it('ignores key order, so two assemblies of one payload share a tag', () => {
    expect(weakEntityTag({ a: 1, b: 2 })).toBe(weakEntityTag({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(weakEntityTag({ a: 1 })).not.toBe(weakEntityTag({ a: 2 }));
  });

  /** Array order is meaning, not incidental: a reordered catalogue is a different payload. */
  it('respects array order', () => {
    expect(weakEntityTag([1, 2])).not.toBe(weakEntityTag([2, 1]));
  });

  it('changes when a member is appended', () => {
    expect(weakEntityTag([{ key: 'a' }])).not.toBe(
      weakEntityTag([{ key: 'a' }, { key: 'b' }]),
    );
  });
});

/**
 * RFC 9110 §13.1.2 uses the **weak comparison function** (§8.8.3.2): opaque-tags are
 * compared and weakness is ignored on either side. So every combination of forms matches,
 * which is also what keeps a client holding a pre-fix strong tag getting its `304`.
 */
describe('matchesIfNoneMatch', () => {
  it.each([
    ['weak header against weak current', 'W/"abc"', 'W/"abc"'],
    ['strong header against weak current', '"abc"', 'W/"abc"'],
    ['weak header against strong current', 'W/"abc"', '"abc"'],
    ['strong header against strong current', '"abc"', '"abc"'],
    ['the wildcard', '*', 'W/"abc"'],
    ['a list containing it', '"stale", W/"abc"', 'W/"abc"'],
    ['a list whose match is the strong form', '"stale", "abc"', 'W/"abc"'],
  ])('matches %s', (_case, header, current) => {
    expect(matchesIfNoneMatch(header, current)).toBe(true);
  });

  it.each([
    ['an absent header', undefined],
    ['a different tag', '"def"'],
    ['a different weak tag', 'W/"def"'],
    ['a list without it', '"stale", "older"'],
    ['an empty header', ''],
  ])('does not match %s', (_case, header) => {
    expect(matchesIfNoneMatch(header, 'W/"abc"')).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('drops undefined members rather than emitting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('renders a bare undefined as null, so a missing payload still hashes', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('sorts nested keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });
});
