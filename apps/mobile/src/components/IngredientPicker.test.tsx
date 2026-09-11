import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IngredientPicker, type IngredientRow } from './IngredientPicker';

/** The ingredient rows and the named action (P3-43, `plans-and-lists.md` §5.8, §7.3). */

const ROWS: readonly IngredientRow[] = [
  { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
  { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2', name: 'Tortillas', quantity: '8' },
  { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3', name: 'Tomatoes' },
  {
    ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A4',
    name: 'Sour cream',
    addedToListId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1L1',
  },
];

function mount(props: Partial<Parameters<typeof IngredientPicker>[0]> = {}) {
  const onToggle = vi.fn();
  const onAdd = vi.fn();
  const onChangeDestination = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <IngredientPicker
        rows={ROWS}
        selected={new Set()}
        onToggle={onToggle}
        destinationTitle="Groceries"
        onChangeDestination={onChangeDestination}
        onAdd={onAdd}
        {...props}
      />
    </ThemeProvider>,
  );
  return { onToggle, onAdd, onChangeDestination };
}

describe('IngredientPicker', () => {
  /** Rule 5: the eventual write contains only what the user explicitly selected. */
  it('starts every ingredient unchecked', () => {
    mount();
    for (const name of ['Chicken', 'Tortillas (8)', 'Tomatoes']) {
      expect(screen.getByRole('checkbox', { name }).getAttribute('aria-checked')).toBe(
        'false',
      );
    }
  });

  it('names the count and the destination on the action, disabled until something is selected', () => {
    mount();
    const action = screen.getByRole('button', { name: 'Add 0 to Groceries' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
  });

  it('counts the selection and hands the stable ids to the action', () => {
    const { onAdd } = mount({
      selected: new Set([
        'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1',
        'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
      ]),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to Groceries' }));
    expect(onAdd).toHaveBeenCalledWith([
      'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1',
      'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
    ]);
  });

  /** An added row cannot be added twice from the same meal (§7.3 step 5). */
  it('shows Added rows without a checkbox and never counts them', () => {
    mount({ selected: new Set(['ing_01J8XKQ2M4N5P6R7S8T9V0W1A4']) });
    expect(screen.queryByRole('checkbox', { name: 'Sour cream' })).toBeNull();
    expect(screen.getByText('Added')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add 0 to Groceries' })).toBeDefined();
  });

  /** The destination is visible before the write, and changeable (§5.8). */
  it('shows the destination and opens the picker from it', () => {
    const { onChangeDestination } = mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Add ingredients to: Groceries. Change' }),
    );
    expect(onChangeDestination).toHaveBeenCalledOnce();
  });

  it('reads Choose or create a list, and keeps the action pending, with no destination', () => {
    mount({
      destinationTitle: undefined,
      selected: new Set(['ing_01J8XKQ2M4N5P6R7S8T9V0W1A1']),
    });
    expect(screen.getByRole('button', { name: 'Choose or create a list' })).toBeDefined();
    const action = screen.getByRole('button', { name: 'Add 1 selected' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
  });

  /** Activity detail's layout (2026-09-10): the action appears only once a row is selected. */
  it('in the footer layout, hides the add action until a row is selected', () => {
    mount({ layout: 'footer' });
    expect(screen.queryByRole('button', { name: /^Add \d/ })).toBeNull();
    expect(screen.queryByText('Add ingredients to:')).toBeNull();
    expect(screen.getByTestId('ingredient-picker-destination-name').textContent).toBe(
      'To Groceries',
    );
    expect(screen.getByText('Added')).toBeDefined();
  });

  it('in the footer layout, names the count and list beside the destination', () => {
    const { onAdd, onChangeDestination } = mount({
      layout: 'footer',
      selected: new Set(['ing_01J8XKQ2M4N5P6R7S8T9V0W1A1']),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to Groceries' }));
    expect(onAdd).toHaveBeenCalledWith(['ing_01J8XKQ2M4N5P6R7S8T9V0W1A1']);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add ingredients to: Groceries. Change' }),
    );
    expect(onChangeDestination).toHaveBeenCalledOnce();
  });

  it('reports toggles by stable id', () => {
    const { onToggle } = mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tomatoes' }));
    expect(onToggle).toHaveBeenCalledWith('ing_01J8XKQ2M4N5P6R7S8T9V0W1A3', true);
  });
});
