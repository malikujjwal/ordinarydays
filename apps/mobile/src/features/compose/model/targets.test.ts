import { createActivityInput } from '@od/shared/schemas';
import { describe, expect, it } from 'vitest';
import {
  canSave,
  objectChoices,
  planKindChoices,
  planKindLabel,
  saveLabel,
  successToast,
  targetHeading,
  toCreateActivityInput,
} from './targets';

/**
 * The chooser vocabulary and its mapping onto a request body (P1-24).
 *
 * `CLAUDE.md` rule 2 is what this file asserts, and it asserts it against the **real shared
 * schema** rather than against a shape written here: every body produced is fed through
 * `createActivityInput.parse`. A mapping that drifted from the contract would pass a
 * hand-written expectation and fail the server.
 */

describe('the object chooser', () => {
  it('offers exactly Task, Plan, List item, in that order', () => {
    expect(objectChoices.map((c) => c.label)).toEqual(['Task', 'Plan', 'List item']);
  });

  /**
   * The list is frozen so a "most recently used" experiment cannot be a one-line sort. The
   * chooser costs one tap every time, deliberately (`activities.md` §2.2).
   */
  it('cannot be reordered by a caller', () => {
    expect(Object.isFrozen(objectChoices)).toBe(true);
    expect(() => (objectChoices as { length: number }).length).not.toThrow();
  });
});

describe('the Plan-kind chooser', () => {
  it('offers exactly General, Meal, Watch, Event, Outing, in that order', () => {
    expect(planKindChoices.map((c) => c.label)).toEqual([
      'General',
      'Meal',
      'Watch',
      'Event',
      'Outing',
    ]);
  });

  /** `General` is the visible label for the stored type `custom`, and is a real choice. */
  it('maps General to custom and never to a fallback', () => {
    expect(planKindChoices[0]).toEqual({ value: 'custom', label: 'General' });
    expect(planKindLabel('custom')).toBe('General');
  });

  it('maps every stored plan type to a label', () => {
    expect(planKindChoices.map((c) => c.value)).toEqual([
      'custom',
      'meal',
      'watch',
      'event',
      'outing',
    ]);
    expect(planKindLabel('watch')).toBe('Watch');
  });

  it('throws rather than guessing at an unknown kind', () => {
    expect(() => planKindLabel('podcast' as never)).toThrow('Unknown plan kind');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(planKindChoices)).toBe(true);
  });
});

describe('the form header', () => {
  it('names the object for a Task', () => {
    expect(targetHeading({ objectKind: 'task', type: 'task' })).toBe('Task');
  });

  it('names the object and the Plan kind for a Plan', () => {
    expect(targetHeading({ objectKind: 'plan', type: 'watch' })).toBe('Plan · Watch');
    expect(targetHeading({ objectKind: 'plan', type: 'custom' })).toBe('Plan · General');
  });

  it('names a List item', () => {
    expect(
      targetHeading({ objectKind: 'listItem', listId: 'lst_01J000000000000000000000' }),
    ).toBe('List item');
  });
});

describe('the named write button', () => {
  it('says Save task for a Task', () => {
    expect(saveLabel({ objectKind: 'task', type: 'task' })).toBe('Save task');
  });

  it('says Save plan for every Plan kind', () => {
    for (const choice of planKindChoices) {
      expect(saveLabel({ objectKind: 'plan', type: choice.value })).toBe('Save plan');
    }
  });

  /** `Add to <list name>` — a generic `Save` must never hide a list write. */
  it('names the destination list for a List item', () => {
    expect(
      saveLabel(
        { objectKind: 'listItem', listId: 'lst_01J000000000000000000000' },
        'Groceries',
      ),
    ).toBe('Add to Groceries');
  });
});

describe('toCreateActivityInput', () => {
  const fields = { title: '  Call the dentist  ', notes: '' };

  it('sends objectKind and type for a Task, and trims the title', () => {
    const input = toCreateActivityInput({ objectKind: 'task', type: 'task' }, fields);

    expect(input).toEqual({
      objectKind: 'task',
      type: 'task',
      title: 'Call the dentist',
      details: { kind: 'task' },
    });
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it.each(planKindChoices.map((c) => c.value))(
    'sends objectKind plan and the chosen type %s, and passes the shared schema',
    (type) => {
      const input = toCreateActivityInput(
        { objectKind: 'plan', type },
        { title: 'Severance', notes: '' },
      );

      expect(input).toMatchObject({ objectKind: 'plan', type });
      expect(createActivityInput.safeParse(input).success).toBe(true);
    },
  );

  /** `details.kind` must equal `type` — the server rejects a body where it does not. */
  it('mirrors the chosen type into details.kind for every Plan kind', () => {
    for (const { value } of planKindChoices) {
      const input = toCreateActivityInput(
        { objectKind: 'plan', type: value },
        { title: 'Severance', notes: '' },
      );
      expect(input?.details?.kind).toBe(value);
    }
  });

  it('starts a Watch plan mediaTitle equal to the title', () => {
    const input = toCreateActivityInput(
      { objectKind: 'plan', type: 'watch' },
      { title: 'Severance', notes: '' },
    );
    expect(input?.details).toEqual({ kind: 'watch', mediaTitle: 'Severance' });
  });

  it('starts an Outing placeName equal to the title', () => {
    const input = toCreateActivityInput(
      { objectKind: 'plan', type: 'outing' },
      { title: 'Zahav', notes: '' },
    );
    expect(input?.details).toEqual({ kind: 'outing', placeName: 'Zahav' });
  });

  it('omits notes and sourceUrl rather than sending empty strings', () => {
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      { title: 'x', notes: '   ', sourceUrl: '' },
    );
    expect(input).not.toHaveProperty('notes');
    expect(input).not.toHaveProperty('sourceUrl');
  });

  it('carries notes and sourceUrl when they have content', () => {
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      { title: 'x', notes: ' bring cash ', sourceUrl: 'https://example.com/a' },
    );
    expect(input).toMatchObject({
      notes: 'bring cash',
      sourceUrl: 'https://example.com/a',
    });
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  /** A List item is not an Activity and does not go to `POST /v1/activities` at all. */
  it('produces no Activity body for a List item', () => {
    expect(
      toCreateActivityInput(
        { objectKind: 'listItem', listId: 'lst_01J000000000000000000000' },
        { title: 'Chicken', notes: '' },
      ),
    ).toBeUndefined();
  });
});

describe('canSave', () => {
  it('needs a non-empty trimmed title and nothing else', () => {
    expect(canSave({ title: 'x', notes: '' })).toBe(true);
    expect(canSave({ title: '   ', notes: 'lots of notes' })).toBe(false);
    expect(canSave({ title: '', notes: '' })).toBe(false);
  });
});

describe('successToast', () => {
  it('names the object and where it landed', () => {
    expect(successToast({ objectKind: 'task', type: 'task' })).toBe(
      'Task · saved to Anytime',
    );
    expect(successToast({ objectKind: 'plan', type: 'outing' })).toBe(
      'Outing plan · saved to Needs a date',
    );
    expect(successToast({ objectKind: 'plan', type: 'custom' })).toBe(
      'General plan · saved to Needs a date',
    );
    expect(
      successToast({ objectKind: 'listItem', listId: 'lst_01J000000000000000000000' }),
    ).toBe('Added to list');
  });
});
