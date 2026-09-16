import { canReceiveIngredients, listTemplateChoices } from '@od/shared/lists';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateListResult } from '../hooks/useCreateList';
import { NewListSheet } from './NewListSheet';

/**
 * The template-first creation sheet (§P3-26, `plans-and-lists.md` §5.4).
 *
 * The hook is stubbed so the sheet's **own** rules are what is under test — the order, the
 * absence of a title field before a tap, the prefill, the enablement and the announcements.
 * `listTransactions.test.ts` and `syncEngine.test.ts` cover the durable write behind it, and
 * `e2e/specs/new-list.spec.ts` proves the chain end to end against the real API.
 */

const hook = vi.hoisted(() => ({ current: {} as CreateListResult }));
vi.mock('../hooks/useCreateList', () => ({ useCreateList: () => hook.current }));

function setHook(overrides: Partial<CreateListResult> = {}) {
  hook.current = {
    create: vi.fn(async () => 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
    isCreating: false,
    errorMessage: undefined,
    errorRequestId: undefined,
    dismissError: vi.fn(),
    ...overrides,
  };
  return hook.current;
}

function mount() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <NewListSheet open onClose={onClose} onCreated={onCreated} />
    </ThemeProvider>,
  );
  return { onClose, onCreated };
}

function choiceControl(templateKey: string) {
  const choice = listTemplateChoices().find(
    (candidate) => candidate.templateKey === templateKey,
  );
  if (choice === undefined) throw new Error(`Missing List choice ${templateKey}`);
  const label = choice.templateKey === 'blank' ? 'Blank list' : choice.chooserLabel;
  return screen.getByRole('button', { name: `${label}. ${choice.summary}` });
}

const choose = (templateKey: string) => fireEvent.click(choiceControl(templateKey));

const titleField = () => screen.getByRole('textbox');
const createButton = () => screen.getByRole('button', { name: /^Create list/ });

beforeEach(() => {
  setHook();
});

