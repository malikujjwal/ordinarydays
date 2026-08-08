import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

/**
 * The document is generated, checked in, and CI fails on a diff — so what needs asserting
 * here is not the JSON (the file itself is the record of that) but the properties a future
 * endpoint could quietly break.
 */
const document = buildOpenApiDocument();

describe('the generated document', () => {
  it('describes every endpoint registered so far', () => {
    // One, in Phase 0. This assertion is what makes adding a route without registering it
    // visible: the count moves, and the person adding it has to say so.
    expect(Object.keys(document.paths ?? {})).toEqual(['/v1/health']);
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

  it('names its schemas as components instead of inlining them', () => {
    expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual([
      'ErrorResponse',
      'HealthResponse',
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
    const health = document.components?.schemas?.HealthResponse;

    expect(health?.properties?.data?.properties?.stage?.enum).toEqual([
      'local',
      'dev',
      'prod',
    ]);
    expect(health?.properties?.data?.required).toEqual([
      'status',
      'sha',
      'stage',
      'coldStart',
    ]);
  });

  it('emits 3.1.0, which is what the $ref-in-content form above assumes', () => {
    expect(document.openapi).toBe('3.1.0');
  });
});
