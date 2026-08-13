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

/** Server-authored authority plus clock/status state; no owner-id inference in the client. */
export function canResolvePassedAgendaItem(item: AgendaItem): boolean {
  return item.isPast && item.status === 'scheduled' && item.capabilities.complete;
}
