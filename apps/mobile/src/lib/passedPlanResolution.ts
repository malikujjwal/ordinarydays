import type { ActivityOutcome, ActivityType, AgendaItem } from '@od/shared/types';

export interface PassedPlanResolution {
  prompt: 'Done?' | 'How did it go?';
  positive: { label: string; outcome: ActivityOutcome };
  negative: { label: "Didn't happen" | "Didn't go"; outcome: ActivityOutcome };
}

const RESOLUTIONS: Record<ActivityType, PassedPlanResolution> = {
  task: {
    prompt: 'Done?',
    positive: { label: 'Complete', outcome: 'done' },
    negative: { label: "Didn't happen", outcome: 'didnt_happen' },
  },
  meal: {
    prompt: 'How did it go?',
    positive: { label: 'Had it', outcome: 'had_it' },
    negative: { label: "Didn't happen", outcome: 'didnt_happen' },
  },
  watch: {
    prompt: 'How did it go?',
    positive: { label: 'Watched', outcome: 'watched' },
    negative: { label: "Didn't happen", outcome: 'didnt_happen' },
  },
  event: {
    prompt: 'How did it go?',
    positive: { label: 'Attended', outcome: 'attended' },
    negative: { label: "Didn't go", outcome: 'didnt_go' },
  },
  custom: {
    prompt: 'Done?',
    positive: { label: 'Done', outcome: 'done' },
    negative: { label: "Didn't happen", outcome: 'didnt_happen' },
  },
};

export function passedPlanResolution(type: ActivityType): PassedPlanResolution {
  return RESOLUTIONS[type];
}

/**
 * The verb this type completes with — `Complete`, `Had it`, `Watched`, `Attended`, `Done`.
 *
 * **One definition, because three surfaces have to agree.** `today-and-tasks.md` §4 names the
 * detail screen's primary button, the row's trailing slot and the passed-plan sheet as showing
 * the same verb for the same activity, and P2-41 requires the button it adds to match what the
 * other two already render. Until now the mapping existed three times — here, in `AgendaRow`
 * and in `swipeActions` — and three copies of a table that must agree is a disagreement waiting
 * to happen. Adding a fourth for the detail button was not an option.
 *
 * Derived from `RESOLUTIONS` rather than restated, so the sheet's positive label and the verb
 * cannot drift apart either.
 */
export function completionVerb(type: ActivityType): string {
  return RESOLUTIONS[type].positive.label;
}

/** `didnt_happen` and `didnt_go` — the outcomes that mean the thing did not take place. */
export function isNegativeOutcome(outcome: ActivityOutcome): boolean {
  return outcome === 'didnt_happen' || outcome === 'didnt_go';
}

/**
 * The verb an **already-resolved** activity renders — `Done`, `Had it`, `Watched`, `Attended`,
 * and, when the user said it did not happen, `Didn't happen` or `Didn't go`.
 *
 * Not the same list as `completionVerb`, and `today-and-tasks.md` §4 is explicit about both: the
 * passed-plan sheet's positive button for a task is `Complete` (§4's table), while a completed
 * item's trailing slot and the detail screen's resolved line render `Done` (§4 "Completed items
 * render with their outcome verb (`Had it`, `Watched`, `Attended`, `Done`)"). One mapping served
 * both and put the imperative on the state, so a finished task announced itself as `Complete` —
 * an instruction where a status belongs.
 *
 * **The stored outcome decides, not the type alone.** Without it, answering `Didn't go` on an
 * event still rendered `Attended`: the type's positive label was the only thing this function
 * could see, so the screen reported the opposite of what the user had just said. The negative
 * labels are the same two strings the resolution sheet offered, so the state echoes the choice
 * rather than paraphrasing it.
 *
 * Only `task` differs on the positive side; every other type completes with the verb it is
 * described by.
 */
export function outcomeVerb(type: ActivityType, outcome?: ActivityOutcome): string {
  if (outcome !== undefined && isNegativeOutcome(outcome)) {
    return RESOLUTIONS[type].negative.label;
  }
  return type === 'task' ? 'Done' : RESOLUTIONS[type].positive.label;
}

/** Server-authored authority plus clock/status state; no owner-id inference in the client. */
export function canResolvePassedAgendaItem(item: AgendaItem): boolean {
  return item.isPast && item.status === 'scheduled' && item.capabilities.complete;
}
