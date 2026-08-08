import { z } from 'zod';
import { envelope } from './envelope.js';

/**
 * `GET /v1/health` (`api-contract.md` §2.1a).
 *
 * Defined here, once, and imported by both sides: the API types its response against it,
 * and the typed client parses the response with it (P0-20). Neither side declares its own
 * copy (`tech-stack.md` §5.1).
 */
export const healthData = z.object({
  /** A literal, not a string. "degraded" is not a state this endpoint can report — it does
   * no I/O, so the only ways it can fail are to not answer or to answer 5xx. */
  status: z.literal('ok'),
  /** The deployed git SHA, or `local` on a laptop. */
  sha: z.string().min(1),
  stage: z.enum(['local', 'dev', 'prod']),
  /** True only for the first request an execution environment serves. */
  coldStart: z.boolean(),
});

export const healthResponse = envelope(healthData);

export type HealthData = z.infer<typeof healthData>;
export type HealthResponse = z.infer<typeof healthResponse>;
