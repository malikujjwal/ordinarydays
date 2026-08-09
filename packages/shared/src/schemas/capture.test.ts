import { describe, expect, it } from 'vitest';
import { captureExtractInput, captureLinkInput, captureParseInput } from './capture.js';

/**
 * These endpoints return `501` until Phase 8, and their request shapes ship now so the
 * client is exercised against the real contract for seven phases first (P1-18).
 *
 * What is asserted here is the product rule, not the plumbing: **capture fills fields inside
 * a destination the user already chose, and never chooses the destination.**
 */

const target = { objectKind: 'task', type: 'task' } as const;

describe('creationTarget is required, with no default', () => {
  it('rejects text with no target', () => {
    expect(
      captureParseInput.safeParse({ text: 'Dentist Friday at 8', tz: 'America/New_York' })
        .success,
    ).toBe(false);
  });

  it('rejects an attachment with no target', () => {
    expect(
      captureExtractInput.safeParse({ attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2' })
        .success,
    ).toBe(false);
  });

  it('rejects a link with no target', () => {
    expect(captureLinkInput.safeParse({ url: 'https://example.com/gig' }).success).toBe(
      false,
    );
  });

  it('accepts the same text once a target is named', () => {
    expect(
      captureParseInput.safeParse({
        text: 'Dentist Friday at 8',
        tz: 'America/New_York',
        creationTarget: target,
      }).success,
    ).toBe(true);
  });
});

describe('the three target arms', () => {
  const parse = (creationTarget: unknown) =>
    captureParseInput.safeParse({
      text: 'Watch Severance',
      tz: 'America/New_York',
      creationTarget,
    }).success;

  it('accepts a Task target', () => {
    expect(parse({ objectKind: 'task', type: 'task' })).toBe(true);
  });

  it.each(['meal', 'watch', 'event', 'outing', 'custom'])(
    'accepts a Plan target of kind %s',
    (type) => {
      expect(parse({ objectKind: 'plan', type })).toBe(true);
    },
  );

  /** The arm the activity inputs do not have. Phase 3 builds the list side. */
  it('accepts a List item target with its chosen list', () => {
    expect(
      parse({ objectKind: 'listItem', listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2' }),
    ).toBe(true);
  });

  it('rejects a List item target with no list, which names no destination', () => {
    expect(parse({ objectKind: 'listItem' })).toBe(false);
  });

  it('rejects a Plan whose type is task', () => {
    expect(parse({ objectKind: 'plan', type: 'task' })).toBe(false);
  });

  it('rejects a target that is only an objectKind', () => {
    expect(parse({ objectKind: 'plan' })).toBe(false);
  });
});

/**
 * The fields capture must never be asked to choose. Each is rejected rather than ignored,
 * so a client that tried to route intent through the capture body is told, not silently
 * obeyed (`ai-capture.md`, ADR-046).
 */
describe('intent cannot be smuggled into a capture request', () => {
  it.each([
    ['participants', { participants: [{ displayName: 'Alice' }] }],
    ['a reminder', { reminder: { offsetMinutes: -60 } }],
    ['reminders', { reminders: [{ offsetMinutes: -60 }] }],
    ['an offset', { offsetMinutes: -60 }],
    ['a visibility', { visibility: 'shared' }],
    ['a second listId outside the target', { listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2' }],
    ['a type outside the target', { type: 'meal' }],
  ])('rejects %s alongside the target', (_why, extra) => {
    expect(
      captureParseInput.safeParse({
        text: 'Dinner with Alice, remind me an hour before',
        tz: 'America/New_York',
        creationTarget: target,
        ...extra,
      }).success,
    ).toBe(false);
  });

  /**
   * The same words, with nothing extra, parse fine. Capture may read "with Alice" and
   * "remind me an hour before" as text; what it may not do is act on them.
   */
  it('accepts that wording as ordinary source text', () => {
    expect(
      captureParseInput.safeParse({
        text: 'Dinner with Alice, remind me an hour before',
        tz: 'America/New_York',
        creationTarget: target,
      }).success,
    ).toBe(true);
  });
});
