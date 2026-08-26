import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';
import { listBehaviourConfirmation } from './list.js';

/**
 * The error envelope, as a schema (`api-contract.md` §1).
 *
 * It existed only as the `AppErrorBody` interface in `errors.ts` until P0-25, which was
 * enough for the client's narrowing check and not enough to describe in OpenAPI. The two
 * are kept in step by `error.test.ts` rather than by care: a type-level assertion in both
 * directions, so adding a field to one and not the other fails the build.
 *
 * `ERROR_CODES` is imported rather than restated. The closed union has one home, and a
 * second list of the same fourteen strings is a list that will disagree eventually.
 */
export const errorDetail = z.object({
  /** Dotted path into the request body, e.g. `schedule.time`. */
  path: z.string(),
  message: z.string(),
});

export const errorBody = z.object({
  code: z.enum(ERROR_CODES),
  /**
   * Always safe to show a user. For `internal` it is the literal
   * "An unexpected error occurred." and never the exception text
   * (`tech-stack.md` §4.4, `security-privacy.md` §4.2).
   */
  message: z.string(),
  /** Present on `validation_failed`, one entry per field that failed. */
  details: z.array(errorDetail).optional(),
  /** Echoes `X-Request-Id`, so a support message can name it. */
  requestId: z.string(),
});

/**
 * `.meta({ id })` names this shape in the generated OpenAPI document, so it appears once
 * under `components/schemas` and every response that returns it carries a `$ref`.
 *
 * Zod 4's **native** metadata, deliberately, rather than `zod-to-openapi`'s `.openapi()`
 * helper. That helper needs `extendZodWithOpenApi(z)` to have run before the schema is
 * constructed — and schemas are constructed at module load, so whether it works depends on
 * which module the import graph reaches first. `.meta()` has no such ordering trap, and the
 * generator reads it identically (its README: "you could even generate a schema without
 * using `extendZodWithOpenApi` … and only rely on `.meta`").
 */
export const errorResponse = z
  .object({
    error: errorBody,
    confirmation: listBehaviourConfirmation.optional(),
  })
  .meta({ id: 'ErrorResponse' });

export type ErrorResponse = z.infer<typeof errorResponse>;
