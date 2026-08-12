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

/** Server-authored authority plus clock/status state; no owner-id inference in the client. */
export function canResolvePassedAgendaItem(item: AgendaItem): boolean {
  return item.isPast && item.status === 'scheduled' && item.capabilities.complete;
}
