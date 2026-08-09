import { z } from 'zod';
import { planType } from './activity.js';
import { ianaTimezone, ulidId } from './common.js';

/**
 * The three `/v1/capture/*` shapes (`api-contract.md` §2.11, `ai-capture.md`).
 *
 * **These schemas ship in Phase 1 and the endpoints behind them return `501` until Phase 8**
 * (P1-18). Validating against the real shape from the first commit is the point: the client's
 * request body is exercised for seven phases before a model ever sees it, so Phase 8 cannot
 * discover that the client was sending the wrong thing all along.
 *
 * ## The rule these schemas encode
 *
 * **Capture fills fields inside a destination the user already chose. It never chooses the
 * destination.** `creationTarget` is required — there is no compatibility default — and
 * `objectKind`, `type`, `listId`, participants, sharing state and reminder state are never
 * model output and never appear in `fields`. A phrase like "with Alice" may be echoed in
 * `ignored` for the review UI, but capture does not resolve Alice, add her, or turn a Task
 * into a Plan. "Remind me an hour before" stays source text and never moves the Reminder
 * control (`CLAUDE.md` rule 2, ADR-046).
 */

/**
 * Where a capture result is destined (`api-contract.md` §2.3).
 *
 * **Three arms, not two.** The activity inputs know Task and Plan; capture also targets a
 * List item, which is why this union lives here rather than being derived from
 * `createActivityInput`. Phase 3 builds the list side; the arm exists now so the contract is
 * settled and P1-24's chooser can route against it.
 */
export const creationTarget = z.discriminatedUnion('objectKind', [
  z.strictObject({ objectKind: z.literal('task'), type: z.literal('task') }),
  z.strictObject({ objectKind: z.literal('plan'), type: planType }),
  z.strictObject({ objectKind: z.literal('listItem'), listId: ulidId('lst') }),
]);

/** Longest text a single parse accepts. A paragraph, not a document. */
const MAX_CAPTURE_TEXT = 4000;

export const captureParseInput = z
  .strictObject({
    text: z.string().trim().min(1).max(MAX_CAPTURE_TEXT),
    /** The device's zone, so "Friday at 8" resolves where the user is. */
    tz: ianaTimezone,
    creationTarget,
  })
  .meta({ id: 'CaptureParseInput' });

export const captureExtractInput = z
  .strictObject({
    attachmentId: ulidId('att'),
    creationTarget,
  })
  .meta({ id: 'CaptureExtractInput' });

export const captureLinkInput = z
  .strictObject({
    url: z.url(),
    creationTarget,
  })
  .meta({ id: 'CaptureLinkInput' });

/**
 * One extracted field. Below 0.7 the client highlights it for review — and blocks nothing,
 * because a low-confidence field is a prompt to look, not an error.
 */
export const capturedField = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  /** Character range in the source text, so the review UI can show where it came from. */
  sourceSpan: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
});

/**
 * Content the model saw and deliberately did not act on.
 *
 * This is how "with Alice" survives to the review screen without Alice being added to
 * anything: the phrase is reported, the action is not taken, and the user decides.
 */
export const capturedIgnored = z.object({
  reason: z.enum(['incompatible_with_target', 'sharing_requires_user_action']),
  sourceSpan: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
});

export const parsedCapture = z
  .object({
    /**
     * An exact echo of the request's target — **never model-selected**. The client asserts
     * it matches what it sent, which is the check that would catch a provider that decided
     * to be helpful.
     */
    creationTarget,
    confidence: z.number().min(0).max(1),
    fields: z.record(z.string(), capturedField),
    ignored: z.array(capturedIgnored).optional(),
    /** Development only; stripped in production responses. */
    rawModelOutput: z.string().optional(),
  })
  .meta({ id: 'ParsedCapture' });