describe('the style chooser comes first', () => {
  it('opens on the whole catalogue with nothing selected and no title field', () => {
    mount();

    expect(screen.getByRole('heading', { name: 'Choose a list type' })).toBeDefined();
    expect(
      screen.getByText(
        'Choose Blank when you want a list without a category or item details.',
      ),
    ).toBeDefined();
    expect(screen.getByTestId('list-style-chooser')).toBeDefined();
    // There is no text on the screen for anything to classify, and no write to enable.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create list' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('renders every style exactly once, in the catalogue order', () => {
    mount();
    const choices = listTemplateChoices();

    const rendered = choices.filter((choice) => {
      const label = choice.templateKey === 'blank' ? 'Blank list' : choice.chooserLabel;
      return screen.queryByRole('button', { name: `${label}. ${choice.summary}` });
    });
    expect(rendered.map((choice) => choice.templateKey)).toEqual(
      choices.map((choice) => choice.templateKey),
    );
    expect(choiceControl('blank')).toBeDefined();
  });

  it('leads with one full-width Blank list card above the six-card grid', () => {
    mount();
    expect(choiceControl('blank').textContent).toContain('Blank list');
    expect(
      screen.getByTestId('list-style-leading').contains(choiceControl('blank')),
    ).toBe(true);
    expect(screen.getByTestId('list-style-grid').children).toHaveLength(6);
  });

  /** §5.4 rule 6, exactly: `<style>. <description>`. */
  it('announces each row as its style and its description', () => {
    mount();

    expect(
      screen.getByRole('button', {
        name: 'Blank list. Start without a category or item details',
      }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Groceries. A shopping checklist' }),
    ).toBeDefined();
  });

  /** A chooser row navigates; it is neither selected nor unselected, and says neither. */
  it('reports no selection state on any row', () => {
    mount();

    for (const choice of listTemplateChoices()) {
      const row = choiceControl(choice.templateKey);
      expect(row.getAttribute('aria-selected'), choice.templateKey).toBeNull();
      expect(row.getAttribute('aria-pressed'), choice.templateKey).toBeNull();
      expect(row.getAttribute('aria-checked'), choice.templateKey).toBeNull();
    }
  });
});

describe('a destination-constrained catalogue', () => {
  it('offers exactly the three templates that can receive ingredients', () => {
    render(
      <ThemeProvider scheme="light">
        <NewListSheet open onClose={() => {}} templatePredicate={canReceiveIngredients} />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('list-style-blank')).toBeNull();
    expect(screen.getByTestId('list-style-checklist')).toBeDefined();
    expect(screen.getByTestId('list-style-groceries')).toBeDefined();
    expect(screen.getByTestId('list-style-places-to-visit')).toBeDefined();
    expect(screen.getByTestId('list-style-grid').children).toHaveLength(3);
  });

  it('keeps the Watch creation nudge constrained to Watch Later', () => {
    render(
      <ThemeProvider scheme="light">
        <NewListSheet open onClose={() => {}} constrainTo="watch-later" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('list-style-watch-later')).toBeDefined();
    expect(screen.getByTestId('list-style-grid').children).toHaveLength(1);
  });
});

describe('the title step', () => {
  it('shows the chosen style, its exact summary and its editable default title', () => {
    mount();

    choose('watch-later');

    expect(screen.getByRole('heading', { name: 'Watch Later' })).toBeDefined();
    expect(screen.getByText('Track what to watch and episode progress')).toBeDefined();
    expect(titleField().getAttribute('value')).toBe('Watch Later');
    // §5.4 rule 6's second announcement.
    expect(titleField().getAttribute('aria-label')).toBe(
      'List name, pre-filled with Watch Later',
    );
    expect(screen.queryByTestId('list-style-chooser')).toBeNull();
  });

  /**
   * `Blank` is a tap like every other style, and the label and the prefilled title are two
   * different catalogue fields (§P3-07).
   */
  it('creates Blank explicitly, prefilled Untitled list', async () => {
    const { create } = setHook();
    mount();

    choose('blank');
    expect(titleField().getAttribute('value')).toBe('Untitled list');
    fireEvent.click(createButton());
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith('blank', 'Untitled list');
  });

  /**
   * The founder's own example: retitling Groceries to `Costco run` must not make it a plain
   * list. The title is data; the tap chose the style.
   */
  it('keeps the tapped style when the title is edited', async () => {
    const { create } = setHook();
    const { onCreated, onClose } = mount();

    choose('groceries');
    fireEvent.change(titleField(), { target: { value: 'Costco run' } });
    fireEvent.click(createButton());
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith('groceries', 'Costco run');
    expect(onCreated).toHaveBeenCalledWith({
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      title: 'Costco run',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('trims the title it writes', async () => {
    const { create } = setHook();
    mount();

    choose('checklist');
    fireEvent.change(titleField(), { target: { value: '  Lisbon  ' } });
    fireEvent.click(createButton());
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith('checklist', 'Lisbon');
  });

  /** §5.4 rule 3: the trimmed title, and nothing else, gates the write. */
  it.each([
    ['an empty title', ''],
    ['whitespace only', '   '],
  ])('disables Create list for %s', (_case, value) => {
    mount();

    choose('groceries');
    fireEvent.change(titleField(), { target: { value } });

    expect(createButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('enables Create list once the title is non-empty', () => {
    mount();

    choose('groceries');

    expect(createButton().getAttribute('aria-disabled')).toBeNull();
  });

  /** §5.4 rule 1: `Back` retains nothing — not the style, and not the edited title. */
  it('returns to the chooser retaining nothing', () => {
    mount();

    choose('groceries');
    fireEvent.change(titleField(), { target: { value: 'Costco run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('list-style-chooser')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();

    choose('groceries');
    expect(titleField().getAttribute('value')).toBe('Groceries');
  });

  it('keeps the step open and names the failure when the write does not land', async () => {
    const create = vi.fn(async () => undefined);
    setHook({ create, errorMessage: 'Something went wrong.', errorRequestId: 'req_9' });
    const { onCreated, onClose } = mount();

    choose('groceries');
    fireEvent.click(createButton());
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    expect(screen.getByRole('alert').textContent).toContain('Something went wrong.');
    expect(titleField()).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The sheet opened from a Plan's `Add list` (§P3-39): same catalogue, one context line, a
 * `· <Plan title>` prefill, and `sourceActivityId` on the one confirmed write. The Plan is
 * context, never input — nothing about it ranks, hides or selects a style.
 */
describe('a Plan as the source', () => {
  const PLAN = {
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3',
    planTitle: 'New York Trip',
  };

  function mountSourced() {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(
      <ThemeProvider scheme="light">
        <NewListSheet open onClose={onClose} onCreated={onCreated} source={PLAN} />
      </ThemeProvider>,
    );
    return { onClose, onCreated };
  }

  it('names the Plan in a context line and changes nothing about the catalogue', () => {
    mountSourced();

    expect(screen.getByTestId('new-list-source-context').textContent).toBe(
      'For New York Trip',
    );
    // The identical seven, in the identical order, nothing selected — the general `New list`
    // catalogue exactly (§P3-39's identical-entry-point test).
    const choices = listTemplateChoices();
    const rendered = choices.filter((choice) => {
      const label = choice.templateKey === 'blank' ? 'Blank list' : choice.chooserLabel;
      return screen.queryByRole('button', { name: `${label}. ${choice.summary}` });
    });
    expect(rendered.map((choice) => choice.templateKey)).toEqual(
      choices.map((choice) => choice.templateKey),
    );
    for (const choice of choices) {
      const row = choiceControl(choice.templateKey);
      expect(row.getAttribute('aria-selected'), choice.templateKey).toBeNull();
      expect(row.getAttribute('aria-pressed'), choice.templateKey).toBeNull();
    }
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('prefills `<Default title> · <Plan title>`, editable, and writes the source', async () => {
    const { create } = setHook();
    const { onCreated, onClose } = mountSourced();

    choose('checklist');
    expect(titleField().getAttribute('value')).toBe('Checklist · New York Trip');

    fireEvent.change(titleField(), { target: { value: 'Packing · New York Trip' } });
    fireEvent.click(createButton());
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith('checklist', 'Packing · New York Trip', {
      sourceActivityId: PLAN.activityId,
    });
    expect(onCreated).toHaveBeenCalledWith({
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      title: 'Packing · New York Trip',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the source through Back, which still retains no style or title', () => {
    mountSourced();

    choose('groceries');
    fireEvent.change(titleField(), { target: { value: 'Costco run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('new-list-source-context')).toBeDefined();
    choose('groceries');
    expect(titleField().getAttribute('value')).toBe('Groceries · New York Trip');
  });
});

/**
 * The absence acceptance criterion 6 is about. There is no matcher, debounce, term catalogue
 * or model call, so **nothing at all** leaves the device while the user types — including a
 * fetch of `GET /v1/list-templates`, which this sheet never needs because the catalogue ships
 * with the app.
 */
describe('typing a title reaches nothing', () => {
  it('issues no request while the catalogue is shown or the title is edited', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      mount();
      choose('groceries');
      for (const value of ['G', 'Gr', 'Groc', 'Costco', 'Costco run']) {
        fireEvent.change(titleField(), { target: { value } });
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
