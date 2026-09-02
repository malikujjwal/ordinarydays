import type { CompletionFollowUp } from '@od/shared/schemas';
import { describe, expect, it, vi } from 'vitest';
import {
  deletePrepConfirmation,
  type FollowUpHandlers,
  followUpPresentation,
  nextSessionQuestion,
  prepQuestion,
  progressQuestion,
  stateQuestion,
} from './followUpCopy';

const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CHILD = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const handlers = (): FollowUpHandlers => ({
  updateProgress: vi.fn(),
  markDone: vi.fn(),
  addIngredients: vi.fn(),
  keepPrep: vi.fn(),
  completeAllPrep: vi.fn(),
  deletePrep: vi.fn(),
});

const progress: CompletionFollowUp = {
  kind: 'watch_progress',
  listId: LIST,
  listTitle: 'Movies and shows',
  itemId: ITEM,
  mediaKind: 'show',
  current: { season: 2, episode: 4 },
  target: { season: 2, episode: 5 },
};

/** `activities.md` §5.3's wording, verbatim, and one explicit tap per write. */
describe('the follow-up copy', () => {
  it('asks the Progress question with the current and the target session', () => {
    expect(progressQuestion(progress)).toBe(
      'Movies and shows · currently S2 E4 — Update to S2 E5?',
    );
    expect(progressQuestion({ ...progress, current: {} })).toBe(
      'Movies and shows — Update to S2 E5?',
    );
    expect(nextSessionQuestion('Movies and shows', 2, 5)).toBe(
      'Movies and shows · now at S2 E5 — Create a Plan for S2 E6?',
    );
  });

  it('says visited for an Event and done for a Watch', () => {
    const state: CompletionFollowUp = {
      kind: 'list_item_state',
      listId: LIST,
      listTitle: 'Places',
      itemId: ITEM,
      itemTitle: 'Louvre',
      current: { state: 'open' },
      target: { state: 'done' },
    };
    expect(stateQuestion(state, { activityType: 'event' })).toBe(
      'Mark Louvre visited in Places?',
    );
    expect(stateQuestion(state, { activityType: 'watch' })).toBe(
      'Mark Places item done?',
    );
    expect(
      followUpPresentation(state, { activityType: 'event' }, handlers()).actions.map(
        (action) => action.label,
      ),
    ).toEqual(['Mark visited']);
  });

  it('names the real count of open one-off prep tasks and offers exactly three choices', () => {
    expect(prepQuestion(2)).toBe('2 one-off prep tasks are still open — keep them?');
    expect(prepQuestion(1)).toBe('1 one-off prep task is still open — keep it?');
    const given = handlers();
    const presentation = followUpPresentation(
      { kind: 'open_prep', count: 2, childIds: [CHILD, CHILD] },
      { activityType: 'custom' },
      given,
    );
    expect(presentation.actions.map((action) => action.label)).toEqual([
      'Keep',
      'Complete all',
      'Delete',
    ]);
    presentation.actions[0]?.onPress();
    expect(given.keepPrep).toHaveBeenCalledOnce();
    expect(given.completeAllPrep).not.toHaveBeenCalled();
    expect(given.deletePrep).not.toHaveBeenCalled();
    expect(deletePrepConfirmation(2)).toEqual({
      message: 'Delete 2 open prep tasks? This cannot be undone.',
      label: 'Delete 2 tasks',
    });
  });

  it('routes the meal row to its one named tap', () => {
    const given = handlers();
    const meal = followUpPresentation(
      { kind: 'meal_ingredients', remaining: 3 },
      { activityType: 'meal' },
      given,
    );
    expect(meal.message).toBe('Add ingredients to a list?');
    expect(meal.actions.map((action) => action.label)).toEqual(['Add ingredients']);
    meal.actions[0]?.onPress();
    expect(given.addIngredients).toHaveBeenCalledOnce();
  });
});
