import { describe, expect, it } from 'vitest';
import { canonicalJson, entityTag, matchesIfNoneMatch } from './etag.js';

/**
 * The cache-validation contract, tested at the shared home P3-06 moved it to. The agenda
 * route tests still exercise the same functions end to end; these pin the properties two
 * endpoints now depend on agreeing about.
 */

describe('entityTag', () => {
  it('is a quoted base64url sha256 digest', () => {
    expect(entityTag({ a: 1 })).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('ignores key order, so two assemblies of one payload share a tag', () => {
    expect(entityTag({ a: 1, b: 2 })).toBe(entityTag({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(entityTag({ a: 1 })).not.toBe(entityTag({ a: 2 }));
  });

  /** Array order is meaning, not incidental: a reordered catalogue is a different payload. */
  it('respects array order', () => {
    expect(entityTag([1, 2])).not.toBe(entityTag([2, 1]));
  });

  it('changes when a member is appended', () => {
    expect(entityTag([{ key: 'a' }])).not.toBe(entityTag([{ key: 'a' }, { key: 'b' }]));
  });
});

describe('matchesIfNoneMatch', () => {
  const current = '"abc"';

  it.each([
    ['the exact tag', current],
    ['the weak form of it', 'W/"abc"'],
    ['the wildcard', '*'],
    ['a list containing it', '"stale", "abc"'],
  ])('matches %s', (_case, header) => {
    expect(matchesIfNoneMatch(header, current)).toBe(true);
  });

  it.each([
    ['an absent header', undefined],
    ['a different tag', '"def"'],
    ['a list without it', '"stale", "older"'],
    ['an empty header', ''],
  ])('does not match %s', (_case, header) => {
    expect(matchesIfNoneMatch(header, current)).toBe(false);
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
