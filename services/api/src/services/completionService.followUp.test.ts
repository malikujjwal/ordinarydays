import { describe, expect, it } from 'vitest';
import { expenseFollowUp } from './completionService.js';

/** `activities.md` §5.3's expense rows, from the counters a Plan row already carries. */
describe('expenseFollowUp', () => {
  it('offers Review expenses to a shared plan that has spent something', () => {
    expect(
      expenseFollowUp({
        objectKind: 'plan',
        participantCount: 1,
        expenseTotalCents: 1250,
      }),
    ).toEqual({ kind: 'review_expenses' });
  });

  it('offers Add an expense to a plan with two or more participants and nothing spent', () => {
    expect(
      expenseFollowUp({ objectKind: 'plan', participantCount: 2, expenseTotalCents: 0 }),
    ).toEqual({ kind: 'add_expense' });
  });

  it('offers nothing to a plan on its own with nothing spent, or to a task', () => {
    expect(
      expenseFollowUp({ objectKind: 'plan', participantCount: 1, expenseTotalCents: 0 }),
    ).toBeUndefined();
    expect(
      expenseFollowUp({
        objectKind: 'task',
        participantCount: 3,
        expenseTotalCents: 900,
      }),
    ).toBeUndefined();
  });
});
