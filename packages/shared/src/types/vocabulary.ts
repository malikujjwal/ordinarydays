/**
 * Domain literal unions, canonical in `docs/02-architecture/data-model.md` §4.1 and §3.5.
 *
 * This is the vocabulary the entity interfaces are written in, and the vocabulary the schemas
 * in `../schemas/` infer their types from — never a hand-written twin of a schema
 * (`tech-stack.md` §5.1).
 *
 * **A leaf module, not `index.ts`.** These lived in the barrel until P1-06, which was fine
 * while nothing else in `types/` existed: the moment `activity.ts` needed `PlanType`, it had
 * to import from the barrel that re-exports it, and `dependency-cruiser`'s `no-circular`
 * rejected the cycle — type-only imports included. A leaf both the entities and the barrel
 * can import breaks it, the same way `routeSplit` and `app-env` share `routeRegistry`.
 */

/** What the user explicitly chose to create. Never inferred from words (`CLAUDE.md` rule 2). */
export type ActivityObjectKind = 'task' | 'plan';

/** The five stored types. A required field, not five tables (`data-model.md` §1). */
export type ActivityType = 'task' | 'meal' | 'watch' | 'event' | 'custom';

/** The four kinds a Plan may present as. "General" maps to `custom`. */
export type PlanType = Exclude<ActivityType, 'task'>;

export type ActivityStatus =
  | 'saved'
  | 'scheduled'
  | 'completed'
  | 'skipped'
  | 'cancelled';

export type ActivityVisibility = 'private' | 'shared';

export type ActivityOutcome =
  | 'done'
  | 'attended'
  | 'watched'
  | 'had_it'
  | 'didnt_happen'
  | 'didnt_go';

/**
 * Which GSI1 feed an ActivityIndex row sits in (`data-model.md` §3.5).
 *
 * `S` scheduled · `P` needs a date · `N` anytime · `R` recurring series.
 *
 * `P` and `N` are separate on purpose: both are undated, but `N` means "today, whenever"
 * and `P` means "someday, undecided". Collapsing them sends an undecided group plan to
 * Today's Anytime list next to a solo errand.
 */
export type Gsi1Bucket = 'S' | 'P' | 'N' | 'R';
