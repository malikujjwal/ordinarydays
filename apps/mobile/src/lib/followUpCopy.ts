import type { CompletionFollowUp } from '@od/shared/schemas';
import type { ActivityType } from '@od/shared/types';
import type { FollowUpPresentation } from '@/stores/toast';

/**
 * The words a completion follow-up says (`activities.md` §5.3, `interaction-contract.md`
 * §1a.2), and which explicit tap does what. Pure, so every question and every button label
 * is testable as a string; the hook that performs the taps lives in `hooks/useFollowUp.ts`.
 *
 * Every button names its write (`CLAUDE.md` rule 2 and rule 5): `Update`, `Mark visited`,
 * `Complete all`, `Delete` — never a bare `OK`. Dismissing is the host's `✕`, which writes
 * nothing, and nothing here is pre-selected.
 */

type FollowUpOf<K extends CompletionFollowUp['kind']> = Extract<
  CompletionFollowUp,
  { kind: K }
>;

export interface FollowUpHandlers {
  updateProgress: (followUp: FollowUpOf<'watch_progress'>) => void;
  markDone: (followUp: FollowUpOf<'list_item_state'>) => void;
  addIngredients: (followUp: FollowUpOf<'meal_ingredients'>) => void;
  keepPrep: () => void;
  completeAllPrep: (followUp: FollowUpOf<'open_prep'>) => void;
  deletePrep: (followUp: FollowUpOf<'open_prep'>) => void;
}

export interface FollowUpContext {
  /** The completed Activity's type; decides `visited` versus `done` wording. */
  activityType: ActivityType | undefined;
}

const sessionLabel = (season: number | undefined, episode: number | undefined): string =>
  season === undefined || episode === undefined ? '' : `S${season} E${episode}`;

/** `{list name} · currently S2 E4 — Update to S2 E5?` — or without a current value, `{list name} — Update to S2 E5?`. */
export function progressQuestion(followUp: FollowUpOf<'watch_progress'>): string {
  const current = sessionLabel(followUp.current.season, followUp.current.episode);
  const target = sessionLabel(followUp.target.season, followUp.target.episode);
  return current === ''
    ? `${followUp.listTitle} — Update to ${target}?`
    : `${followUp.listTitle} · currently ${current} — Update to ${target}?`;
}

/** The second, separate step after an accepted Progress update: `Create a Plan for S2 E6?`. */
export function nextSessionQuestion(
  listTitle: string,
  season: number,
  episode: number,
): string {
  return `${listTitle} · now at ${sessionLabel(season, episode)} — Create a Plan for ${sessionLabel(season, episode + 1)}?`;
}

export const CREATE_A_PLAN = 'Create a Plan';

export function progressUpdatedMessage(season: number, episode: number): string {
  return `Progress updated to ${sessionLabel(season, episode)}`;
}

/** `Mark Louvre visited in Places?` for an Event; `Mark {list name} item done?` otherwise. */
export function stateQuestion(
  followUp: FollowUpOf<'list_item_state'>,
  context: FollowUpContext,
): string {
  return context.activityType === 'event' && followUp.itemTitle !== undefined
    ? `Mark ${followUp.itemTitle} visited in ${followUp.listTitle}?`
    : `Mark ${followUp.listTitle} item done?`;
}

export function prepQuestion(count: number): string {
  return count === 1
    ? '1 one-off prep task is still open — keep it?'
    : `${count} one-off prep tasks are still open — keep them?`;
}

/** The named, destructive second tap behind `Delete` (`interaction-contract.md` §1a.1). */
export function deletePrepConfirmation(count: number): {
  message: string;
  label: string;
} {
  const noun = count === 1 ? 'prep task' : 'prep tasks';
  return {
    message: `Delete ${count} open ${noun}? This cannot be undone.`,
    label: `Delete ${count} ${count === 1 ? 'task' : 'tasks'}`,
  };
}

export const ADD_INGREDIENTS_QUESTION = 'Add ingredients to a list?';

/** The one follow-up's question and its explicit choices. */
export function followUpPresentation(
  followUp: CompletionFollowUp,
  context: FollowUpContext,
  handlers: FollowUpHandlers,
): FollowUpPresentation {
  switch (followUp.kind) {
    case 'watch_progress':
      return {
        message: progressQuestion(followUp),
        actions: [
          {
            label: 'Update',
            onPress: () => handlers.updateProgress(followUp),
            testID: 'follow-up-update-progress',
          },
        ],
      };
    case 'list_item_state':
      return {
        message: stateQuestion(followUp, context),
        actions: [
          {
            label: context.activityType === 'event' ? 'Mark visited' : 'Mark done',
            onPress: () => handlers.markDone(followUp),
            testID: 'follow-up-mark-done',
          },
        ],
      };
    case 'meal_ingredients':
      return {
        message: ADD_INGREDIENTS_QUESTION,
        actions: [
          {
            label: 'Add ingredients',
            onPress: () => handlers.addIngredients(followUp),
            testID: 'follow-up-add-ingredients',
          },
        ],
      };
    case 'open_prep':
      return {
        message: prepQuestion(followUp.count),
        actions: [
          { label: 'Keep', onPress: handlers.keepPrep, testID: 'follow-up-keep' },
          {
            label: 'Complete all',
            onPress: () => handlers.completeAllPrep(followUp),
            testID: 'follow-up-complete-all',
          },
          {
            label: 'Delete',
            onPress: () => handlers.deletePrep(followUp),
            testID: 'follow-up-delete',
          },
        ],
      };
  }
}
