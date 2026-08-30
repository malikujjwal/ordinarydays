import { listTemplateChoices } from '@od/shared/lists';
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

const choose = (templateKey: string) =>
  fireEvent.click(screen.getByTestId(`list-style-${templateKey}`));

const titleField = () => screen.getByTestId('new-list-title');
const createButton = () => screen.getByTestId('new-list-create');

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
    expect(screen.queryByTestId('new-list-title')).toBeNull();
    expect(screen.queryByTestId('new-list-create')).toBeNull();
    expect(screen.queryByTestId('new-list-back')).toBeNull();
  });

  it('renders every style exactly once, in the catalogue order', () => {
    mount();
    const choices = listTemplateChoices();

    const rendered = choices.filter((choice) =>
      screen.queryByTestId(`list-style-${choice.templateKey}`),
    );
    expect(rendered.map((choice) => choice.templateKey)).toEqual(
      choices.map((choice) => choice.templateKey),
    );
    expect(screen.getByTestId('list-style-blank')).toBeDefined();
  });

  it('leads with one full-width Blank list card above the six-card grid', () => {
    mount();
    expect(screen.getByTestId('list-style-blank').textContent).toContain('Blank list');
    expect(
      screen
        .getByTestId('list-style-leading')
        .contains(screen.getByTestId('list-style-blank')),
    ).toBe(true);
    expect(screen.getByTestId('list-style-grid').children).toHaveLength(6);
  });

  /** §5.4 rule 6, exactly: `<style>. <description>`. */
  it('announces each row as its style and its description', () => {
    mount();

    expect(screen.getByTestId('list-style-blank').getAttribute('aria-label')).toBe(
      'Blank list. Start without a category or item details',
    );
    expect(screen.getByTestId('list-style-groceries').getAttribute('aria-label')).toBe(
      'Groceries. A shopping checklist',
    );
  });

  /** A chooser row navigates; it is neither selected nor unselected, and says neither. */
  it('reports no selection state on any row', () => {
    mount();

    for (const choice of listTemplateChoices()) {
      const row = screen.getByTestId(`list-style-${choice.templateKey}`);
      expect(row.getAttribute('aria-selected'), choice.templateKey).toBeNull();
      expect(row.getAttribute('aria-pressed'), choice.templateKey).toBeNull();
      expect(row.getAttribute('aria-checked'), choice.templateKey).toBeNull();
    }
  });
});

describe('the title step', () => {
  it('shows the chosen style, its exact summary and its editable default title', () => {
    mount();

    choose('watch-later');

    expect(screen.getByRole('heading', { name: 'Watch Later' })).toBeDefined();
    expect(screen.getByTestId('new-list-style-summary').textContent).toBe(
      'Track what to watch and episode progress',
    );
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
    fireEvent.click(screen.getByTestId('new-list-back'));

    expect(screen.getByTestId('list-style-chooser')).toBeDefined();
    expect(screen.queryByTestId('new-list-title')).toBeNull();

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

    expect(screen.getByTestId('new-list-error').textContent).toContain(
      'Something went wrong.',
    );
    expect(titleField()).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
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
