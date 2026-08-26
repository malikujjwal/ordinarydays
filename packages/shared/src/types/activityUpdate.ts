/**
 * The plan's activity feed entry (`data-model.md` §4.10).
 *
 * Re-exported from the schema rather than declared twice: `CLAUDE.md` requires one definition
 * per shape, and a hand-written interface beside a Zod object is how the two drift.
 */
export type {
  ActivityUpdate,
  ActivityUpdateKind,
  ActivityUpdatePage,
  PostActivityUpdateInput,
  PostActivityUpdateResult,
} from '../schemas/activityUpdate.js';
