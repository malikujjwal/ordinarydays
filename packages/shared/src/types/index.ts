/**
 * Domain literal unions, canonical in `docs/02-architecture/data-model.md` §4.1 and §3.5.
 *
 * Entity interfaces (Activity, List, Person, Expense, …) arrive with the phase tasks that
 * build them. What is here is the vocabulary those interfaces are written in, and it is
 * the vocabulary the schemas in `../schemas/` infer their types from — never a
 * hand-written twin of a schema (`tech-stack.md` §5.1).
 */

/** What the user explicitly chose to create. Never inferred from words (`CLAUDE.md` rule 2). */
export type ActivityObjectKind = 'task' | 'plan';

/** The six stored types. A required field, not six tables (`data-model.md` §1). */
export type ActivityType = 'task' | 'meal' | 'watch' | 'event' | 'outing' | 'custom';

/** The five kinds a Plan may present as. "General" maps to `custom`. */
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
