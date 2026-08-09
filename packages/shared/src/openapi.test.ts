import type { SchemaObject } from 'openapi3-ts/oas31';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

/**
 * The document is generated, checked in, and CI fails on a diff — so what needs asserting
 * here is not the JSON (the file itself is the record of that) but the properties a future
 * endpoint could quietly break.
 */
const document = buildOpenApiDocument();

/**
 * Narrows the generator's `SchemaObject | ReferenceObject` to the inline form.
 *
 * Every component this document defines is inline; a `$ref` here would mean the generator
 * emitted a reference where the test expected a definition, which is worth failing on
 * loudly rather than reading as "the property is missing".
 *
 * Added in P1-06, when `tsconfig.test.json` started typechecking this file and surfaced two
 * long-standing errors — `.properties` does not exist on `ReferenceObject`. The assertions
 * were always correct at runtime; nothing had ever checked their types.
 */
function asSchema(value: unknown, what: string): SchemaObject {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected ${what} to be a schema object, got ${String(value)}`);
  }
  if ('$ref' in value) {
    throw new Error(`Expected ${what} to be inline, got a $ref`);
  }
  return value as SchemaObject;
}

describe('the generated document', () => {
  it('describes every endpoint registered so far', () => {
    // This assertion is what makes adding a route without registering it visible: the count
    // moves, and the person adding it has to say so. Saying so: **P1-07 added `/v1/me`**,
    // whose `GET` and `PATCH` share one path entry.
    expect(Object.keys(document.paths ?? {})).toEqual(['/v1/me', '/v1/health']);
  });

  it('carries a servers block with the local URL', () => {
    expect(document.servers).toEqual([
      { url: 'http://localhost:3000', description: 'Local development' },
    ]);
  });

  /**
   * P0-25's edge case, and the reason the block above exists at all in a phase with no
   * deployed URL: Phase 4 appends an entry to an array that is already there, rather than
   * introducing a key and producing a diff that hides the change that mattered.
   */
  it('has servers as an array, so a stage is appended rather than introduced', () => {
    expect(Array.isArray(document.servers)).toBe(true);
  });

  /**
   * `User` and `PatchUserInput` arrive with P1-07's paths, not before — a shape reaches
   * `components/schemas` only when a registered path references it, which is the mechanism
   * `openapi.ts` explains at length.
   */
  it('names its schemas as components instead of inlining them', () => {
    expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual([
      'ErrorResponse',
      'HealthResponse',
      'PatchUserInput',
      'User',
    ]);
  });

  it('references those components from the responses', () => {
    const responses = document.paths?.['/v1/health']?.get?.responses;

    expect(responses?.[200]?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/HealthResponse',
    });
    expect(responses?.[500]?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ErrorResponse',
    });
  });

  /**
   * The generator reads the shared Zod schemas, so this is the assertion that the spec and
   * the code cannot diverge: `stage` is an enum in `schemas/health.ts`, and if someone adds
   * a stage there without regenerating, the checked-in file goes stale and CI says so.
   */
  it('takes the health payload from the shared schema', () => {
    const health = asSchema(
      document.components?.schemas?.HealthResponse,
      'HealthResponse',
    );
    const data = asSchema(health.properties?.data, 'HealthResponse.data');

    expect(asSchema(data.properties?.stage, 'HealthResponse.data.stage').enum).toEqual([
      'local',
      'dev',
      'prod',
    ]);
    expect(data.required).toEqual(['status', 'sha', 'stage', 'coldStart']);
  });

  it('emits 3.1.0, which is what the $ref-in-content form above assumes', () => {
    expect(document.openapi).toBe('3.1.0');
  });
});
