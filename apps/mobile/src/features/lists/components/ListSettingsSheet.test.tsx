import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ListSettings } from '../hooks/useListSettings';
import { SLOT_MEANINGS } from '../model/listSettings';
import { ListSettingsSheet } from './ListSettingsSheet';

const list = (overrides: Partial<List> = {}): List => ({
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'blank',
  title: 'Ideas',
  icon: 'list',
  emptyStateCopy: 'Add an item.',
  itemStateMode: { mode: 'none' },
  featureConfig: {},
  slot: null,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-28T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-28T09:00:00.000Z'),
  ...overrides,
});

function settings(subject: List): ListSettings {
  return {
    view: subject,
    rename: vi.fn(),
    setStateMode: vi.fn(),
    setFeatureEnabled: vi.fn(),
    setProgressKind: vi.fn(),
    setSubItemLabels: vi.fn(),
    setSlot: vi.fn(),
    busy: false,
  };
}

function mount(subject = list()) {
  const actions = settings(subject);
  render(
    <ThemeProvider scheme="light">
      <ListSettingsSheet open onClose={vi.fn()} list={subject} settings={actions} />
    </ThemeProvider>,
  );
  return actions;
}

describe('the P3-33 List settings hierarchy', () => {
  it('renders the exact state, detail and subordinate destination sections in order', () => {
    mount();
    const sheet = screen.getByTestId('list-settings');

    expect(sheet.textContent).toContain(
      'Choose how items behave and which optional details are available.',
    );
    expect(sheet.textContent).toContain('Item state');
    expect(sheet.textContent).toContain('None');
    expect(sheet.textContent).toContain('Checkboxes');
    expect(sheet.textContent).toContain('Stages');
    expect(sheet.textContent).toContain('Item details');
    expect(sheet.textContent).toContain('One optional line on each item');
    expect(sheet.textContent).toContain('Place and address on each item');
    expect(sheet.textContent).toContain('Add a short list inside each item');
    expect(sheet.textContent).toContain('Planning');
    expect(sheet.textContent).toContain('Default destination');
    expect(sheet.textContent?.indexOf('Item state')).toBeLessThan(
      sheet.textContent?.indexOf('Item details') ?? 0,
    );
    expect(sheet.textContent?.indexOf('Item details')).toBeLessThan(
      sheet.textContent?.indexOf('Planning') ?? 0,
    );
    expect(sheet.textContent).not.toMatch(/behaviou?r|destructive/i);
    expect(screen.queryByTestId('list-settings-group-by-state')).toBeNull();
  });

  it('uses one shared switch semantic for each feature', () => {
    mount();
    for (const id of ['progress', 'place', 'sub-items']) {
      const control = screen.getByTestId(`list-settings-feature-${id}`);
      expect(control.getAttribute('role')).toBe('switch');
      expect(control.getAttribute('aria-checked')).toBe('false');
    }
  });

  it('selects Stages and shows its group control only in staged mode', () => {
    mount(
      list({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
          groupByState: true,
        },
      }),
    );

    expect(
      screen.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected'),
    ).toBe('true');
    const group = screen.getByTestId('list-settings-group-by-state');
    expect(group.getAttribute('role')).toBe('switch');
    expect(group.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Show a section for each populated stage')).toBeTruthy();
    expect(screen.getByText('Stage labels')).toBeTruthy();
    expect(screen.getByText('Queued · Building · Shipped')).toBeTruthy();
    expect(screen.queryByLabelText('First stage')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: /Stage labels.*Queued.*Building.*Shipped/i }),
    );
    expect(screen.getByRole('dialog', { name: 'Stage labels' })).toBeTruthy();
    expect(screen.getByLabelText('First stage')).toHaveProperty('value', 'Queued');
    expect(screen.getByLabelText('Active stage')).toHaveProperty('value', 'Building');
    expect(screen.getByLabelText('Done stage')).toHaveProperty('value', 'Shipped');
    expect(screen.queryByText('Item details')).toBeNull();
  });

  it('commits edited stage labels through the existing state-mode write', () => {
    const subject = list({
      itemStateMode: {
        mode: 'stages',
        labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
        groupByState: true,
      },
    });
    const actions = mount(subject);

    fireEvent.click(
      screen.getByRole('button', { name: /Stage labels.*Queued.*Building.*Shipped/i }),
    );
    fireEvent.change(screen.getByLabelText('First stage'), {
      target: { value: 'Saved' },
    });
    fireEvent.blur(screen.getByLabelText('First stage'));

    expect(actions.setStateMode).toHaveBeenCalledWith({
      ...subject.itemStateMode,
      labels: { open: 'Saved', active: 'Building', done: 'Shipped' },
    });
  });

  it('collapses Planning to one destination row and edits it in a focused sheet', () => {
    const actions = mount(list({ slot: 'groceries' }));

    expect(
      screen.getByRole('button', { name: /Default destination.*Groceries/i }),
    ).toBeTruthy();
    expect(screen.queryByText(SLOT_MEANINGS.groceries)).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: /Default destination.*Groceries/i }),
    );
    expect(screen.getByRole('dialog', { name: 'Default destination' })).toBeTruthy();
    expect(screen.getByText(SLOT_MEANINGS.groceries)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Watch Later/i }));
    expect(actions.setSlot).toHaveBeenCalledWith('watch');
  });

  it('opens focused naming configuration the first time Sub-items is enabled', () => {
    const actions = mount();

    fireEvent.click(screen.getByTestId('list-settings-feature-sub-items'));

    expect(actions.setFeatureEnabled).toHaveBeenCalledWith('subItems', true);
    expect(screen.getByRole('dialog', { name: 'Sub-item settings' })).toBeTruthy();
    expect(screen.getByText('Section label')).toBeTruthy();
    expect(screen.getByText('Singular label')).toBeTruthy();
    expect(screen.getByText('Secondary field label')).toBeTruthy();
  });

  it('collapses configured naming to vocabulary plus an explicit Edit action', () => {
    mount(
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
            secondaryLabel: 'Quantity',
            integration: 'mealIngredients',
          },
        },
      }),
    );

    expect(screen.getByText('Ingredients · Quantity')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.queryByText('Section label')).toBeNull();
  });

  it('replaces settings with the focused naming editor when Edit is pressed', () => {
    mount(
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
            integration: 'mealIngredients',
          },
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Ingredients.*Edit/i }));

    expect(screen.getByRole('dialog', { name: 'Sub-item settings' })).toBeTruthy();
    expect(screen.getByText('Section label')).toBeTruthy();
    expect(
      screen.getByText(
        'Used as ingredients when creating Meal plans. Labels alone never activate this integration.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Preview')).toBeTruthy();
    expect(screen.getByTestId('sub-item-settings-preview').textContent).toContain(
      'Ingredients',
    );
    expect(screen.getByRole('button', { name: 'Save naming' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText('Item state')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('labels ordinary configuration as generic Sub-items rather than Meal integration', () => {
    mount(
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Steps',
            singularLabel: 'Step',
          },
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Steps.*Edit/ }));

    expect(screen.getByText(/Generic Sub-items/)).toBeTruthy();
    expect(screen.queryByText(/Meal integration/)).toBeNull();
  });
});

/**
 * P3-51 review: ✕ in a sub-editor means "back to the main editor", and the primitive must
 * ask the owner rather than leave on its own — the owner here declines, keeps `open`, and
 * the sheet stays exactly where the user can see it.
 */
it('returns from a sub-editor on Close without leaving, and never tells the owner', () => {
  const subject = list({
    featureConfig: {
      subItems: {
        enabled: true,
        sectionLabel: 'Ingredients',
        singularLabel: 'Ingredient',
        integration: 'mealIngredients',
      },
    },
  });
  const onClose = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <ListSettingsSheet
        open
        onClose={onClose}
        list={subject}
        settings={settings(subject)}
      />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ingredients.*Edit/i }));
  expect(screen.getByRole('dialog', { name: 'Sub-item settings' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'List settings' })).toBeTruthy();
  expect(screen.getByText('Item state')).toBeTruthy();
});
