import { zValidator } from '@hono/zod-validator';
import {
  captureExtractInput,
  captureLinkInput,
  captureParseInput,
} from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';

/**
 * `/v1/capture/*` (`api-contract.md` §2.11, `ai-capture.md`) — **stubs until Phase 8**.
 *
 * ## Why a stub that validates is worth more than no stub
 *
 * Each route parses its body against the **real** schema and only then refuses. That
 * ordering is the whole point of shipping these seven phases early: the client's request
 * shape is exercised from Phase 1, so Phase 8 cannot discover that the client has been
 * sending the wrong body all along (P1-18). A stub that answered `501` before looking would
 * be a stub that proves nothing.
 *
 * It is also why these are **not** absent. An unmounted path already answers `501` through
 * `routeSplit`, which would be the cheaper thing to do and would validate nothing.
 *
 * ## What the schemas enforce, and why it is a security control rather than a nicety
 *
 * `creationTarget` is **required, with no compatibility default**. Capture fills fields
 * inside a destination the user already chose; it never chooses the destination
 * (`CLAUDE.md` rule 2). And because every input is a `strictObject`, the fields that must
 * never be model output — `objectKind` and `type` outside the target, `listId`, participants,
 * audience, visibility, and `reminder`/`reminders`/`offsetMinutes` — are rejected by name
 * rather than ignored.
 *
 * That matters most for reminders: `remind me an hour before` is source text and must never
 * move the Reminder control (`security-privacy.md` §1 row 7, ADR-046). The strictness is
 * what makes a hostile poster unable to smuggle one in, and it is asserted here rather than
 * left to Phase 8 to remember.
 *
 * Nothing in this file reads a body field, calls a model, or writes anything. There is no
 * flag to turn it on: Phase 8 replaces the throw.
 */

const NOT_YET = 'Capture is not available yet.';

/**
 * Throws, for the reason `me.ts` records: `zValidator`'s default is to answer with its own
 * body, which is not the contract envelope and never reaches `errorHandler`.
 */
function validate<T extends Parameters<typeof zValidator>[1]>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) throw result.error;
  });
}

/**
 * The one line every route shares. `not_implemented` maps to `501`, and the message says
 * *not yet* rather than naming a phase — a user reading it does not know what Phase 8 is.
 */
function notYet(): never {
  throw new AppError('not_implemented', NOT_YET);
}

export const capture = new Hono<AppEnv>()
  .post('/parse', validate(captureParseInput), notYet)
  .post('/extract', validate(captureExtractInput), notYet)
  .post('/link', validate(captureLinkInput), notYet);
