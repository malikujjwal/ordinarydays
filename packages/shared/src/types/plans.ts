/**
 * The Plans tab's response shapes (`api-contract.md` §2.2a).
 *
 * Re-exported from the schema rather than declared twice: `CLAUDE.md` requires one definition
 * per shape, and a hand-written interface beside a Zod object is how the two drift.
 */
export type {
  NeedsDateItem,
  PastCoverage,
  PastPage,
  PlansData,
  PlansDay,
  PlansMode,
  PlansQuery,
  PlansWarning,
  RsvpGroup,
  RsvpSummary,
  UpcomingWindow,
} from '../schemas/plans.js';
