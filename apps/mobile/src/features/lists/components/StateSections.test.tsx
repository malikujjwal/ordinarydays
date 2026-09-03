import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  StateSections,
  stateGroupDropIndex,
  stateGroupReorderRange,
} from './StateSections';

const list = {
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Saved', active: 'Reading', done: 'Read' },
    groupByState: true,
  },
  featureConfig: {},
} as List & { itemStateMode: Extract<List['itemStateMode'], { mode: 'stages' }> };

const item = (id: string, state: ListItemView['state']): ListItemView => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  itemId: `itm_01J8XKQ2M4N5P6R7S8T9V0W${id}`,
  rank: `a${id}`,
  title: id,
  state,
});

describe('StateSections', () => {
  it('keeps each stage drag in section-local index space and translates the drop once', () => {
    const rows = [
      item('1X1', 'open'),
      item('1X2', 'active'),
      item('1X3', 'active'),
      item('1X4', 'done'),
    ];

    expect(stateGroupReorderRange(rows, rows[2]?.itemId ?? '')).toEqual({
      first: 0,
      last: 1,
    });
    expect(stateGroupDropIndex(rows, rows[2]?.itemId ?? '', 0)).toBe(1);
  });

  it('shows counted stage tabs and one clean active-stage list by default', () => {
    render(
      <ThemeProvider scheme="light">
        <StateSections
          list={list}
          items={[item('1X5', 'active'), item('1X3', 'open'), item('1X6', 'done')]}
          onOpen={vi.fn()}
          onDrop={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('tab', { name: 'All, 3' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Saved, 1' })).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'Reading, 1' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      getComputedStyle(screen.getByRole('tab', { name: 'Reading, 1' })).paddingLeft,
    ).toBe('8px');
    expect(screen.getByRole('tab', { name: 'Read, 1' })).toBeTruthy();
    expect(screen.getByText('1X5')).toBeTruthy();
    expect(screen.queryByText('1X3')).toBeNull();
    expect(screen.queryByTestId(/stage-heading-/)).toBeNull();
    expect(
      screen.getByTestId('list-item-itm_01J8XKQ2M4N5P6R7S8T9V0W1X5-leading-marker'),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('list-item-itm_01J8XKQ2M4N5P6R7S8T9V0W1X5-state'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'All, 3' }));
    expect(screen.getByText('1X3')).toBeTruthy();
    expect(screen.getByText('1X5')).toBeTruthy();
    expect(screen.getByText('1X6')).toBeTruthy();
  });
});
